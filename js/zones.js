// Almacén de zonas de un país y evaluación de un punto contra ellas.
//
// Las capas pequeñas se cargan completas al elegir el país. Las grandes (source.tiled)
// se piden por teselas: las de la zona visible y la del punto consultado.

import { haversine, pointInRings, distanceToRings, bboxContains } from './geo.js';
import { fetchSource, geojsonToFeatures } from './sources.js';

export const SEVERITY = { ok: 0, caution: 1, limited: 2, restricted: 3, prohibited: 4 };

const MAX_PARALLEL_TILES = 4;
const isTiled = (layer) => Boolean(layer.source.tiled);

export class ZoneStore extends EventTarget {
  constructor(country) {
    super();
    this.country = country;
    this.features = new Map();
    this.counts = new Map(); // id de capa -> nº de elementos
    this.status = new Map(); // id de capa -> { state: 'loading' | 'ok' | 'error', count, error?, tiled? }
    this.tiles = new Map(); // 'capa/i:j' -> { done, promise }
    this.tileState = new Map(); // id de capa -> { pending, error }
    this.queue = [];
    this.running = 0;
    this.loadedAt = null;
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }

  get loading() {
    return [...this.status.values()].some((s) => s.state === 'loading');
  }

  get loadingRequired() {
    return this.country.layers.some((l) => !l.optional && this.status.get(l.id)?.state === 'loading');
  }

  // Capas obligatorias que fallaron: sin ellas no se puede dar luz verde.
  get failed() {
    return this.country.layers.some((l) => !l.optional && this.status.get(l.id)?.state === 'error');
  }

  get failedOptional() {
    return this.country.layers.filter((l) => l.optional && this.status.get(l.id)?.state === 'error');
  }

  recount() {
    this.counts.clear();
    for (const f of this.features.values()) this.counts.set(f.layer.id, (this.counts.get(f.layer.id) ?? 0) + 1);
  }

  replace(predicate, list) {
    for (const [id, f] of this.features) if (predicate(f)) this.features.delete(id);
    for (const f of list) this.features.set(f.id, f);
    this.changed();
  }

  // Un mismo elemento puede llegar en varias teselas: se conserva el primero.
  add(list) {
    for (const f of list) if (!this.features.has(f.id)) this.features.set(f.id, f);
    this.changed();
  }

  changed() {
    this.country.enrich?.(this.features);
    this.recount();
    this.emit('change');
  }

  loadAll() {
    for (const layer of this.country.layers.filter(isTiled)) this.status.set(layer.id, { state: 'ok', count: 0, tiled: true });
    return Promise.all(this.country.layers.filter((l) => !isTiled(l)).map((layer) => this.loadLayer(layer)));
  }

  async loadLayer(layer) {
    // Las teselas fallidas ya se descartaron: basta con volver a pedir las visibles.
    if (isTiled(layer)) {
      const state = this.tileState.get(layer.id);
      if (state) state.error = null;
      this.updateTiledStatus(layer);
      this.emit('retry');
      return;
    }
    this.status.set(layer.id, { state: 'loading' });
    this.emit('status');
    try {
      const features = await this.fetchLayer(layer);
      this.replace((f) => f.layer.id === layer.id, features);
      this.status.set(layer.id, { state: 'ok', count: features.length, fallback: features.fallback });
      this.loadedAt = new Date();
    } catch (err) {
      this.status.set(layer.id, { state: 'error', error: err.message });
    }
    this.emit('status');
  }

  // Si la fuente principal falla y la capa define `fallback`, se usa la copia alternativa
  // traduciendo sus campos a los de la principal.
  async fetchLayer(layer) {
    try {
      return geojsonToFeatures(await fetchSource(layer.source), layer);
    } catch (err) {
      if (!layer.fallback) throw err;
      const collection = await fetchSource(layer.fallback.source);
      for (const f of collection.features) f.properties = layer.fallback.normalize(f.properties ?? {});
      const features = geojsonToFeatures(collection, layer);
      features.fallback = layer.fallback.label;
      return features;
    }
  }

  setCustom(features) {
    this.replace((f) => f.layer.id === 'custom', features);
    this.status.set('custom', { state: 'ok', count: features.length });
    this.emit('status');
  }

  // ---------- Teselas ----------

  tileKey(layer, lat, lon) {
    const d = layer.source.tiled.tileDeg;
    return `${Math.floor(lat / d)}:${Math.floor(lon / d)}`;
  }

  // Carga las teselas visibles. Devuelve las capas omitidas por falta de zoom.
  loadView([s, w, n, e], zoom) {
    const [[cs, cw], [cn, ce]] = this.country.bounds;
    s = Math.max(s, cs);
    w = Math.max(w, cw);
    n = Math.min(n, cn);
    e = Math.min(e, ce);
    const skipped = [];
    if (s > n || w > e) return skipped;
    for (const layer of this.country.layers.filter(isTiled)) {
      const { tileDeg: d, minZoom, maxTiles = 30 } = layer.source.tiled;
      const rows = Math.floor(n / d) - Math.floor(s / d) + 1;
      const cols = Math.floor(e / d) - Math.floor(w / d) + 1;
      if (zoom < minZoom || rows * cols > maxTiles) {
        skipped.push(layer);
        continue;
      }
      for (let i = Math.floor(s / d); i <= Math.floor(n / d); i++) {
        for (let j = Math.floor(w / d); j <= Math.floor(e / d); j++) this.loadTile(layer, `${i}:${j}`);
      }
    }
    return skipped;
  }

  // El punto consultado siempre necesita sus teselas, sin importar el zoom.
  loadAt([lat, lon]) {
    if (!this.inCountry([lat, lon])) return;
    for (const layer of this.country.layers.filter(isTiled)) this.loadTile(layer, this.tileKey(layer, lat, lon));
  }

  // optional: true para preguntar por las capas opcionales (p. ej. DJI) en vez de las obligatorias.
  isComplete([lat, lon], { optional = false } = {}) {
    if (!this.inCountry([lat, lon])) return true;
    return this.country.layers
      .filter((layer) => isTiled(layer) && Boolean(layer.optional) === optional)
      .every((layer) => this.tiles.get(`${layer.id}/${this.tileKey(layer, lat, lon)}`)?.done);
  }

  // Descarta todo lo cargado de una capa (p. ej. al cambiar de modelo de dron) y avisa para recargarla.
  resetLayer(layerId) {
    for (const key of [...this.tiles.keys()]) if (key.startsWith(`${layerId}/`)) this.tiles.delete(key);
    this.tileState.set(layerId, { pending: 0, error: null });
    this.replace((f) => f.layer.id === layerId, []);
    const layer = this.country.layers.find((l) => l.id === layerId);
    if (layer) this.updateTiledStatus(layer);
    this.emit('retry');
  }

  loadTile(layer, key) {
    const id = `${layer.id}/${key}`;
    if (this.tiles.has(id)) return;
    const entry = { done: false };
    this.tiles.set(id, entry);
    const state = this.tileState.get(layer.id) ?? { pending: 0, error: null };
    this.tileState.set(layer.id, state);
    state.pending++;
    this.updateTiledStatus(layer);

    const [i, j] = key.split(':').map(Number);
    const d = layer.source.tiled.tileDeg;
    this.enqueue(async () => {
      try {
        const collection = await fetchSource(layer.source, { bbox: [i * d, j * d, (i + 1) * d, (j + 1) * d] });
        entry.done = true;
        state.error = null;
        this.add(geojsonToFeatures(collection, layer));
        this.loadedAt = new Date();
      } catch (err) {
        this.tiles.delete(id); // se reintenta en el próximo movimiento del mapa
        state.error = err.message;
      } finally {
        state.pending--;
        this.updateTiledStatus(layer);
      }
    });
  }

  updateTiledStatus(layer) {
    const state = this.tileState.get(layer.id) ?? { pending: 0, error: null };
    const count = this.counts.get(layer.id) ?? 0;
    this.status.set(layer.id, {
      state: state.pending > 0 ? 'loading' : state.error ? 'error' : 'ok',
      error: state.error,
      count,
      tiled: true,
    });
    this.emit('status');
  }

  enqueue(task) {
    this.queue.push(task);
    this.drain();
  }

  drain() {
    while (this.running < MAX_PARALLEL_TILES && this.queue.length) {
      const task = this.queue.shift();
      this.running++;
      task().finally(() => {
        this.running--;
        this.drain();
      });
    }
  }

  // ---------- Evaluación ----------

  inCountry([lat, lon]) {
    const [[s, w], [n, e]] = this.country.bounds;
    return lat >= s && lat <= n && lon >= w && lon <= e;
  }

  // terrainM: elevación del terreno en el punto (m s.n.m.), si se conoce.
  evaluate(pt, { terrainM = null } = {}) {
    const margin = this.country.cautionMarginM ?? 500;
    const severity = (h) => SEVERITY[h.feature.category];
    let hits = [];
    const djiHits = [];

    for (const f of this.features.values()) {
      if (f.kind === 'point') continue;
      // Las zonas de DJI no son normativa: se informan aparte y no cambian el nivel.
      const dji = Boolean(f.layer.dji);
      if (!dji && !(f.category in SEVERITY)) continue;
      const place = locate(f, pt, dji ? 0 : margin);
      if (!place) continue;
      if (dji) {
        if (place.inside) djiHits.push(f);
      } else if (place.inside || place.distance <= margin) hits.push({ feature: f, ...place });
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

    // Zonas repetidas (p. ej. celdas contiguas de una rejilla) se muestran una sola vez;
    // por el orden anterior se conserva la que contiene el punto o la más cercana.
    const seen = new Set();
    hits = hits.filter((h) => {
      const key = `${h.feature.layer.id}|${h.feature.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    let level = 'ok';
    let maxAltitudeM = this.country.maxAltitudeM;
    for (const h of hits) {
      const hitLevel = h.inside ? h.feature.category : severity(h) >= SEVERITY.limited ? 'caution' : null;
      if (hitLevel && SEVERITY[hitLevel] > SEVERITY[level]) level = hitLevel;
      if (!h.inside) continue;
      if (h.feature.maxAltitudeM != null) maxAltitudeM = Math.min(maxAltitudeM, h.feature.maxAltitudeM);
      if (h.feature.ceilingAmslM != null && terrainM != null) {
        h.ceilingAglM = Math.round(h.feature.ceilingAmslM - terrainM);
        maxAltitudeM = Math.min(maxAltitudeM, h.ceilingAglM);
      }
    }

    // El terreno ya supera el techo permitido: no hay altura disponible sin autorización.
    const noHeadroom = maxAltitudeM <= 0;
    if (noHeadroom && SEVERITY[level] < SEVERITY.restricted) level = 'restricted';

    return {
      level,
      hits,
      maxAltitudeM: Math.max(0, maxAltitudeM),
      noHeadroom,
      outside: !this.inCountry(pt),
      complete: this.isComplete(pt),
      dji: { hits: djiHits, complete: this.isComplete(pt, { optional: true }) },
    };
  }
}

// ¿El punto está dentro de la zona, o a qué distancia de su borde? null si queda lejos.
function locate(f, pt, margin) {
  if (f.kind === 'circle') {
    const edge = haversine(pt, f.center) - f.radius;
    return { inside: edge <= 0, distance: Math.max(0, edge) };
  }
  if (!bboxContains(f.bbox, pt, margin)) return null;
  const inside = pointInRings(pt, f.rings);
  return { inside, distance: inside ? 0 : distanceToRings(pt, f.rings) };
}
