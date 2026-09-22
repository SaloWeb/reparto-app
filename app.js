/* ===== Estado ===== */
const STORAGE_KEY = 'reparto-app-stops-v1';
const START_KEY = 'reparto-app-start-v1';
const MODE_KEY = 'reparto-app-mode-v1';
let stops = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
let startPoint = JSON.parse(localStorage.getItem(START_KEY) || 'null');
let mode = localStorage.getItem(MODE_KEY) || 'foot';
let map, markersLayer, routeLayer;
let roadRoute = null; // { latlngs, distanceKm, durationMin, forIds }

/* ===== Ubicacion en vivo (para orientarse mientras camina) ===== */
let watchId = null;       // id de navigator.geolocation.watchPosition, o null si no esta activo
let following = false;    // si true, el mapa se re-centra solo en cada posicion nueva
let liveMarker = null;
let liveAccuracyCircle = null;
let lastLivePos = null;
let notifiedStopId = null;    // id de la parada para la que ya avisamos "estas llegando"
let currentNextStopId = null; // id de la proxima parada pendiente (para detectar cambios)
const PROXIMITY_M = 40;       // metros para avisar "estas llegando"

/* ===== Viaje (planificar vs. en ruta) ===== */
const TRIP_KEY = 'reparto-app-trip-v1';
let tripActive = JSON.parse(localStorage.getItem(TRIP_KEY) || 'false');
function saveTrip() { localStorage.setItem(TRIP_KEY, JSON.stringify(tripActive)); }
let routeCandidates = []; // opciones de ruta calculadas por runOptimize, a elegir antes de arrancar

/* ===== Utils ===== */
function saveStops() { localStorage.setItem(STORAGE_KEY, JSON.stringify(stops)); }
function saveStart() { localStorage.setItem(START_KEY, JSON.stringify(startPoint)); }
function saveMode() { localStorage.setItem(MODE_KEY, mode); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function showToast(msg, ms = 3000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function haversine(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const s1 = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s1));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ===== Geocoding (Nominatim / OpenStreetMap, gratis, sin API key) ===== */
async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'es' } });
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), display_name: data[0].display_name };
}

async function searchSuggestions(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'es' } });
  return res.json();
}

/* ===== Ruteo real por calle (OSRM publico, gratis, sin API key) =====
   Servidor demo de OpenStreetMap Alemania: soporta perfiles foot y bike.
   Limite de uso: no comercial, max ~1 req/seg. Con 20-30 paradas puede tardar
   bastante, asi que usamos timeouts generosos y reintentamos una vez antes
   de rendirnos y avisar por que fallo. */
function osrmBase(profile) { return `https://routing.openstreetmap.de/routed-${profile}`; }
function coordStr(points) { return points.map(p => `${p.lon},${p.lat}`).join(';'); }

async function fetchJsonWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.httpStatus = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(to);
  }
}

async function fetchWithRetry(url, timeoutMs, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fetchJsonWithTimeout(url, timeoutMs);
    } catch (e) {
      const isLast = attempt === 2;
      const reason = e.name === 'AbortError' ? 'tardó demasiado (servidor de rutas ocupado)' :
        (e.httpStatus ? `el servidor de rutas respondió con error ${e.httpStatus}` : 'no se pudo conectar (¿sin internet?)');
      if (isLast) {
        lastRouteError = `No se pudo calcular ${label}: ${reason}.`;
        return null;
      }
      await sleep(900); // dar un respiro antes de reintentar
    }
  }
}
let lastRouteError = '';

async function fetchMatrix(points, profile) {
  const url = `${osrmBase(profile)}/table/v1/${profile}/${coordStr(points)}?annotations=distance`;
  const data = await fetchWithRetry(url, 20000, 'la matriz de distancias');
  if (!data || data.code !== 'Ok') return null;
  return data.distances;
}

async function fetchRouteGeometry(points, profile) {
  const url = `${osrmBase(profile)}/route/v1/${profile}/${coordStr(points)}?overview=full&geometries=geojson`;
  const data = await fetchWithRetry(url, 25000, 'el trazado sobre las calles');
  if (!data || data.code !== 'Ok' || !data.routes || !data.routes.length) return null;
  const r = data.routes[0];
  return {
    latlngs: r.geometry.coordinates.map(c => [c[1], c[0]]),
    distanceKm: r.distance / 1000,
    durationMin: r.duration / 60
  };
}

/* ===== Ruteo: vecino mas cercano + mejora 2-opt =====
   distFn(i, j) recibe indices sobre "points" y devuelve una distancia.
   points[0] es el origen si hay uno (startPoint); si no, points[0] es la 1ra parada. */
function nearestNeighborOrder(n, hasOrigin, distFn) {
  const visited = new Array(n).fill(false);
  const order = [];

  const stopOffset = hasOrigin ? 1 : 0; // indice 0 en points es el origen si hasOrigin
  const stopCount = n - stopOffset;

  for (let k = 0; k < stopCount; k++) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < stopCount; i++) {
      if (visited[i]) continue;
      const realIdx = i + stopOffset;
      const from = hasOrigin ? 0 : (order.length ? order[order.length - 1] + stopOffset : realIdx);
      const d = distFn(from, realIdx);
      if (d < bestD) { bestD = d; best = i; }
    }
    visited[best] = true;
    order.push(best);
  }
  return order; // indices relativos a la lista de paradas (0-based, sin offset)
}

function twoOpt(order, hasOrigin, distFn) {
  const stopOffset = hasOrigin ? 1 : 0;
  function routeLength(ord) {
    let total = 0;
    let prevReal = hasOrigin ? 0 : (ord[0] + stopOffset);
    const seq = hasOrigin ? ord : ord.slice(1);
    for (const idx of seq) {
      const real = idx + stopOffset;
      total += distFn(prevReal, real);
      prevReal = real;
    }
    return total;
  }
  const n = order.length;
  let improved = true, guard = 0;
  while (improved && guard < 200) {
    improved = false; guard++;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const newOrder = order.slice(0, i).concat(order.slice(i, j + 1).reverse(), order.slice(j + 1));
        if (routeLength(newOrder) < routeLength(order) - 1e-6) {
          order.splice(0, order.length, ...newOrder);
          improved = true;
        }
      }
    }
  }
  return order;
}

function optimizeOrder(list, origin, matrix) {
  if (list.length < 2) return list.slice();
  const hasOrigin = !!origin;
  const points = hasOrigin ? [origin, ...list] : list;
  const n = points.length;

  const distFn = matrix
    ? (i, j) => matrix[i][j]
    : (i, j) => haversine(points[i], points[j]);

  let order = nearestNeighborOrder(n, hasOrigin, distFn);
  order = twoOpt(order, hasOrigin, distFn);
  return order.map(i => list[i]);
}

/* ===== Render lista ===== */
function render() {
  const listEl = document.getElementById('stopList');
  const emptyEl = document.getElementById('emptyMsg');
  const countEl = document.getElementById('stopCount');
  countEl.textContent = `(${stops.length})`;
  listEl.innerHTML = '';
  emptyEl.style.display = stops.length ? 'none' : 'block';

  stops.forEach((s, idx) => {
    const li = document.createElement('li');
    li.className = 'stop-item' + (s.delivered ? ' delivered' : '');
    li.dataset.id = s.id;
    li.innerHTML = `
      <span class="drag-handle"><svg class="ic"><use href="#ic-handle"/></svg></span>
      <span class="stop-order">${idx + 1}</span>
      <input type="checkbox" class="stop-check" ${s.delivered ? 'checked' : ''}>
      <div class="stop-info">
        <div class="stop-address">${s.address}</div>
        <div class="stop-sub">${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}</div>
      </div>
      <button class="stop-nav" title="Navegar con Google Maps"><svg class="ic"><use href="#ic-compass"/></svg></button>
      <button class="stop-del" title="Quitar parada"><svg class="ic"><use href="#ic-close"/></svg></button>
    `;
    li.querySelector('.stop-nav').addEventListener('click', () => {
      const travel = mode === 'bike' ? 'bicycling' : 'walking';
      const url = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=${travel}&dir_action=navigate`;
      window.open(url, '_blank');
    });
    li.querySelector('.stop-check').addEventListener('change', (e) => {
      s.delivered = e.target.checked;
      if (e.target.checked && navigator.vibrate) navigator.vibrate(25);
      saveStops(); render(); renderMap();
    });
    li.querySelector('.stop-del').addEventListener('click', () => {
      stops = stops.filter(x => x.id !== s.id);
      saveStops(); render(); renderMap();
    });
    listEl.appendChild(li);
  });

  const delivered = stops.filter(s => s.delivered).length;
  const total = stops.length;
  document.getElementById('progressText').textContent = `${delivered}/${total} entregados`;
  document.getElementById('progressFill').style.width = total ? `${(delivered / total) * 100}%` : '0%';
  updateLiveDistance();
}

/* ===== Mapa =====
   CARTO (los tiles "Voyager", estilo claro tipo Google Maps) empezo a pedir una API key
   gratuita desde fines de agosto de 2026: sin key, el tile carga igual pero con una marca
   de agua "API KEY REQUIRED" encima. La key se pide gratis y sin cuenta en
   https://carto.com/basemaps/apikey/ (te la mandan por mail al toque). Si la conseguis,
   pegala aca abajo y la app vuelve a usar el estilo Voyager sin marca de agua.
   Mientras tanto, usamos OpenStreetMap estandar, que es gratis y no pide key. */
const CARTO_API_KEY = 'cb1_3t00_1_1cb6019582a4a6aac157289f'; // pegar aca la key si se consigue una

function initMap() {
  map = L.map('map', { zoomControl: true }).setView([-34.66, -58.73], 13);
  if (CARTO_API_KEY) {
    L.tileLayer(`https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=${CARTO_API_KEY}`, {
      maxZoom: 20,
      subdomains: 'abcd',
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    }).addTo(map);
  } else {
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      subdomains: 'abc',
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
  }
  markersLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
}

function pinIcon(number, kind) {
  // kind: 'stop' | 'delivered' | 'start'
  const cls = kind === 'delivered' ? 'delivered' : (kind === 'start' ? 'start' : '');
  const inner = kind === 'delivered'
    ? `<svg class="pin-check" viewBox="0 0 24 24" width="14" height="14"><polyline points="5 13 10 18 19 7" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : (number != null ? `<div class="pin-num">${number}</div>` : '');
  const html = `
    <div class="map-pin ${cls}">
      <svg viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg">
        <path class="pin-fill" fill="#1a73e8" d="M15 0C6.7 0 0 6.7 0 15c0 11.2 15 25 15 25s15-13.8 15-25C30 6.7 23.3 0 15 0z"/>
      </svg>
      ${inner}
    </div>`;
  return L.divIcon({ className: '', html, iconSize: [30, 40], iconAnchor: [15, 40] });
}

function currentPendingIds() {
  return stops.filter(s => !s.delivered).map(s => s.id).join(',');
}

function liveDotIcon() {
  const html = `<div class="live-dot-wrap"><div class="live-dot-pulse"></div><div class="live-dot"></div></div>`;
  return L.divIcon({ className: '', html, iconSize: [18, 18], iconAnchor: [9, 9] });
}

function updateLiveDistance() {
  const el = document.getElementById('liveDistance');
  if (!lastLivePos) { el.classList.add('hidden'); return; }
  const next = stops.find(s => !s.delivered);
  if (!next) { el.classList.add('hidden'); return; }
  const km = haversine(lastLivePos, next);
  const label = km < 1 ? `${Math.round(km * 1000)} m a la próxima parada` : `${km.toFixed(1)} km a la próxima parada`;
  el.textContent = label;
  el.classList.remove('hidden');
}

function renderMap() {
  if (!map) return;
  markersLayer.clearLayers();
  routeLayer.clearLayers();
  updateStatsUI(null);
  if (!stops.length) return;

  const bounds = [];
  if (startPoint) {
    L.marker([startPoint.lat, startPoint.lon], { icon: pinIcon(null, 'start') })
      .addTo(markersLayer).bindPopup('Punto de partida');
    bounds.push([startPoint.lat, startPoint.lon]);
  }
  stops.forEach((s, idx) => {
    L.marker([s.lat, s.lon], { icon: pinIcon(idx + 1, s.delivered ? 'delivered' : 'stop') })
      .addTo(markersLayer).bindPopup(s.address);
    bounds.push([s.lat, s.lon]);
  });

  const pendingIds = currentPendingIds();
  if (roadRoute && roadRoute.forIds === pendingIds) {
    // Ruta real siguiendo calles (casing blanco + linea de color, como Google Maps)
    L.polyline(roadRoute.latlngs, { color: '#ffffff', weight: 8, opacity: 0.9 }).addTo(routeLayer);
    L.polyline(roadRoute.latlngs, { color: '#1a73e8', weight: 5, opacity: 0.95 }).addTo(routeLayer);
    updateStatsUI(roadRoute);
  } else {
    const straight = [];
    if (startPoint) straight.push([startPoint.lat, startPoint.lon]);
    stops.forEach(s => straight.push([s.lat, s.lon]));
    L.polyline(straight, { color: '#5f6368', weight: 3, opacity: 0.55, dashArray: '6 8' }).addTo(routeLayer);
  }

  // Reencuadre inteligente: si estamos siguiendo la ubicacion en vivo, no tiene sentido
  // alejar la camara para mostrar todo el recorrido cada vez que algo cambia (ej. al tildar
  // una entrega) — mejor mantener el foco en "donde estoy" + "a donde voy ahora".
  const nextPending = stops.find(s => !s.delivered);
  if (following && lastLivePos && nextPending) {
    map.fitBounds(L.latLngBounds([[lastLivePos.lat, lastLivePos.lon], [nextPending.lat, nextPending.lon]]), {
      padding: [70, 90], maxZoom: 17
    });
  } else if (bounds.length) {
    map.fitBounds(L.latLngBounds(bounds), { padding: [40, 40] });
  }
}

function updateStatsUI(route) {
  const el = document.getElementById('routeStats');
  if (!route) { el.textContent = ''; return; }
  const km = route.distanceKm.toFixed(1);
  const min = Math.round(route.durationMin);
  el.textContent = `${km} km · ~${min} min`;
}

/* ===== Agregar direcciones ===== */
async function addAddress(address, coords) {
  let point = coords;
  if (!point) {
    point = await geocode(address);
    if (!point) throw new Error('No se encontro: ' + address);
  }
  const wasEmpty = stops.length === 0;
  stops.push({ id: uid(), address, lat: point.lat, lon: point.lon, delivered: false });
  saveStops();
  if (wasEmpty) setSheetState('half');
}

/* ===== Optimizar: paso rapido offline + calcular opciones de ruta real por calle =====
   En vez de fijar el modo de una, calculamos la mejor ruta para "a pie" y para "bici" y
   dejamos que el repartidor elija cual usar antes de arrancar el viaje. */
async function computeCandidate(profile, pending, origin) {
  let ordered = optimizeOrder(pending, origin, null); // paso rapido offline
  const points = origin ? [origin, ...ordered] : ordered;
  const matrix = await fetchMatrix(points, profile);
  if (matrix) ordered = optimizeOrder(pending, origin, matrix); // mejora con distancias reales
  const routePoints = origin ? [origin, ...ordered] : ordered;
  const geo = await fetchRouteGeometry(routePoints, profile);
  if (!geo) return null;
  return { mode: profile, order: ordered, route: geo };
}

async function runOptimize() {
  const pending = stops.filter(s => !s.delivered);
  const delivered = stops.filter(s => s.delivered);
  if (pending.length < 2) { showToast('Cargá al menos 2 direcciones sin entregar'); return; }

  const btn = document.getElementById('optimizeBtn');
  btn.disabled = true; btn.classList.add('loading');
  lastRouteError = '';

  // Orden rapido offline (linea recta) en el modo actual, para feedback inmediato
  const quickOrdered = optimizeOrder(pending, startPoint, null);
  stops = [...quickOrdered, ...delivered];
  roadRoute = null;
  saveStops(); render(); renderMap();

  // Calcular la mejor ruta real por calle para los dos modos posibles
  const [footCand, bikeCand] = await Promise.all([
    computeCandidate('foot', pending, startPoint),
    computeCandidate('bike', pending, startPoint)
  ]);
  routeCandidates = [footCand, bikeCand].filter(Boolean);

  btn.disabled = false; btn.classList.remove('loading');

  if (!routeCandidates.length) {
    showToast(lastRouteError || 'No se pudo calcular la ruta sobre las calles, quedó como línea recta.', 4500);
    return;
  }
  showRouteOptions();
}

function showRouteOptions() {
  const list = document.getElementById('routeOptionsList');
  list.innerHTML = '';
  routeCandidates.forEach(c => {
    const label = c.mode === 'bike' ? '🚲 En bici' : '🚶 A pie';
    const div = document.createElement('div');
    div.className = 'route-option';
    div.innerHTML = `
      <div class="route-option-info">
        <div class="route-option-label">${label}</div>
        <div class="route-option-stats">${c.route.distanceKm.toFixed(1)} km · ~${Math.round(c.route.durationMin)} min</div>
      </div>
      <button class="primary-btn route-option-pick">Elegir e iniciar viaje</button>
    `;
    div.querySelector('.route-option-pick').addEventListener('click', () => pickRouteAndStart(c));
    list.appendChild(div);
  });
  document.getElementById('routeOptionsModal').classList.remove('hidden');
}

function pickRouteAndStart(candidate) {
  mode = candidate.mode; saveMode();
  document.getElementById('modeSelect').value = mode;
  const delivered = stops.filter(s => s.delivered);
  stops = [...candidate.order, ...delivered];
  roadRoute = { ...candidate.route, forIds: currentPendingIds() };
  saveStops();
  document.getElementById('routeOptionsModal').classList.add('hidden');
  render(); renderMap();
  showToast('Ruta lista, siguiendo calles 🧭');
  startTrip();
}

/* ===== Modo viaje: separa "cargar y planificar" de "estoy repartiendo" =====
   Al elegir una ruta se arranca el viaje: se oculta la barra de busqueda/carga para no
   tentar a tocar cosas mientras se maneja o camina, y se prende el seguimiento en vivo solo. */
function startTrip() {
  tripActive = true; saveTrip();
  document.body.classList.add('trip-active');
  setSheetState('peek');
  startLiveTracking();
  syncTripUI();
}

function endTrip() {
  tripActive = false; saveTrip();
  document.body.classList.remove('trip-active');
  syncTripUI();
  closeMenu();
  showToast('Viaje finalizado');
}

function syncTripUI() {
  document.getElementById('endTripBtn').classList.toggle('hidden', !tripActive);
}

/* ===== Bandeja inferior deslizable ===== */
const sheet = document.getElementById('bottomSheet');
const sheetHandle = document.getElementById('sheetHandle');
const PEEK_PX = 116;
let sheetState = 'peek';
let sheetDragging = false, dragStartY = 0, dragStartTop = 0;

document.documentElement.style.setProperty('--sheet-peek', PEEK_PX + 'px');

function stateTop(state) {
  const vh = window.innerHeight;
  if (state === 'full') return vh * 0.06;
  if (state === 'half') return vh * 0.52;
  return vh - PEEK_PX; // peek
}

function setSheetState(state, animate = true) {
  sheetState = state;
  sheet.style.transition = animate ? 'transform .28s cubic-bezier(.4,0,.2,1)' : 'none';
  sheet.style.transform = `translateY(${stateTop(state)}px)`;
}

sheetHandle.addEventListener('pointerdown', (e) => {
  sheetDragging = true;
  dragStartY = e.clientY;
  dragStartTop = stateTop(sheetState);
  sheet.style.transition = 'none';
  sheetHandle.setPointerCapture(e.pointerId);
});
sheetHandle.addEventListener('pointermove', (e) => {
  if (!sheetDragging) return;
  const dy = e.clientY - dragStartY;
  let top = dragStartTop + dy;
  const minTop = stateTop('full'), maxTop = stateTop('peek');
  top = Math.max(minTop, Math.min(maxTop, top));
  sheet.style.transform = `translateY(${top}px)`;
});
function endSheetDrag(e) {
  if (!sheetDragging) return;
  sheetDragging = false;
  const totalDy = Math.abs(e.clientY - dragStartY);
  if (totalDy < 6) {
    // fue un tap, no un arrastre: alternar entre peek y half
    setSheetState(sheetState === 'peek' ? 'half' : 'peek');
    return;
  }
  const currentTop = parseFloat((sheet.style.transform.match(/-?\d+(\.\d+)?/) || [0])[0]);
  const tops = { full: stateTop('full'), half: stateTop('half'), peek: stateTop('peek') };
  let nearest = 'peek', best = Infinity;
  for (const k in tops) { const d = Math.abs(tops[k] - currentTop); if (d < best) { best = d; nearest = k; } }
  setSheetState(nearest, true);
}
sheetHandle.addEventListener('pointerup', endSheetDrag);
sheetHandle.addEventListener('pointercancel', endSheetDrag);
window.addEventListener('resize', () => setSheetState(sheetState, false));

/* ===== Menu flotante ===== */
const menuBtn = document.getElementById('menuBtn');
const menuPanel = document.getElementById('menuPanel');
const menuBackdrop = document.getElementById('menuBackdrop');
const removeStartBtn = document.getElementById('removeStartBtn');
function syncRemoveStartBtn() { removeStartBtn.classList.toggle('hidden', !startPoint); }
removeStartBtn.addEventListener('click', () => {
  startPoint = null; saveStart(); roadRoute = null; renderMap(); closeMenu();
  showToast('Punto de partida quitado');
});
function openMenu() { syncRemoveStartBtn(); syncLiveUI(); menuPanel.classList.remove('hidden'); menuBackdrop.classList.remove('hidden'); }
function closeMenu() { menuPanel.classList.add('hidden'); menuBackdrop.classList.add('hidden'); }
menuBtn.addEventListener('click', () => menuPanel.classList.contains('hidden') ? openMenu() : closeMenu());
menuBackdrop.addEventListener('click', closeMenu);

/* ===== Modal pegar lista ===== */
const pasteModal = document.getElementById('pasteModal');
document.getElementById('pasteOpenBtn').addEventListener('click', () => {
  closeMenu();
  pasteModal.classList.remove('hidden');
});
document.getElementById('pasteCancelBtn').addEventListener('click', () => {
  pasteModal.classList.add('hidden');
});

/* ===== Eventos UI ===== */
document.getElementById('modeSelect').value = mode;
document.getElementById('modeSelect').addEventListener('change', (e) => {
  mode = e.target.value; saveMode();
  roadRoute = null; renderMap();
});

let searchTimer;
const searchInput = document.getElementById('searchInput');
const suggEl = document.getElementById('suggestions');
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  suggEl.innerHTML = '';
  if (q.length < 4) return;
  searchTimer = setTimeout(async () => {
    try {
      const results = await searchSuggestions(q);
      suggEl.innerHTML = '';
      results.forEach(r => {
        const li = document.createElement('li');
        li.textContent = r.display_name;
        li.addEventListener('click', async () => {
          try {
            await addAddress(r.display_name, { lat: parseFloat(r.lat), lon: parseFloat(r.lon) });
            searchInput.value = ''; suggEl.innerHTML = '';
            roadRoute = null; render(); renderMap();
            showToast('Dirección agregada');
          } catch (e) {
            showToast('No se pudo agregar la dirección, probá de nuevo');
          }
        });
        suggEl.appendChild(li);
      });
    } catch (e) { /* sin conexion, ignorar */ }
  }, 500);
});

/* ===== Ubicacion en vivo =====
   El boton flotante de "mi ubicacion" ahora sigue la posicion en tiempo real (como el punto
   azul de Google Maps), no solo la pide una vez. Mientras "following" este activo, el mapa
   se recentra solo en cada actualizacion; si el repartidor mueve el mapa a mano, se deja de
   seguir automaticamente (pero el punto azul sigue actualizandose). Para cortar del todo el
   seguimiento (y ahorrar bateria) esta la opcion en el menu de arriba. */
function onLivePosition(pos) {
  const lat = pos.coords.latitude, lon = pos.coords.longitude;
  lastLivePos = { lat, lon };
  if (!liveMarker) {
    liveMarker = L.marker([lat, lon], { icon: liveDotIcon(), zIndexOffset: 1000, interactive: false }).addTo(map);
    liveAccuracyCircle = L.circle([lat, lon], {
      radius: pos.coords.accuracy || 15, color: '#1a73e8', weight: 1,
      fillColor: '#1a73e8', fillOpacity: 0.12, interactive: false
    }).addTo(map);
  } else {
    liveMarker.setLatLng([lat, lon]);
    liveAccuracyCircle.setLatLng([lat, lon]);
    liveAccuracyCircle.setRadius(pos.coords.accuracy || 15);
  }
  if (following) map.setView([lat, lon], Math.max(map.getZoom(), 16), { animate: true });
  updateLiveDistance();
  checkProximity();
}

/* Avisa (una sola vez por parada) cuando estamos cerca de la proxima entrega pendiente.
   Solo avisa — no la tilda como entregada solo, eso lo decide el repartidor a mano. */
function checkProximity() {
  const next = stops.find(s => !s.delivered);
  if (!next) { currentNextStopId = null; notifiedStopId = null; return; }
  if (next.id !== currentNextStopId) {
    currentNextStopId = next.id;
    notifiedStopId = null; // nueva proxima parada: se puede volver a avisar
  }
  if (!lastLivePos || notifiedStopId === next.id) return;
  const meters = haversine(lastLivePos, next) * 1000;
  if (meters <= PROXIMITY_M) {
    notifiedStopId = next.id;
    showToast('📍 Estás llegando a: ' + next.address, 4500);
    if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
  }
}

function onLiveError(err) {
  const reason = err.code === 1 ? 'permiso denegado' : (err.code === 3 ? 'tardó demasiado' : 'sin señal de GPS');
  showToast('No se pudo seguir tu ubicación (' + reason + ')');
  stopLiveTracking();
}

function syncLiveUI() {
  document.getElementById('locateFab').classList.toggle('active', following);
  document.getElementById('stopLiveBtn').classList.toggle('hidden', watchId == null);
}

function startLiveTracking() {
  if (!navigator.geolocation) { showToast('El navegador no soporta geolocalización'); return; }
  following = true;
  syncLiveUI();
  if (watchId != null) {
    // ya estaba trackeando (el repartidor solo movio el mapa a mano): retomar el seguimiento
    if (lastLivePos) map.setView([lastLivePos.lat, lastLivePos.lon], Math.max(map.getZoom(), 16));
    return;
  }
  showToast('Siguiendo tu ubicación en vivo...');
  watchId = navigator.geolocation.watchPosition(onLivePosition, onLiveError, {
    enableHighAccuracy: true, maximumAge: 2000, timeout: 10000
  });
}

function stopLiveTracking() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null; following = false; lastLivePos = null;
  if (liveMarker) { map.removeLayer(liveMarker); liveMarker = null; }
  if (liveAccuracyCircle) { map.removeLayer(liveAccuracyCircle); liveAccuracyCircle = null; }
  syncLiveUI();
  updateLiveDistance();
}

document.getElementById('locateFab').addEventListener('click', startLiveTracking);
document.getElementById('stopLiveBtn').addEventListener('click', () => {
  stopLiveTracking(); closeMenu(); showToast('Dejaste de seguir tu ubicación');
});
// Boton dentro del buscador: fija el punto de partida UNA vez (no activa el seguimiento en vivo)
document.getElementById('useLocationBtn').addEventListener('click', () => {
  if (!navigator.geolocation) { showToast('El navegador no soporta geolocalización'); return; }
  showToast('Buscando tu ubicación...');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      startPoint = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      saveStart(); roadRoute = null; renderMap();
      showToast('Punto de partida actualizado');
    },
    () => showToast('No se pudo obtener tu ubicación'),
    { enableHighAccuracy: true, timeout: 8000 }
  );
});

document.getElementById('pasteBtn').addEventListener('click', async () => {
  const raw = document.getElementById('pasteArea').value;
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return;
  const statusEl = document.getElementById('pasteStatus');
  let ok = 0, fail = 0;
  for (let i = 0; i < lines.length; i++) {
    statusEl.textContent = `Cargando ${i + 1}/${lines.length}...`;
    try {
      await addAddress(lines[i]);
      ok++;
    } catch (e) { fail++; }
    roadRoute = null; render(); renderMap();
    if (i < lines.length - 1) await sleep(1100); // respetar limite de Nominatim (1 req/seg)
  }
  statusEl.textContent = `Listo: ${ok} agregadas, ${fail} no encontradas.`;
  document.getElementById('pasteArea').value = '';
  if (ok > 0) {
    setTimeout(() => { pasteModal.classList.add('hidden'); statusEl.textContent = ''; }, 1400);
  }
});

document.getElementById('optimizeBtn').addEventListener('click', runOptimize);
document.getElementById('endTripBtn').addEventListener('click', endTrip);
document.getElementById('routeOptionsCancelBtn').addEventListener('click', () => {
  document.getElementById('routeOptionsModal').classList.add('hidden');
});

document.getElementById('clearBtn').addEventListener('click', () => {
  closeMenu();
  if (!confirm('¿Borrar todas las direcciones cargadas?')) return;
  stops = []; startPoint = null; roadRoute = null;
  saveStops(); saveStart(); render(); renderMap();
  setSheetState('peek');
  if (tripActive) endTrip();
});

/* Reordenar a mano con SortableJS */
Sortable.create(document.getElementById('stopList'), {
  handle: '.drag-handle',
  animation: 150,
  onEnd: () => {
    const ids = [...document.querySelectorAll('.stop-item')].map(li => li.dataset.id);
    stops = ids.map(id => stops.find(s => s.id === id));
    roadRoute = null; // el orden a mano invalida la ruta calculada; re-optimizar la vuelve a dibujar
    saveStops(); render(); renderMap();
  }
});

/* ===== Service worker ===== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* ===== Init ===== */
initMap();
render();
renderMap();
if (tripActive && roadRoute) {
  document.body.classList.add('trip-active');
  startLiveTracking();
  setSheetState('peek', false);
} else {
  tripActive = false; saveTrip();
  setSheetState(stops.length ? 'half' : 'peek', false);
}
syncTripUI();
