const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
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

function ensureDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const adminPassword = hashPassword("admin123");
    writeDb({
      users: [
        {
          id: crypto.randomUUID(),
          username: "admin",
          passwordHash: adminPassword,
          role: "admin",
          status: "approved",
          createdAt: new Date().toISOString(),
          lastLoginAt: null,
          lastIp: null
        }
      ],
      points: [
        {
          id: crypto.randomUUID(),
          name: "Valentine",
          description: "Punto demo sulla mappa personalizzata.",
          lat: 1150,
          lng: 2700,
          color: "#2878d8",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      sessions: {}
    });
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
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

function getCurrentUser(req, db) {
  const token = parseCookies(req).map_session;
  if (!token || !db.sessions[token]) return null;
  const session = db.sessions[token];
  if (Date.now() > session.expiresAt) {
    delete db.sessions[token];
    writeDb(db);
    return null;
  }
  return db.users.find((user) => user.id === session.userId) || null;
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

function pruneExpiredSessions(db) {
  const now = Date.now();
  let changed = false;
  for (const [token, session] of Object.entries(db.sessions || {})) {
    if (!session || now > session.expiresAt) {
      delete db.sessions[token];
      changed = true;
    }
  }
  if (changed) writeDb(db);
}

function isUserOnline(db, userId) {
  const now = Date.now();
  return Object.values(db.sessions || {}).some((session) => session.userId === userId && now <= session.expiresAt);
}

function publicUser(user, db = null) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    lastIp: user.lastIp,
    online: db ? isUserOnline(db, user.id) : false
  };
}

function requireAuth(req, res, db) {
  const user = getCurrentUser(req, db);
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

function requireAdmin(req, res, db) {
  const user = requireAuth(req, res, db);
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
  const db = readDb();
  pruneExpiredSessions(db);

  if (req.method === "GET" && pathname === "/api/me") {
    const user = getCurrentUser(req, db);
    json(res, 200, { user: user ? publicUser(user, db) : null });
    return;
  }

  if (req.method === "POST" && pathname === "/api/register") {
    const body = await readBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!/^[a-z0-9._-]{3,24}$/.test(username)) return error(res, 400, "Username non valido");
    if (password.length < 6) return error(res, 400, "Password troppo corta");
    if (db.users.some((user) => user.username === username)) return error(res, 409, "Username gia registrato");
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
    db.users.push(user);
    writeDb(db);
    json(res, 201, { message: "Registrazione inviata. Attendi approvazione admin.", user: publicUser(user, db) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/login") {
    const body = await readBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = db.users.find((item) => item.username === username);
    if (!user || !verifyPassword(password, user.passwordHash)) return error(res, 401, "Credenziali non valide");
    user.lastIp = getClientIp(req);
    user.lastLoginAt = new Date().toISOString();
    if (user.status !== "approved") {
      writeDb(db);
      return error(res, 403, "Account in attesa di approvazione admin");
    }
    const token = crypto.randomBytes(32).toString("hex");
    db.sessions[token] = { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS };
    writeDb(db);
    setSessionCookie(res, token);
    json(res, 200, { user: publicUser(user, db) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    const token = parseCookies(req).map_session;
    if (token) delete db.sessions[token];
    writeDb(db);
    clearSessionCookie(res);
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/points") {
    if (!requireAuth(req, res, db)) return;
    json(res, 200, { points: db.points });
    return;
  }

  if (req.method === "POST" && pathname === "/api/points") {
    if (!requireAdmin(req, res, db)) return;
    const body = await readBody(req);
    const point = validatePoint(body);
    if (point.error) return error(res, 400, point.error);
    const now = new Date().toISOString();
    const created = { id: crypto.randomUUID(), ...point.value, createdAt: now, updatedAt: now };
    db.points.push(created);
    writeDb(db);
    json(res, 201, { point: created });
    return;
  }

  const pointMatch = pathname.match(/^\/api\/points\/([^/]+)$/);
  if (pointMatch && req.method === "PUT") {
    if (!requireAdmin(req, res, db)) return;
    const index = db.points.findIndex((point) => point.id === pointMatch[1]);
    if (index === -1) return error(res, 404, "Punto non trovato");
    const body = await readBody(req);
    const point = validatePoint(body);
    if (point.error) return error(res, 400, point.error);
    db.points[index] = { ...db.points[index], ...point.value, updatedAt: new Date().toISOString() };
    writeDb(db);
    json(res, 200, { point: db.points[index] });
    return;
  }

  if (pointMatch && req.method === "DELETE") {
    if (!requireAdmin(req, res, db)) return;
    db.points = db.points.filter((point) => point.id !== pointMatch[1]);
    writeDb(db);
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/users") {
    if (!requireAdmin(req, res, db)) return;
    json(res, 200, { users: db.users.map((user) => publicUser(user, db)) });
    return;
  }

  const userMatch = pathname.match(/^\/api\/users\/([^/]+)\/(approve|reject)$/);
  if (userMatch && req.method === "POST") {
    const admin = requireAdmin(req, res, db);
    if (!admin) return;
    const user = db.users.find((item) => item.id === userMatch[1]);
    if (!user) return error(res, 404, "Utente non trovato");
    if (user.role === "admin") return error(res, 400, "L'admin principale non puo essere modificato qui");
    user.status = userMatch[2] === "approve" ? "approved" : "rejected";
    writeDb(db);
    json(res, 200, { user: publicUser(user, db) });
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

ensureDb();
server.listen(PORT, () => {
  console.log(`Mappa interattiva pronta: http://localhost:${PORT}`);
  console.log("Admin iniziale: username admin / password admin123");
});
