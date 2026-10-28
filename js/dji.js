// Zonas GEO de DJI (FlySafe): la geovalla que aplican los drones DJI. No es la normativa
// sino lo que hará el dron (avisar, pedir confirmación, bloquear o limitar la altura).
// El servicio es el que usa el mapa público fly-safe.dji.com: no es oficial ni está
// documentado, así que puede cambiar sin aviso. Por eso la capa es opcional.

import { storage } from './storage.js';

const API = 'https://flysafe-api.dji.com';
const LEVELS_QUERY = '0,1,2,3,7,10';

const LEVELS = {
  0: { label: 'Advertencia', color: '#ffcc00', effect: () => 'El dron mostrará un aviso, pero puedes volar.' },
  1: {
    label: 'Autorización',
    color: '#1088f2',
    effect: () => 'El dron no despegará hasta que pidas un desbloqueo con una cuenta DJI verificada.',
  },
  2: {
    label: 'Restringida',
    color: '#de4329',
    effect: () => 'El dron no podrá despegar ni entrar. Requiere un desbloqueo especial de DJI.',
  },
  3: {
    label: 'Advertencia reforzada',
    color: '#ee8815',
    effect: () => 'El dron pedirá que confirmes el vuelo; se desbloquea al momento desde la app.',
  },
  7: {
    label: 'Restringida por regulación',
    color: '#37c4db',
    effect: () => 'Restringida por la regulación local: el dron no podrá despegar.',
  },
  10: { label: 'Altura limitada', color: '#377a26', effect: (h) => `El dron limitará la altura${h > 0 ? ` a ${h} m` : ''}.` },
};

// Una zona restringida con techo es una «zona de altitud»: se puede volar por debajo.
export function djiLevel(props) {
  if (props.level === 2 && props.height > 0) {
    return { label: 'Zona de altitud', color: '#979797', effect: (h) => `El dron limitará la altura a ${h} m.` };
  }
  return LEVELS[props.level] ?? { label: `Nivel ${props.level}`, color: '#64748b', effect: () => '' };
}

// ---------- Modelo de dron ----------

export const DEFAULT_DRONE = 'dji-mini-4-pro';

// Lista de respaldo si no se puede consultar la de DJI.
const FALLBACK_DRONES = [
  ['dji-mini-4-pro', 'DJI Mini 4 Pro'],
  ['dji-mini-4k', 'DJI Mini 4K'],
  ['dji-mini-3-pro', 'DJI Mini 3 Pro'],
  ['dji-mini-3', 'DJI Mini 3'],
  ['dji-air-3', 'DJI Air 3'],
  ['dji-air-2s', 'DJI Air 2S'],
  ['dji-mavic-4-pro', 'DJI Mavic 4 Pro'],
  ['dji-mavic-3-pro', 'DJI Mavic 3 Pro'],
  ['dji-mavic-3', 'DJI Mavic 3'],
  ['dji-mavic-3-classic', 'DJI Mavic 3 Classic'],
  ['dji-avata-2', 'DJI Avata 2'],
  ['dji-fpv', 'DJI FPV'],
].map(([slug, name]) => ({ slug, name }));

export const getDrone = () => storage.get('djiDrone') ?? DEFAULT_DRONE;
export const setDrone = (slug) => storage.set('djiDrone', slug);

export async function fetchDrones() {
  try {
    const res = await fetch(`${API}/dji/drones`);
    const j = await res.json();
    // Varios modelos agrícolas comparten identificador: se deja uno por identificador.
    const unique = new Map((j.drones ?? []).map((d) => [d.slug, d]));
    const list = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
    return list.length ? list : FALLBACK_DRONES;
  } catch {
    return FALLBACK_DRONES;
  }
}

// ---------- Zonas ----------

// bbox: [sur, oeste, norte, este]. El servicio rechaza búsquedas de más de 1.000 km.
export async function fetchDjiZones([s, w, n, e], drone) {
  const params = new URLSearchParams({
    zones_mode: 'total',
    drone,
    level: LEVELS_QUERY,
    rng_lat: ((s + n) / 2).toFixed(5),
    rng_lng: ((w + e) / 2).toFixed(5),
    ltlat: n.toFixed(5),
    ltlng: w.toFixed(5),
    rblat: s.toFixed(5),
    rblng: e.toFixed(5),
  });
  const res = await fetch(`${API}/api/qep/geo/feedback/areas/in_rectangle?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.code !== 0) throw new Error(j.message?.english ?? 'Error del servicio de DJI');

  const now = Date.now() / 1000;
  const features = [];
  for (const area of j.data?.areas ?? []) {
    if (area.end_at && area.end_at < now) continue; // zona temporal ya vencida
    // Cada zona agrupa subzonas (círculos o polígonos) con su propio nivel y techo.
    const parts = area.sub_areas?.length ? area.sub_areas : [area];
    parts.forEach((part, k) => {
      const props = {
        name: area.name,
        level: part.level ?? area.level,
        height: part.height ?? area.height ?? 0,
        begin_at: area.begin_at,
        end_at: area.end_at,
        description: area.description,
        address: area.address,
      };
      let geometry = null;
      if (part.shape === 1 && part.polygon_points?.length) geometry = { type: 'Polygon', coordinates: part.polygon_points };
      else if (part.radius > 0) {
        geometry = { type: 'Point', coordinates: [part.lng, part.lat] };
        props.radius = part.radius;
      }
      if (geometry) features.push({ type: 'Feature', id: `${area.area_id}-${k}`, properties: props, geometry });
    });
  }
  return { type: 'FeatureCollection', features };
}

export const DJI_LAYER = {
  id: 'dji',
  label: 'Zonas GEO de DJI',
  legend: 'Geovalla del fabricante · no oficial',
  legendColor: '#ee8815',
  dji: true,
  optional: true,
  dashArray: '6 4',
  source: { fetch: (bbox) => fetchDjiZones(bbox, getDrone()), tiled: { tileDeg: 3, minZoom: 5, maxTiles: 40 } },
  category: 'dji',
  color: (p) => djiLevel(p).color,
  radiusM: (p) => p.radius,
  name: (p) => p.name,
  subtitle: (p) => djiLevel(p).label,
  details: (p) => [p.description, p.address].filter(Boolean).join('\n'),
};
