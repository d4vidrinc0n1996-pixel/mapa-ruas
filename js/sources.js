// Carga de capas de zonas y conversión a "features" internos.
//
// Una capa (definida en el módulo de cada país) describe:
//   source:   { type: 'arcgis' | 'geojson', url: string | string[], simplify?,
//               where?, outFields?, orderBy?, pageSize?,
//               format?: 'esrijson'  -> algunos servidores sólo simplifican en su formato propio
//               tiled?: { tileDeg, minZoom, maxTiles? } }  -> carga por zona visible
//   category: 'prohibited' | 'restricted' | 'limited' | 'caution' | 'info'  (o función de las propiedades;
//             null descarta el elemento)
//   name, subtitle, details, group, maxAltitudeM, ceilingAmslM, radiusM: valor o función (props) => valor
//   ceilingAmslM: techo absoluto (m sobre el nivel del mar); con la elevación del terreno da la altura máxima real.

import { ringsBBox } from './geo.js';

export const CATEGORIES = ['prohibited', 'restricted', 'limited', 'caution'];

// Tolerancia de simplificación en grados (~3 m): algunas capas oficiales traen
// círculos con miles de vértices y pesan decenas de MB sin simplificar.
const DEFAULT_SIMPLIFY = 0.00003;

// bbox: [sur, oeste, norte, este] para pedir sólo una parte de la capa.
// source.fetch(bbox) permite fuentes con su propio cliente (p. ej. DJI).
export async function fetchSource(source, { signal, bbox } = {}) {
  if (source.fetch) return source.fetch(bbox);
  const urls = [].concat(source.url);
  const parts = await Promise.all(
    urls.map((url) => (source.type === 'arcgis' ? fetchArcgis(url, source, signal, bbox) : fetchJson(url, signal))),
  );
  // _src distingue features de distintas URLs que comparten OBJECTID.
  return {
    type: 'FeatureCollection',
    features: parts.flatMap((part, src) => (part.features ?? []).map((f) => ({ ...f, _src: src }))),
  };
}

async function fetchJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isThrottled = (err) => /429|too many requests/i.test(`${err?.code ?? ''} ${err?.message ?? ''}`);

// Algunos servicios oficiales (p. ej. la FAA) comparten una cuota por minuto entre todos
// sus usuarios: ante un rechazo por saturación se reintenta con espera creciente.
async function fetchArcgisPage(url, signal, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    let page;
    try {
      page = await fetchJson(url, signal);
    } catch (err) {
      if (attempt >= attempts || !isThrottled(err)) throw err;
      await sleep(1500 * attempt + Math.random() * 1000);
      continue;
    }
    if (!page.error) return page;
    if (attempt >= attempts || !isThrottled(page.error)) throw new Error(page.error.message ?? 'Error del servicio ArcGIS');
    await sleep(1500 * attempt + Math.random() * 1000);
  }
}

// Feature en formato JSON de Esri -> GeoJSON. Los anillos van todos juntos: la
// evaluación usa la regla par-impar, así que no hace falta separar polígonos.
function esriToGeojson(feature) {
  const g = feature.geometry;
  const props = feature.attributes ?? {};
  let geometry = null;
  if (g?.rings) geometry = { type: 'Polygon', coordinates: g.rings };
  else if (g && 'x' in g) geometry = { type: 'Point', coordinates: [g.x, g.y] };
  return { type: 'Feature', id: props.OBJECTID ?? props.objectid, properties: props, geometry };
}

// Consulta paginada a un servicio de ArcGIS, devolviendo GeoJSON en WGS84.
async function fetchArcgis(layerUrl, source, signal, bbox) {
  const pageSize = source.pageSize ?? 2000;
  const esri = source.format === 'esrijson';
  const features = [];
  for (let offset = 0; ; offset += pageSize) {
    const params = new URLSearchParams({
      where: source.where ?? '1=1',
      outFields: source.outFields ?? '*',
      outSR: '4326',
      f: esri ? 'json' : 'geojson',
      geometryPrecision: '6',
      maxAllowableOffset: String(source.simplify ?? DEFAULT_SIMPLIFY),
      orderByFields: source.orderBy ?? 'OBJECTID',
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
    });
    if (bbox) {
      const [s, w, n, e] = bbox;
      params.set('geometry', `${w},${s},${e},${n}`);
      params.set('geometryType', 'esriGeometryEnvelope');
      params.set('inSR', '4326');
      params.set('spatialRel', 'esriSpatialRelIntersects');
    }
    const page = await fetchArcgisPage(`${layerUrl}/query?${params}`, signal);
    const batch = esri ? (page.features ?? []).map(esriToGeojson) : (page.features ?? []);
    features.push(...batch);
    const more = esri ? page.exceededTransferLimit : page.properties?.exceededTransferLimit;
    if (!more || batch.length === 0) break;
  }
  return { features };
}

const clean = (value) => (value == null ? '' : String(value).trim());

export function geojsonToFeatures(collection, layer) {
  const out = [];
  (collection.features ?? []).forEach((f, i) => {
    const geometry = f.geometry;
    if (!geometry) return;
    const props = f.properties ?? {};
    const pick = (v) => (typeof v === 'function' ? v(props) : v);
    const category = pick(layer.category);
    if (!category) return;
    const base = {
      id: `${layer.id}:${f._src ?? 0}:${f.id ?? i}`,
      layer,
      props,
      category,
      name: clean(pick(layer.name)) || layer.label,
      subtitle: clean(pick(layer.subtitle)),
      details: clean(pick(layer.details)) || layer.note || '',
      group: clean(pick(layer.group)) || null,
      maxAltitudeM: pick(layer.maxAltitudeM) ?? null,
      ceilingAmslM: pick(layer.ceilingAmslM) ?? null,
      color: pick(layer.color) ?? null,
    };
    if (geometry.type === 'Point') {
      const center = [geometry.coordinates[1], geometry.coordinates[0]];
      const radius = Number(pick(layer.radiusM)) || 0;
      out.push(radius > 0 ? { ...base, kind: 'circle', center, radius } : { ...base, kind: 'point', center });
    } else if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
      const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
      const rings = polygons
        .flat()
        .map((ring) => ring.map(([lon, lat]) => [lat, lon]))
        .filter((ring) => ring.length >= 3);
      if (rings.length) out.push({ ...base, kind: 'area', rings, bbox: ringsBBox(rings) });
    }
  });
  return out;
}

// Los mensajes oficiales traen HTML: se convierte a texto plano (nunca se inserta como HTML).
export function htmlToText(html) {
  if (!html) return '';
  const withBreaks = String(html).replace(/<\/p>|<br\s*\/?>/gi, '\n');
  const text = new DOMParser().parseFromString(withBreaks, 'text/html').body.textContent ?? '';
  return text.replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').trim();
}

// ---------- ED-269 (estándar europeo de zonas geográficas UAS) ----------

const ED269_TYPE = { PROHIBITED: 'prohibited', REQ_AUTHORIZATION: 'restricted', CONDITIONAL: 'caution' };
const ED269_TYPE_LABEL = { PROHIBITED: 'Prohibida', REQ_AUTHORIZATION: 'Requiere autorización', CONDITIONAL: 'Condicionada' };
const ED269_REASON = {
  AIR_TRAFFIC: 'Tráfico aéreo',
  SENSITIVE: 'Zona sensible',
  PRIVACY: 'Privacidad',
  POPULATION: 'Población',
  NATURE: 'Naturaleza',
  NOISE: 'Ruido',
  FOREIGN_TERRITORY: 'Territorio extranjero',
  EMERGENCY: 'Emergencia',
  OTHER: 'Otros',
};

const toMeters = (value, uom) => (String(uom).toUpperCase() === 'FT' ? value * 0.3048 : value);
const lowerM = (p) => toMeters(Number(p.lower) || 0, p.uom);

// Si la zona empieza por encima del suelo, por debajo de su límite inferior se puede volar.
function ed269Category(p) {
  const category = ED269_TYPE[p.type];
  if (!category) return null;
  return category !== 'caution' && lowerM(p) > 0 ? 'limited' : category;
}

export const ED269 = {
  category: ed269Category,
  maxAltitudeM: (p) => (ed269Category(p) === 'limited' && p.lowerReference !== 'AMSL' ? Math.round(lowerM(p)) : null),
  ceilingAmslM: (p) => (ed269Category(p) === 'limited' && p.lowerReference === 'AMSL' ? Math.round(lowerM(p)) : null),
  name: (p) => p.name,
  subtitle: (p) => {
    const unit = String(p.uom).toUpperCase() === 'FT' ? 'ft' : 'm';
    const reasons = String(p.reasons ?? '')
      .split(',')
      .map((r) => ED269_REASON[r.trim()])
      .filter(Boolean)
      .join(', ');
    return [ED269_TYPE_LABEL[p.type], reasons, `${p.lower ?? 0}–${p.upper} ${unit} ${p.upperReference ?? ''}`.trim()]
      .filter(Boolean)
      .join(' · ');
  },
  details: (p) => htmlToText(p.message),
};

// Zonas que el usuario importa desde un archivo GeoJSON propio.
export const CUSTOM_LAYER = {
  id: 'custom',
  label: 'Zonas importadas',
  legendCategory: 'restricted',
  legend: 'GeoJSON propio',
  category: (p) => (CATEGORIES.includes(p.category) ? p.category : 'restricted'),
  name: (p) => p.name ?? p.nombre,
  details: (p) => p.note ?? p.nota ?? p.description ?? p.descripcion,
  radiusM: (p) => p.radius_m ?? p.radio_m ?? 500,
  maxAltitudeM: (p) => p.max_altitude_m ?? p.altura_max_m ?? null,
};
