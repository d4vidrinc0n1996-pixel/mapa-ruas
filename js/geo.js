// Utilidades geométricas. Todas las coordenadas van como [lat, lon] en grados.

const EARTH_RADIUS = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function haversine([lat1, lon1], [lat2, lon2]) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Regla par-impar sobre todos los anillos: maneja huecos y multipolígonos.
export function pointInRings([lat, lon], rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i];
      const [yj, xj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// Distancia aproximada (m) al borde más cercano, con proyección local equirectangular.
// Suficiente para distancias de pocos kilómetros.
export function distanceToRings([lat, lon], rings) {
  const kx = 111320 * Math.cos(rad(lat));
  const ky = 110540;
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ax = (ring[j][1] - lon) * kx;
      const ay = (ring[j][0] - lat) * ky;
      const dx = (ring[i][1] - lon) * kx - ax;
      const dy = (ring[i][0] - lat) * ky - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const px = ax + t * dx;
      const py = ay + t * dy;
      best = Math.min(best, px * px + py * py);
    }
  }
  return Math.sqrt(best);
}

export function ringsBBox(rings) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const ring of rings) {
    for (const [lat, lon] of ring) {
      if (lat < s) s = lat;
      if (lat > n) n = lat;
      if (lon < w) w = lon;
      if (lon > e) e = lon;
    }
  }
  return [s, w, n, e];
}

export function bboxContains([s, w, n, e], [lat, lon], marginM = 0) {
  const dLat = marginM / 110540;
  const dLon = marginM / (111320 * Math.cos(rad(lat)));
  return lat >= s - dLat && lat <= n + dLat && lon >= w - dLon && lon <= e + dLon;
}

export function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}

export function formatCoord(lat, lon) {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}
