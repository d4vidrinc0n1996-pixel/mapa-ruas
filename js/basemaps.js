// Mapas base. Los que tienen `needs` requieren una clave de API que el usuario guarda
// en su dispositivo (nunca en el repositorio).

import { storage } from './storage.js';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const OSM_ATTR = '&copy; colaboradores de <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const ESRI_ATTR = 'Mapa &copy; Esri y sus proveedores';

export const PROVIDERS = {
  mapbox: { label: 'Mapbox', help: 'Token público (pk.…) de account.mapbox.com' },
  maptiler: { label: 'MapTiler', help: 'Clave de cloud.maptiler.com' },
  google: { label: 'Google Maps', help: 'Clave con la «Map Tiles API» habilitada' },
};

export const BASEMAPS = {
  osm: { label: 'OSM', tiles: [{ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: OSM_ATTR, maxZoom: 19 }] },
  // Lienzos neutros: las zonas de colores se leen mejor encima.
  claro: {
    label: 'Claro',
    tiles: [
      { url: `${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, attribution: ESRI_ATTR, maxNativeZoom: 16, maxZoom: 19 },
      { url: `${ESRI}/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, maxNativeZoom: 16, maxZoom: 19 },
    ],
  },
  oscuro: {
    label: 'Oscuro',
    tiles: [
      { url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, attribution: ESRI_ATTR, maxNativeZoom: 16, maxZoom: 19 },
      { url: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, maxNativeZoom: 16, maxZoom: 19 },
    ],
  },
  calles: { label: 'Calles', tiles: [{ url: `${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`, attribution: ESRI_ATTR, maxZoom: 19 }] },
  satelite: {
    label: 'Satélite',
    tiles: [{ url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, attribution: 'Imágenes &copy; Esri, Maxar, Earthstar Geographics', maxZoom: 19 }],
  },
  hibrido: {
    label: 'Híbrido',
    tiles: [
      { url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, attribution: 'Imágenes &copy; Esri, Maxar, Earthstar Geographics', maxZoom: 19 },
      { url: `${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`, maxZoom: 19 },
      { url: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, maxZoom: 19 },
    ],
  },
  topo: { label: 'Topográfico', tiles: [{ url: `${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`, attribution: ESRI_ATTR, maxZoom: 19 }] },
  relieve: {
    label: 'Relieve',
    tiles: [
      {
        url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
        attribution: `${OSM_ATTR}, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
        maxZoom: 17,
      },
    ],
  },
  mapboxSat: {
    label: 'Mapbox satélite',
    needs: 'mapbox',
    tiles: [
      {
        url: 'https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/512/{z}/{x}/{y}{r}?access_token={key}',
        attribution: '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> ' + OSM_ATTR,
        tileSize: 512,
        zoomOffset: -1,
        maxZoom: 22,
      },
    ],
  },
  mapboxOutdoors: {
    label: 'Mapbox exterior',
    needs: 'mapbox',
    tiles: [
      {
        url: 'https://api.mapbox.com/styles/v1/mapbox/outdoors-v12/tiles/512/{z}/{x}/{y}{r}?access_token={key}',
        attribution: '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> ' + OSM_ATTR,
        tileSize: 512,
        zoomOffset: -1,
        maxZoom: 22,
      },
    ],
  },
  maptilerHybrid: {
    label: 'MapTiler híbrido',
    needs: 'maptiler',
    tiles: [
      {
        url: 'https://api.maptiler.com/maps/hybrid/256/{z}/{x}/{y}{r}.jpg?key={key}',
        attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> ' + OSM_ATTR,
        maxZoom: 20,
      },
    ],
  },
  maptilerOutdoor: {
    label: 'MapTiler exterior',
    needs: 'maptiler',
    tiles: [
      {
        url: 'https://api.maptiler.com/maps/outdoor-v2/256/{z}/{x}/{y}{r}.png?key={key}',
        attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> ' + OSM_ATTR,
        maxZoom: 20,
      },
    ],
  },
  googleHibrido: { label: 'Google híbrido', needs: 'google', google: { mapType: 'satellite', layerTypes: ['layerRoadmap'] } },
  googleMapa: { label: 'Google mapa', needs: 'google', google: { mapType: 'roadmap' } },
  googleRelieve: { label: 'Google relieve', needs: 'google', google: { mapType: 'terrain', layerTypes: ['layerRoadmap'] } },
};

export function getKeys() {
  return storage.getJSON('apiKeys') ?? {};
}

export function saveKeys(keys) {
  const clean = Object.fromEntries(Object.entries(keys).filter(([, v]) => v && v.trim()).map(([k, v]) => [k, v.trim()]));
  storage.setJSON('apiKeys', clean);
  return clean;
}

// Devuelve las capas Leaflet del mapa base. Lanza un error si falta la clave.
export async function createBaseLayers(id, keys, { region = 'CO' } = {}) {
  const def = BASEMAPS[id];
  if (!def) throw new Error('Mapa base desconocido');
  const key = def.needs ? keys[def.needs] : null;
  if (def.needs && !key) throw new Error(`Falta la clave de ${PROVIDERS[def.needs].label}`);

  if (def.google) {
    const session = await googleSession(key, { ...def.google, region });
    return [
      L.tileLayer('https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session={session}&key={key}', {
        session,
        key,
        maxZoom: 22,
        attribution: 'Mapa e imágenes &copy; Google',
      }),
    ];
  }

  return def.tiles.map(({ url, ...options }) =>
    L.tileLayer(url, { ...options, key, crossOrigin: def.needs ? undefined : 'anonymous' }),
  );
}

// La Map Tiles API de Google exige crear una sesión, válida unos días.
async function googleSession(key, { mapType, layerTypes, region }) {
  const cacheKey = `googleSession:${mapType}:${region}:${key.slice(-6)}`;
  const cached = storage.getJSON(cacheKey);
  if (cached && cached.expiry * 1000 > Date.now() + 3600e3) return cached.session;

  const res = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapType, language: 'es', region, ...(layerTypes ? { layerTypes } : {}) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.session) throw new Error(data.error?.message ?? 'Google rechazó la clave');
  storage.setJSON(cacheKey, { session: data.session, expiry: Number(data.expiry) });
  return data.session;
}
