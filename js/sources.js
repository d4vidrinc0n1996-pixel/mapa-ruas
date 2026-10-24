// Carga de capas de zonas y conversión a "features" internos.
//
// Una capa (definida en el módulo de cada país) describe:
//   source:   { type: 'arcgis' | 'geojson', url: string | string[], simplify? }
//   category: 'prohibited' | 'restricted' | 'limited' | 'caution' | 'info'  (o función de las propiedades)
//   name, subtitle, details, group, maxAltitudeM, radiusM: valor o función (props) => valor

import { ringsBBox } from './geo.js';

export const CATEGORIES = ['prohibited', 'restricted', 'limited', 'caution'];

// Tolerancia de simplificación en grados (~3 m): algunas capas oficiales traen
// círculos con miles de vértices y pesan decenas de MB sin simplificar.
const DEFAULT_SIMPLIFY = 0.00003;

export async function fetchSource(source, { signal } = {}) {
  const urls = [].concat(source.url);
  const parts = await Promise.all(
    urls.map((url) => (source.type === 'arcgis' ? fetchArcgis(url, source, signal) : fetchJson(url, signal))),
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

// Consulta paginada a un FeatureServer de ArcGIS, devolviendo GeoJSON en WGS84.
async function fetchArcgis(layerUrl, source, signal) {
  const pageSize = source.pageSize ?? 2000;
  const features = [];
  for (let offset = 0; ; offset += pageSize) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: '*',
      outSR: '4326',
      f: 'geojson',
      geometryPrecision: '6',
      maxAllowableOffset: String(source.simplify ?? DEFAULT_SIMPLIFY),
      orderByFields: 'OBJECTID',
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
    });
    const page = await fetchJson(`${layerUrl}/query?${params}`, signal);
    if (page.error) throw new Error(page.error.message ?? 'Error del servicio ArcGIS');
    const batch = page.features ?? [];
    features.push(...batch);
    if (!page.properties?.exceededTransferLimit || batch.length === 0) break;
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
    const base = {
      id: `${layer.id}:${f._src ?? 0}:${f.id ?? i}`,
      layer,
      props,
      category: pick(layer.category),
      name: clean(pick(layer.name)) || layer.label,
      subtitle: clean(pick(layer.subtitle)),
      details: clean(pick(layer.details)) || layer.note || '',
      group: clean(pick(layer.group)) || null,
      maxAltitudeM: pick(layer.maxAltitudeM) ?? null,
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
