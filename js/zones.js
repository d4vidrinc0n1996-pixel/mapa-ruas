// Almacén de zonas de un país y evaluación de un punto contra ellas.

import { haversine, pointInRings, distanceToRings, bboxContains } from './geo.js';
import { fetchSource, geojsonToFeatures } from './sources.js';

export const SEVERITY = { ok: 0, caution: 1, limited: 2, restricted: 3, prohibited: 4 };

export class ZoneStore extends EventTarget {
  constructor(country) {
    super();
    this.country = country;
    this.features = new Map();
    this.status = new Map(); // id de capa -> { state: 'loading' | 'ok' | 'error', count?, error? }
    this.loadedAt = null;
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }

  get loading() {
    return [...this.status.values()].some((s) => s.state === 'loading');
  }

  get failed() {
    return [...this.status.values()].some((s) => s.state === 'error');
  }

  replace(predicate, list) {
    for (const [id, f] of this.features) if (predicate(f)) this.features.delete(id);
    for (const f of list) this.features.set(f.id, f);
    this.country.enrich?.(this.features);
    this.emit('change');
  }

  loadAll() {
    return Promise.all(this.country.layers.map((layer) => this.loadLayer(layer)));
  }

  async loadLayer(layer) {
    this.status.set(layer.id, { state: 'loading' });
    this.emit('status');
    try {
      const collection = await fetchSource(layer.source);
      const features = geojsonToFeatures(collection, layer);
      this.replace((f) => f.layer.id === layer.id, features);
      this.status.set(layer.id, { state: 'ok', count: features.length });
      this.loadedAt = new Date();
    } catch (err) {
      this.status.set(layer.id, { state: 'error', error: err.message });
    }
    this.emit('status');
  }

  setCustom(features) {
    this.replace((f) => f.layer.id === 'custom', features);
    this.status.set('custom', { state: 'ok', count: features.length });
    this.emit('status');
  }

  inCountry([lat, lon]) {
    const [[s, w], [n, e]] = this.country.bounds;
    return lat >= s && lat <= n && lon >= w && lon <= e;
  }

  evaluate(pt) {
    const margin = this.country.cautionMarginM ?? 500;
    const severity = (h) => SEVERITY[h.feature.category];
    let hits = [];

    for (const f of this.features.values()) {
      if (f.kind === 'point' || !(f.category in SEVERITY)) continue;
      let inside;
      let distance;
      if (f.kind === 'circle') {
        const edge = haversine(pt, f.center) - f.radius;
        inside = edge <= 0;
        distance = Math.max(0, edge);
      } else {
        if (!bboxContains(f.bbox, pt, margin)) continue;
        inside = pointInRings(pt, f.rings);
        distance = inside ? 0 : distanceToRings(pt, f.rings);
      }
      if (inside || distance <= margin) hits.push({ feature: f, inside, distance });
    }

    // Dentro de varias zonas del mismo grupo (p. ej. 6 y 9 km de un aeropuerto) sólo cuenta la más severa.
    const strongest = new Map();
    for (const h of hits) {
      if (!h.inside || !h.feature.group) continue;
      const current = strongest.get(h.feature.group);
      if (!current || severity(h) > severity(current)) strongest.set(h.feature.group, h);
    }
    hits = hits.filter((h) => !h.inside || !h.feature.group || strongest.get(h.feature.group) === h);
    hits.sort((a, b) => b.inside - a.inside || severity(b) - severity(a) || a.distance - b.distance);

    let level = 'ok';
    let maxAltitudeM = this.country.maxAltitudeM;
    for (const h of hits) {
      const hitLevel = h.inside ? h.feature.category : severity(h) >= SEVERITY.limited ? 'caution' : null;
      if (hitLevel && SEVERITY[hitLevel] > SEVERITY[level]) level = hitLevel;
      if (h.inside && h.feature.maxAltitudeM != null) maxAltitudeM = Math.min(maxAltitudeM, h.feature.maxAltitudeM);
    }

    return { level, hits, maxAltitudeM, outside: !this.inCountry(pt) };
  }
}
