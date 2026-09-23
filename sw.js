const CACHE_NAME = 'mi-ruta-v11';
const SHELL_FILES = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-maskable.svg',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Cache-first para el "shell" de la app; todo lo demas (geocoding, tiles del mapa)
// va directo a la red porque necesita estar actualizado y no funciona offline igual.
self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  const isShell = SHELL_FILES.some((f) => f.startsWith('http') ? url === f : url.endsWith(f.replace('./', '')));
  if (!isShell) return; // dejar pasar (red): geocoding, ruteo, tiles del mapa

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      });
    })
  );
});
