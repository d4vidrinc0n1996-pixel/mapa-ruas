// Servicios de ArcGIS Location Platform (Esri) con la clave del usuario: búsqueda de lugares
// y elevación del terreno. Los mapas base con clave están en basemaps.js.
// Cada servicio exige su privilegio en la clave: al guardarla se comprueba cuáles tiene, y
// la app sólo usa esos. Ante cualquier error se vuelve a las fuentes gratuitas.

import { storage } from './storage.js';

const GEOCODE = 'https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer';
const ELEVATION = 'https://elevation-api.arcgis.com/arcgis/rest/services/elevation-service/v1/elevation';
export const STATIC_TILES = 'https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1';

// Capacidades comprobadas de la clave guardada: { key: últimos caracteres, basemaps, geocode, elevation }.
export function arcgisCapabilities(key) {
  const caps = storage.getJSON('arcgisCaps');
  return key && caps?.key === key.slice(-8) ? caps : { basemaps: false, geocode: false, elevation: false };
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error?.message ?? `HTTP ${res.status}`);
  return j;
}

// Prueba cada servicio con una petición mínima y guarda qué funciona.
export async function validateArcgisKey(key) {
  const token = encodeURIComponent(key);
  const check = async (fn) => {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  };
  const [basemaps, geocode, elevation] = await Promise.all([
    check(async () => {
      const res = await fetch(`${STATIC_TILES}/arcgis/outdoor/static/tile/0/0/0?token=${token}`);
      if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) throw new Error('sin acceso');
    }),
    check(() => getJson(`${GEOCODE}/findAddressCandidates?SingleLine=Bogot%C3%A1&countryCode=CO&maxLocations=1&f=json&token=${token}`)),
    check(() => getJson(`${ELEVATION}/at-point?lon=-74.08&lat=4.6&f=json&token=${token}`)),
  ]);
  const caps = { key: key.slice(-8), basemaps, geocode, elevation };
  storage.setJSON('arcgisCaps', caps);
  return caps;
}

// Búsqueda de lugares. near: [lat, lon] para priorizar resultados cercanos.
export async function arcgisGeocode(query, { key, countryCode, near }) {
  const params = new URLSearchParams({
    SingleLine: query,
    maxLocations: '6',
    outFields: 'PlaceName,Place_addr,Type',
    langCode: 'es',
    f: 'json',
    token: key,
  });
  if (countryCode) params.set('countryCode', countryCode);
  if (near) params.set('location', `${near[1]},${near[0]}`);
  const j = await getJson(`${GEOCODE}/findAddressCandidates?${params}`);
  return (j.candidates ?? []).map((c) => ({
    lat: c.location.y,
    lon: c.location.x,
    name: c.attributes?.PlaceName || c.address,
    detail: [c.attributes?.Type, c.attributes?.Place_addr].filter(Boolean).join(' · '),
  }));
}

export async function arcgisElevation([lat, lon], key) {
  const j = await getJson(`${ELEVATION}/at-point?lon=${lon.toFixed(6)}&lat=${lat.toFixed(6)}&f=json&token=${encodeURIComponent(key)}`);
  const z = j.result?.point?.z;
  if (!Number.isFinite(z)) throw new Error('Respuesta de elevación inesperada');
  return z;
}

// Hasta 100 puntos por petición. Se envía como formulario para evitar la consulta previa de CORS.
export async function arcgisElevations(points, key) {
  const out = [];
  for (let i = 0; i < points.length; i += 100) {
    const batch = points.slice(i, i + 100);
    const body = new URLSearchParams({
      coordinates: JSON.stringify(batch.map(([lat, lon]) => [Number(lon.toFixed(6)), Number(lat.toFixed(6))])),
      f: 'json',
      token: key,
    });
    const j = await getJson(`${ELEVATION}/at-many-points`, { method: 'POST', body });
    const zs = (j.result?.points ?? []).map((p) => p.z);
    if (zs.length !== batch.length) throw new Error('Respuesta de elevación inesperada');
    out.push(...zs);
  }
  return out;
}
