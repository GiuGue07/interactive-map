const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { MongoClient } = require("mongodb"); // Importiamo il driver MongoDB

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const ALLOWED_POINT_COLORS = new Set(["#2e9d57", "#2878d8", "#7b3fb8", "#d8a021", "#c43b3b"]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

// --- CONFIGURAZIONE MONGODB ---
const MONGO_URI = process.env.MONGO_URI; 
if (!MONGO_URI) {
  console.error("ERRORE: La variabile d'ambiente MONGO_URI non è configurata!");
  process.exit(1);
}

const client = new MongoClient(MONGO_URI);
let db;

// Funzione per inizializzare il Database e l'admin se non esistono
async function initDb() {
  try {
    await client.connect();
    db = client.db("interactive-map"); // Nome del database su Atlas
    console.log("Connesso con successo a MongoDB Atlas!");

    // Controlla se esiste l'utente admin, altrimenti lo crea
    const adminExists = await db.collection("users").findOne({ username: "admin" });
    if (!adminExists) {
      const adminPassword = hashPassword("admin123");
      await db.collection("users").insertOne({
        id: crypto.randomUUID(),
        username: "admin",
        passwordHash: adminPassword,
        role: "admin",
        status: "approved",
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
        lastIp: null
      });
      console.log("Utente Admin iniziale creato su MongoDB.");
    }

    // Controlla se ci sono punti demo, altrimenti ne mette uno
    const pointsCount = await db.collection("points").countDocuments();
    if (pointsCount === 0) {
      await db.collection("points").insertOne({
        id: crypto.randomUUID(),
        name: "Valentine",
        description: "Punto demo sulla mappa personalizzata.",
        lat: 1150,
        lng: 2700,
        color: "#2878d8",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
  } catch (err) {
    console.error("Errore critico durante l'inizializzazione di MongoDB:", err);
    process.exit(1);
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), candidate);
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress?.replace(/^::ffff:/, "") || "sconosciuto";
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const index = cookie.indexOf("=");
        return [decodeURIComponent(cookie.slice(0, index)), decodeURIComponent(cookie.slice(index + 1))];
      })
  );
}

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `map_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "map_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

async function getCurrentUser(req) {
  const token = parseCookies(req).map_session;
  if (!token) return null;
  
  const session = await db.collection("sessions").findOne({ token });
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    await db.collection("sessions").deleteOne({ token });
    return null;
  }
  return await db.collection("users").findOne({ id: session.userId }) || null;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function error(res, status, message) {
  json(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Body troppo grande"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("JSON non valido"));
      }
    });
    req.on("error", reject);
  });
}

async function pruneExpiredSessions() {
  const now = Date.now();
  await db.collection("sessions").deleteMany({ expiresAt: { $lt: now } });
}

async function isUserOnline(userId) {
  const now = Date.now();
  const activeSession = await db.collection("sessions").findOne({ userId, expiresAt: { $gte: now } });
  return !!activeSession;
}

async function publicUser(user) {
  const online = await isUserOnline(user.id);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    lastIp: user.lastIp,
    online: online
  };
}

async function requireAuth(req, res) {
  const user = await getCurrentUser(req);
  if (!user) {
    error(res, 401, "Accesso richiesto");
    return null;
  }
  if (user.status !== "approved") {
    error(res, 403, "Account in attesa di approvazione");
    return null;
  }
  return user;
}

async function requireAdmin(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    error(res, 403, "Solo l'amministratore puo eseguire questa operazione");
    return null;
  }
  return user;
}

function serveStatic(req, res, pathname) {
  const filePath = pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, pathname);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(resolved)] || "application/octet-stream" });
    res.end(data);
  });
}

async function handleApi(req, res, pathname) {
  await pruneExpiredSessions();

  if (req.method === "GET" && pathname === "/api/me") {
    const user = await getCurrentUser(req);
    json(res, 200, { user: user ? await publicUser(user) : null });
    return;
  }

  if (req.method === "POST" && pathname === "/api/register") {
    const body = await readBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!/^[a-z0-9._-]{3,24}$/.test(username)) return error(res, 400, "Username non valido");
    if (password.length < 6) return error(res, 400, "Password troppo corta");
    
    const userExists = await db.collection("users").findOne({ username });
    if (userExists) return error(res, 409, "Username gia registrato");
    
    const user = {
      id: crypto.randomUUID(),
      username,
      passwordHash: hashPassword(password),
      role: "user",
      status: "pending",
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
      lastIp: getClientIp(req)
    };
    await db.collection("users").insertOne(user);
    json(res, 201, { message: "Registrazione inviata. Attendi approvazione admin.", user: await publicUser(user) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/login") {
    const body = await readBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    
    const user = await db.collection("users").findOne({ username });
    if (!user || !verifyPassword(password, user.passwordHash)) return error(res, 401, "Credenziali non valide");
    
    const lastIp = getClientIp(req);
    const lastLoginAt = new Date().toISOString();
    await db.collection("users").updateOne({ id: user.id }, { $set: { lastIp, lastLoginAt } });
    
    if (user.status !== "approved") {
      return error(res, 403, "Account in attesa di approvazione admin");
    }
    
    const token = crypto.randomBytes(32).toString("hex");
    await db.collection("sessions").insertOne({ token, userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
    
    setSessionCookie(res, token);
    json(res, 200, { user: await publicUser({ ...user, lastIp, lastLoginAt }) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    const token = parseCookies(req).map_session;
    if (token) await db.collection("sessions").deleteOne({ token });
    clearSessionCookie(res);
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/points") {
    if (!await requireAuth(req, res)) return;
    const points = await db.collection("points").find({}, { projection: { _id: 0 } }).toArray();
    json(res, 200, { points });
    return;
  }

  if (req.method === "POST" && pathname === "/api/points") {
    if (!await requireAdmin(req, res)) return;
    const body = await readBody(req);
    const point = validatePoint(body);
    if (point.error) return error(res, 400, point.error);
    const now = new Date().toISOString();
    const created = { id: crypto.randomUUID(), ...point.value, createdAt: now, updatedAt: now };
    
    await db.collection("points").insertOne(created);
    const responsePoint = { ...created };
    delete responsePoint._id; // Rimuoviamo l'id interno di Mongo per il frontend
    
    json(res, 201, { point: responsePoint });
    return;
  }

  const pointMatch = pathname.match(/^\/api\/points\/([^/]+)$/);
  if (pointMatch && req.method === "PUT") {
    if (!await requireAdmin(req, res)) return;
    const pointId = pointMatch[1];
    
    const currentPoint = await db.collection("points").findOne({ id: pointId });
    if (!currentPoint) return error(res, 404, "Punto non trovato");
    
    const body = await readBody(req);
    const point = validatePoint(body);
    if (point.error) return error(res, 400, point.error);
    
    const updatedAt = new Date().toISOString();
    await db.collection("points").updateOne({ id: pointId }, { $set: { ...point.value, updatedAt } });
    
    const updatedPoint = await db.collection("points").findOne({ id: pointId }, { projection: { _id: 0 } });
    json(res, 200, { point: updatedPoint });
    return;
  }

  if (pointMatch && req.method === "DELETE") {
    if (!await requireAdmin(req, res)) return;
    await db.collection("points").deleteOne({ id: pointMatch[1] });
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/users") {
    if (!await requireAdmin(req, res)) return;
    const users = await db.collection("users").find().toArray();
    const publicUsersList = await Promise.all(users.map((user) => publicUser(user)));
    json(res, 200, { users: publicUsersList });
    return;
  }

  const userMatch = pathname.match(/^\/api\/users\/([^/]+)\/(approve|reject)$/);
  if (userMatch && req.method === "POST") {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const userId = userMatch[1];
    
    const user = await db.collection("users").findOne({ id: userId });
    if (!user) return error(res, 404, "Utente non trovato");
    if (user.role === "admin") return error(res, 400, "L'admin principale non puo essere modificato qui");
    
    const status = userMatch[2] === "approve" ? "approved" : "rejected";
    await db.collection("users").updateOne({ id: userId }, { $set: { status } });
    
    const updatedUser = await db.collection("users").findOne({ id: userId });
    json(res, 200, { user: await publicUser(updatedUser) });
    return;
  }

  error(res, 404, "API non trovata");
}

function validatePoint(body) {
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const color = String(body.color || "#2e9d57").trim().toLowerCase();
  if (name.length < 2 || name.length > 80) return { error: "Nome punto non valido" };
  if (!Number.isFinite(lat) || lat < 0 || lat > 3340) return { error: "Coordinata Y non valida" };
  if (!Number.isFinite(lng) || lng < 0 || lng > 4505) return { error: "Coordinata X non valida" };
  if (!ALLOWED_POINT_COLORS.has(color)) return { error: "Colore rarita non valido" };
  return { value: { name, description, lat, lng, color } };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (err) {
    error(res, 500, err.message || "Errore server");
  }
});

// Inizializziamo il database prima di far partire il server HTTP
initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Mappa interattiva pronta: http://localhost:${PORT}`);
    console.log("Admin iniziale: username admin / password admin123");
  });
});
