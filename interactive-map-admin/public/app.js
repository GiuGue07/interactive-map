let currentUser = null;
let map = null;
let markers = new Map();
let points = [];
const imageSize = { width: 4505, height: 3340 };
const imageBounds = [[0, 0], [imageSize.height, imageSize.width]];
const rarityOptions = {
  "#2e9d57": "Comune",
  "#2878d8": "Raro",
  "#7b3fb8": "Epico",
  "#d8a021": "Leggendario",
  "#c43b3b": "Unico"
};

const authView = document.querySelector("#authView");
const mapView = document.querySelector("#mapView");
const loginTab = document.querySelector("#loginTab");
const registerTab = document.querySelector("#registerTab");
const loginForm = document.querySelector("#loginForm");
const registerForm = document.querySelector("#registerForm");
const authMessage = document.querySelector("#authMessage");
const welcomeTitle = document.querySelector("#welcomeTitle");
const logoutBtn = document.querySelector("#logoutBtn");
const pointForm = document.querySelector("#pointForm");
const resetPointBtn = document.querySelector("#resetPointBtn");
const pointsList = document.querySelector("#pointsList");
const pointNameFilter = document.querySelector("#pointNameFilter");
const pointRarityFilter = document.querySelector("#pointRarityFilter");
const usersList = document.querySelector("#usersList");

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin",
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Errore richiesta");
  return data;
}

function setMessage(text, isError = false) {
  authMessage.textContent = text;
  authMessage.style.color = isError ? "#b93232" : "#65706a";
}

function showAuth() {
  authView.classList.remove("hidden");
  mapView.classList.add("hidden");
}

async function showApp(user) {
  currentUser = user;
  authView.classList.add("hidden");
  mapView.classList.remove("hidden");
  welcomeTitle.textContent = user.role === "admin" ? "Pannello admin" : "Mappa";
  document.querySelectorAll(".admin-only").forEach((item) => item.classList.toggle("hidden", user.role !== "admin"));
  initMap();
  setTimeout(() => {
    map?.invalidateSize();
    focusPointsOnMap();
  }, 100);
  await loadPoints();
  if (user.role === "admin") await loadUsers();
}

function initMap() {
  if (map) {
    setTimeout(() => map.invalidateSize(), 50);
    return;
  }
  map = L.map("map", {
    crs: L.CRS.Simple,
    minZoom: -2,
    maxZoom: 4,
    zoomSnap: 0.25,
    wheelPxPerZoomLevel: 90,
    maxBounds: imageBounds,
    maxBoundsViscosity: 0.75,
    zoomControl: true,
    zoomAnimation: false,
    fadeAnimation: false,
    markerZoomAnimation: false
  });
  L.imageOverlay("/assets/rdr2-map.jpg", imageBounds).addTo(map);
  map.fitBounds(imageBounds);
  map.on("click", (event) => {
    if (currentUser?.role !== "admin") return;
    pointForm.elements.lat.value = clamp(imageSize.height - event.latlng.lat, 0, imageSize.height).toFixed(0);
    pointForm.elements.lng.value = clamp(event.latlng.lng, 0, imageSize.width).toFixed(0);
    pointForm.elements.name.focus();
  });
}

async function loadPoints() {
  const data = await api("/api/points");
  points = data.points;
  renderPoints();
  renderMarkers();
  focusPointsOnMap();
}

function renderMarkers() {
  markers.forEach((marker) => marker.remove());
  markers.clear();
  getFilteredPoints().forEach((point) => {
    const color = normalizePointColor(point.color);
    const marker = L.marker(pointToLatLng(point), {
      icon: L.divIcon({
        className: "horse-marker-wrap",
        iconSize: [20, 20],
        iconAnchor: [10, 10],
        popupAnchor: [0, -12],
        html: `
          <span class="horse-map-marker" style="--marker-color:${color}" title="${escapeHtml(point.name)}"></span>
        `
      })
    })
      .addTo(map)
      .bindPopup(`
        <div class="popup-title">
          <span class="swatch" style="background:${color}"></span>
          <span>${escapeHtml(point.name)}</span>
        </div>
        <div class="popup-row"><strong>Rarita:</strong> ${escapeHtml(rarityOptions[color])}</div>
        <div class="popup-row"><strong>Info:</strong> ${escapeHtml(point.description || "Nessuna descrizione")}</div>
        <div class="popup-row"><strong>Coordinate:</strong> X ${point.lng.toFixed(0)}, Y ${point.lat.toFixed(0)}</div>
      `, {
        closeButton: true,
        autoPan: true,
        autoPanPadding: [28, 28]
      });
    marker.on("click", () => marker.openPopup());
    markers.set(point.id, marker);
  });
}

function focusPointsOnMap() {
  const visiblePoints = getFilteredPoints();
  if (!map || !visiblePoints.length) {
    map?.fitBounds(imageBounds);
    return;
  }
  if (visiblePoints.length === 1) {
    map.setView(pointToLatLng(visiblePoints[0]), 0.5);
    return;
  }
  const bounds = visiblePoints.map(pointToLatLng);
  map.fitBounds(bounds, { padding: [70, 70], maxZoom: 0.75 });
}

function renderPoints() {
  pointsList.innerHTML = "";
  const visiblePoints = getFilteredPoints();
  if (!points.length) {
    pointsList.innerHTML = '<p class="empty">Nessun punto presente.</p>';
    return;
  }
  if (!visiblePoints.length) {
    pointsList.innerHTML = '<p class="empty">Nessun punto corrisponde ai filtri.</p>';
    return;
  }
  visiblePoints.forEach((point) => {
    const item = document.createElement("article");
    item.className = "item";
    const color = normalizePointColor(point.color);
    item.innerHTML = `
      <div class="item-title">
        <span class="point-heading">
          <span class="swatch" style="background:${color}"></span>
          <span>${escapeHtml(point.name)}</span>
        </span>
        <span class="rarity">${escapeHtml(rarityOptions[color])}</span>
      </div>
      <p>${escapeHtml(point.description || "Nessuna descrizione")}</p>
      <p>X ${point.lng.toFixed(0)}, Y ${point.lat.toFixed(0)}</p>
      <div class="item-actions">
        <button type="button" data-action="zoom" data-id="${point.id}">Apri</button>
        ${currentUser?.role === "admin" ? `
          <button type="button" data-action="edit" data-id="${point.id}">Modifica</button>
          <button type="button" class="danger" data-action="delete" data-id="${point.id}">Elimina</button>
        ` : ""}
      </div>
    `;
    pointsList.append(item);
  });
}

function getFilteredPoints() {
  const nameQuery = (pointNameFilter?.value || "").trim().toLowerCase();
  const rarity = normalizePointColor(pointRarityFilter?.value || "");
  const useRarity = Boolean(pointRarityFilter?.value);
  return points.filter((point) => {
    const pointName = String(point.name || "").toLowerCase();
    const matchesName = !nameQuery || pointName.includes(nameQuery);
    const matchesRarity = !useRarity || normalizePointColor(point.color) === rarity;
    return matchesName && matchesRarity;
  });
}

function applyPointFilters() {
  renderPoints();
  renderMarkers();
  focusPointsOnMap();
}

async function loadUsers() {
  const data = await api("/api/users");
  usersList.innerHTML = "";
  data.users
    .forEach((user) => {
      const item = document.createElement("article");
      item.className = "item";
      item.innerHTML = `
        <div class="item-title">
          <span>${escapeHtml(user.username)}</span>
          <span class="status ${user.online ? "online" : "offline"}">${user.online ? "online" : "offline"}</span>
        </div>
        <p>Ruolo: ${escapeHtml(user.role)}</p>
        <p>Accesso: ${escapeHtml(formatUserStatus(user.status))}</p>
        <p>IP: ${escapeHtml(user.lastIp || "non disponibile")}</p>
        <p>Registrato: ${formatDate(user.createdAt)}</p>
        <p>Ultimo login: ${formatDate(user.lastLoginAt)}</p>
        ${user.role !== "admin" ? `
          <div class="item-actions">
            <button type="button" data-user-action="approve" data-id="${user.id}">Accetta</button>
            <button type="button" class="danger" data-user-action="reject" data-id="${user.id}">Rifiuta</button>
          </div>
        ` : ""}
      `;
      usersList.append(item);
    });
  if (!usersList.children.length) usersList.innerHTML = '<p class="empty">Nessun utente registrato.</p>';
}

function fillPointForm(point) {
  pointForm.elements.id.value = point?.id || "";
  pointForm.elements.name.value = point?.name || "";
  pointForm.elements.description.value = point?.description || "";
  pointForm.elements.color.value = normalizePointColor(point?.color);
  pointForm.elements.lat.value = point?.lat ?? "";
  pointForm.elements.lng.value = point?.lng ?? "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "mai";
  return new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function formatUserStatus(status) {
  return {
    approved: "approvato",
    pending: "in attesa",
    rejected: "rifiutato"
  }[status] || status;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizePointColor(color) {
  const normalized = String(color || "").trim().toLowerCase();
  return rarityOptions[normalized] ? normalized : "#2e9d57";
}

function pointToLatLng(point) {
  return [imageSize.height - Number(point.lat), Number(point.lng)];
}

loginTab.addEventListener("click", () => {
  loginTab.classList.add("active");
  registerTab.classList.remove("active");
  loginForm.classList.remove("hidden");
  registerForm.classList.add("hidden");
  setMessage("");
});

registerTab.addEventListener("click", () => {
  registerTab.classList.add("active");
  loginTab.classList.remove("active");
  registerForm.classList.remove("hidden");
  loginForm.classList.add("hidden");
  setMessage("");
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(loginForm));
  try {
    const data = await api("/api/login", { method: "POST", body: JSON.stringify(body) });
    await showApp(data.user);
  } catch (err) {
    setMessage(err.message, true);
  }
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(registerForm));
  try {
    const data = await api("/api/register", { method: "POST", body: JSON.stringify(body) });
    registerForm.reset();
    setMessage(data.message);
  } catch (err) {
    setMessage(err.message, true);
  }
});

logoutBtn.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  currentUser = null;
  showAuth();
});

pointForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(pointForm));
  const id = values.id;
  const body = {
    name: values.name,
    description: values.description,
    color: values.color,
    lat: Number(values.lat),
    lng: Number(values.lng)
  };
  const path = id ? `/api/points/${id}` : "/api/points";
  const method = id ? "PUT" : "POST";
  await api(path, { method, body: JSON.stringify(body) });
  fillPointForm(null);
  await loadPoints();
});

resetPointBtn.addEventListener("click", () => fillPointForm(null));

pointNameFilter.addEventListener("input", applyPointFilters);
pointRarityFilter.addEventListener("change", applyPointFilters);

pointsList.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const point = points.find((item) => item.id === button.dataset.id);
  if (!point) return;
  if (button.dataset.action === "zoom") {
    map.setView(pointToLatLng(point), 2);
    markers.get(point.id)?.openPopup();
  }
  if (button.dataset.action === "edit") fillPointForm(point);
  if (button.dataset.action === "delete") {
    const ok = confirm(`Eliminare "${point.name}"?`);
    if (!ok) return;
    await api(`/api/points/${point.id}`, { method: "DELETE" });
    await loadPoints();
  }
});

usersList.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  await api(`/api/users/${button.dataset.id}/${button.dataset.userAction}`, { method: "POST", body: "{}" });
  await loadUsers();
});

(async function boot() {
  try {
    const data = await api("/api/me");
    if (data.user) await showApp(data.user);
    else showAuth();
  } catch {
    showAuth();
  }
})();
