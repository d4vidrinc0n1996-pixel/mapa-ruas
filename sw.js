// Service worker: app instalable y uso sin conexión con los últimos datos descargados.

const SHELL_CACHE = 'mapa-ruas-shell-v1';
const DATA_CACHE = 'mapa-ruas-data-v1';
const TILE_CACHE = 'mapa-ruas-tiles-v1';
const MAX_TILES = 2000;

const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/geo.js',
  'js/gps.js',
  'js/render.js',
  'js/sources.js',
  'js/storage.js',
  'js/zones.js',
  'js/countries/index.js',
  'js/countries/co.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

const TILE_HOSTS = /(^|\.)tile\.openstreetmap\.org$|^server\.arcgisonline\.com$|(^|\.)tile\.opentopomap\.org$/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  const keep = [SHELL_CACHE, DATA_CACHE, TILE_CACHE];
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin || url.hostname === 'unpkg.com') {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  } else if (url.hostname.endsWith('.arcgis.com') && url.pathname.includes('/FeatureServer/')) {
    event.respondWith(networkFirst(request, DATA_CACHE));
  } else if (TILE_HOSTS.test(url.hostname)) {
    event.respondWith(cacheFirst(request, TILE_CACHE));
  }
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Las respuestas opacas ocupan mucha cuota: sólo se guardan teselas con CORS.
  if (response.ok && response.type !== 'opaque') {
    await cache.put(request, response.clone());
    trim(cache);
  }
  return response;
}

let trimming = false;
async function trim(cache) {
  if (trimming) return;
  trimming = true;
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_TILES)).map((k) => cache.delete(k)));
  trimming = false;
}
