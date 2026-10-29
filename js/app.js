import { COUNTRIES, loadCountry, countryAt } from './countries/index.js';
import { ZoneStore } from './zones.js';
import { ZoneRenderer, COLORS } from './render.js';
import { GpsTracker } from './gps.js';
import { CUSTOM_LAYER, geojsonToFeatures } from './sources.js';
import { BASEMAPS, PROVIDERS, createBaseLayers, getKeys, saveKeys } from './basemaps.js';
import { fetchWeather, fetchElevation, fetchElevations, fetchKp, assess, describeWeather, kpLabel } from './conditions.js';
import { PoiLayer, POI_TYPES, STATUS_COLORS, poiName } from './pois.js';
import { DJI_LAYER, djiLevel, fetchDrones, getDrone, setDrone } from './dji.js';
import { arcgisCapabilities, validateArcgisKey, arcgisGeocode, arcgisElevation, arcgisElevations } from './arcgis.js';
import { OVERLAYS } from './overlays.js';
import { storage } from './storage.js';
import { haversine, formatDistance, formatCoord } from './geo.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

const CATEGORY_LABEL = {
  prohibited: 'Prohibido',
  restricted: 'Requiere autorización',
  limited: 'Altura limitada',
  caution: 'Precaución',
  info: 'Referencia',
};

const LEVELS = {
  prohibited: {
    icon: '✕',
    title: 'Vuelo prohibido',
    text: () => 'No vueles aquí sin autorización expresa: zona de no vuelo o restricción para UAS.',
  },
  restricted: {
    icon: '!',
    title: 'Requiere autorización',
    text: () => 'Necesitas autorización o coordinación previa con la autoridad responsable del área.',
  },
  limited: {
    icon: '↧',
    title: 'Altura limitada',
    text: (r) => `Puedes volar sin superar ${r.maxAltitudeM} m sobre el terreno. Revisa las condiciones de la zona.`,
  },
  caution: {
    icon: '!',
    title: 'Precaución',
    text: (r, c) => `Estás dentro o a menos de ${formatDistance(c.cautionMarginM)} de una zona con condiciones. Revisa el detalle.`,
  },
  ok: {
    icon: '✓',
    title: 'Sin restricciones conocidas',
    text: (r, c) => `Puedes volar en categoría abierta respetando las reglas generales (máx. ${c.maxAltitudeM} m).`,
  },
  // Nunca se da luz verde si faltan capas: la ausencia de datos no significa ausencia de zonas.
  unknown: {
    icon: '?',
    title: 'Datos incompletos',
    text: () =>
      'Todavía no se han cargado todas las zonas de este punto y alguna podría ser más estricta. No asumas que puedes volar.',
  },
};

const VERDICT = {
  good: { icon: '✓', title: 'Buenas condiciones' },
  caution: { icon: '!', title: 'Vuela con precaución' },
  bad: { icon: '✕', title: 'No recomendable volar ahora' },
};

const state = {
  country: null,
  zones: null,
  gps: null, // última posición
  following: false,
  picked: null, // [lat, lon] tocado en el mapa
  poi: null, // propiedades del sitio de interés seleccionado
  base: storage.get('baseLayer') ?? 'claro',
  keys: getKeys(),
  hidden: new Set(storage.getJSON('hiddenLayers') ?? []),
  hiddenPois: new Set(storage.getJSON('hiddenPois') ?? []),
  hideBlockedPois: storage.get('hideBlockedPois') === '1',
  nearbyFlyable: storage.get('nearbyFlyable') === '1',
  djiDrones: [],
};

let poiLayers = [];

// Condiciones del punto consultado; se reutilizan mientras el punto no se aleje.
const cond = {
  weather: null,
  weatherPoint: null,
  weatherAt: 0,
  weatherError: null,
  terrainM: null,
  terrainPoint: null,
  kp: null,
  kpAt: 0,
  busy: new Set(),
};

// ---------- Mapa ----------
const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([4.6, -74.1], 6);
L.control.zoom({ position: 'topright' }).addTo(map);
L.control.scale({ imperial: false, position: 'topleft' }).addTo(map);
map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
// Orden: mapa base < nubes/lluvia (350) < zonas (401+) < flechas de viento (445) < sitios (450).
map.createPane('weather').style.zIndex = '350';
map.createPane('wind').style.zIndex = '445';
map.getPane('wind').style.pointerEvents = 'none';
map.createPane('pois').style.zIndex = '450';

let baseLayers = [];
async function setBaseLayer(id) {
  try {
    const layers = await createBaseLayers(id, state.keys, { region: state.country?.code ?? 'CO' });
    baseLayers.forEach((l) => l.remove());
    baseLayers = layers;
    let warned = false;
    for (const layer of layers) {
      layer.addTo(map);
      // Una clave inválida o sin permisos devuelve errores en todas las teselas.
      if (BASEMAPS[id].needs) {
        layer.on('tileerror', () => {
          if (warned) return;
          warned = true;
          toast(`${PROVIDERS[BASEMAPS[id].needs].label} rechazó la petición: revisa la clave y sus restricciones.`);
        });
      }
    }
    state.base = id;
    storage.set('baseLayer', id);
  } catch (err) {
    toast(err.message);
    if (!baseLayers.length && id !== 'claro') return setBaseLayer('claro');
  }
  renderBaseChips();
}

const renderer = new ZoneRenderer(map, state.hidden);

const pickMarker = L.marker([0, 0], {
  icon: L.divIcon({ className: 'pick-marker', html: '<span></span>', iconSize: [26, 26], iconAnchor: [13, 30] }),
  interactive: false,
  keyboard: false,
});
const gpsMarker = L.marker([0, 0], {
  icon: L.divIcon({ className: 'gps-marker', html: '<div class="gps-cone"></div><div class="gps-dot"></div>', iconSize: [72, 72] }),
  interactive: false,
  keyboard: false,
  zIndexOffset: 1000,
});
const accuracyCircle = L.circle([0, 0], { radius: 1, color: '#2563eb', weight: 1, fillOpacity: 0.08, interactive: false });

map.on('click', (e) => {
  if (closePanels()) return;
  pickPoint([e.latlng.lat, e.latlng.lng]);
});
map.on('dragstart', () => {
  if (!state.following) return;
  state.following = false;
  updateLocateButton();
});
map.on('moveend', debounce(loadVisible, 300));

function loadVisible() {
  const zones = state.zones;
  if (!zones) return;
  const b = map.getBounds();
  const skipped = zones.loadView([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()], map.getZoom());
  const visibleSkipped = skipped.filter((l) => !state.hidden.has(l.id));
  const hint = $('#zoom-hint');
  hint.hidden = !visibleSkipped.length || !zones.inCountry([map.getCenter().lat, map.getCenter().lng]);
  hint.textContent = `Acerca el mapa para ver: ${visibleSkipped.map((l) => l.label.toLowerCase()).join(', ')}`;
}

// ---------- País ----------
async function switchCountry(code) {
  // Las zonas de DJI son globales: se añaden como capa opcional a cualquier país.
  const base = await loadCountry(code);
  const country = { ...base, layers: [...base.layers, DJI_LAYER] };
  state.country = country;
  storage.set('country', country.code);
  $('#country').value = country.code;

  renderer.clear();
  renderer.setLayerOrder([...country.layers, CUSTOM_LAYER]);
  const zones = new ZoneStore(country);
  state.zones = zones;
  zones.addEventListener('change', () => {
    if (zones !== state.zones) return;
    renderer.sync(zones.features);
    renderStatus();
    schedulePoiStatus();
  });
  zones.addEventListener('status', () => {
    if (zones !== state.zones) return;
    $('#busy').hidden = !zones.loading;
    renderLayersPanel();
    renderStatus();
    schedulePoiStatus();
  });
  zones.addEventListener('retry', () => {
    loadVisible();
    const s = subject();
    if (s) zones.loadAt(s.point);
  });

  const custom = storage.getJSON(`custom:${country.code}`);
  if (custom) zones.setCustom(geojsonToFeatures(custom, CUSTOM_LAYER));

  poiLayers.forEach((p) => p.destroy());
  poiLayers = (country.pois ?? []).map((def) => {
    const layer = new PoiLayer(map, def, { onSelect: selectPoi });
    layer.visible = !state.hiddenPois.has(def.id);
    layer.hideBlocked = state.hideBlockedPois;
    layer
      .load()
      .then(() => {
        schedulePoiStatus();
        renderLayersPanel();
      })
      .catch(() => toast(`No se pudieron cargar: ${def.label}`));
    return layer;
  });

  renderInfoPanel();
  renderLayersPanel();
  const s = subject();
  if (s && zones.inCountry(s.point)) zones.loadAt(s.point);
  else if (!state.following) map.setView(country.center, country.zoom);
  renderStatus();
  loadVisible();

  await zones.loadAll();
  const failed = country.layers.filter((l) => zones.status.get(l.id)?.state === 'error');
  if (failed.length) toast(`No se pudieron cargar ${failed.length} capa(s). Revisa tu conexión.`);
}

// ---------- Punto consultado ----------
function subject() {
  if (state.picked) return { point: state.picked, kind: 'picked' };
  if (state.gps) return { point: [state.gps.lat, state.gps.lon], kind: 'gps' };
  return null;
}

function subjectChanged() {
  const s = subject();
  if (s) state.zones?.loadAt(s.point);
  refreshConditions();
  renderStatus();
}

// Si faltan capas obligatorias, una zona aún no cargada podría ser más estricta: sólo
// «prohibido» es definitivo (nada lo empeora); cualquier otro nivel se muestra como incompleto.
function displayLevel(r, zones) {
  const incomplete = !r.outside && (!r.complete || zones.loadingRequired || zones.failed);
  return incomplete && r.level !== 'prohibited' ? 'unknown' : r.level;
}

// Estado de vuelo de un sitio. Si ya se conoce la elevación de su terreno se usa para
// los techos absolutos (p. ej. 61 m sobre el aeropuerto), igual que en la ficha.
function poiLevel(item) {
  const zones = state.zones;
  const r = zones.evaluate(item.point, { terrainM: item.terrainM ?? null });
  if (!r.noHeadroom) item.needsTerrain = r.hits.some((h) => h.inside && h.feature.ceilingAmslM != null);
  return r.outside ? 'unknown' : displayLevel(r, zones);
}

// Recalcular el estado de miles de sitios es costoso: se agrupan los cambios de zonas.
const schedulePoiStatus = debounce(() => {
  if (!state.zones) return;
  poiLayers.forEach((layer) => layer.setStatus(poiLevel));
  renderNearby();
}, 400);

// Elevación del terreno: ArcGIS si la clave tiene ese servicio (mejor resolución); si no,
// o si falla, Open-Meteo (modelo de 90 m).
const arcgis = () => ({ key: state.keys.arcgis, caps: arcgisCapabilities(state.keys.arcgis) });

async function fetchTerrain(point) {
  const { key, caps } = arcgis();
  if (caps.elevation) {
    try {
      return { value: await arcgisElevation(point, key), source: 'ArcGIS' };
    } catch {
      /* se usa Open-Meteo */
    }
  }
  return { value: await fetchElevation(point), source: 'Open-Meteo' };
}

async function fetchTerrainMany(points) {
  const { key, caps } = arcgis();
  if (caps.elevation) {
    try {
      return await arcgisElevations(points, key);
    } catch {
      /* se usa Open-Meteo */
    }
  }
  return fetchElevations(points);
}

// Pide la elevación de los sitios listados que dependen de ella y los reevalúa.
let terrainPending = false;
async function refineNearbyTerrain(entries) {
  const missing = entries.filter(({ item }) => item.needsTerrain && item.terrainM === undefined);
  if (!missing.length || terrainPending) return;
  terrainPending = true;
  try {
    const elevations = await fetchTerrainMany(missing.map(({ item }) => item.point));
    missing.forEach(({ item }, i) => (item.terrainM = elevations[i] ?? null));
    for (const layer of poiLayers) for (const { item } of missing) if (layer.items.includes(item)) layer.setLevel(item, poiLevel(item));
  } catch {
    // Sin elevación se mantiene el estado calculado con la altura fija, sin reintentar en bucle.
    missing.forEach(({ item }) => (item.terrainM = null));
  } finally {
    terrainPending = false;
  }
  renderNearby();
}

function selectPoi(item, def) {
  closePanels();
  pickPoint(item.point, { ...item.props, source: def.label });
}

function pickPoint(point, poi = null) {
  state.picked = point;
  state.poi = poi;
  state.following = false;
  pickMarker.setLatLng(point).addTo(map);
  $('#sheet').classList.add('open');
  updateLocateButton();
  subjectChanged();
}

function clearPicked() {
  state.picked = null;
  state.poi = null;
  pickMarker.remove();
  subjectChanged();
}

function terrainAt(point) {
  return cond.terrainPoint && haversine(cond.terrainPoint, point) < 150 ? cond.terrainM : null;
}

function renderStatus() {
  const card = $('#status');
  const s = subject();
  const zones = state.zones;
  const c = state.country;

  if (c) $('#rules-line').textContent = `Altura máx. ${c.maxAltitudeM} m sobre el terreno · Siempre con línea de vista · Consulta NOTAM`;

  if (!s || !zones) {
    card.dataset.level = 'idle';
    card.innerHTML = `<div class="badge">⌖</div><div class="status-text"><h2>Consulta una zona</h2><p>Activa el GPS o toca un punto del mapa.</p></div>`;
    $('#hits').innerHTML = '';
    delete $('#hits').dataset.html;
    renderConditions();
    renderGps();
    return;
  }

  const terrainM = terrainAt(s.point);
  const r = zones.evaluate(s.point, { terrainM });
  const levelKey = displayLevel(r, zones);
  const level = LEVELS[levelKey];
  const where =
    s.kind === 'gps'
      ? `Tu ubicación · precisión ±${Math.round(state.gps.accuracy)} m`
      : `${state.poi ? 'Sitio de interés' : 'Punto seleccionado'} · ${formatCoord(...s.point)}`;
  card.dataset.level = levelKey;
  card.innerHTML = `
    <div class="badge">${level.icon}</div>
    <div class="status-text"><h2>${level.title}</h2><p>${esc(where)}</p></div>
    ${s.kind === 'picked' ? '<button class="icon-btn" data-action="clear-pick" aria-label="Quitar punto">✕</button>' : ''}`;

  const notes = [];
  if (r.outside) {
    const other = countryAt(s.point, c.code);
    notes.push(
      `<p class="note warn">Este punto está fuera de ${esc(c.name)}: las zonas cargadas no aplican aquí.
      ${other ? `<button class="link" type="button" data-action="switch-country" data-code="${other.code}">Cambiar a ${esc(other.name)}</button>` : ''}</p>`,
    );
  }
  if (!r.complete) notes.push('<p class="note">Cargando las zonas de esta área… el resultado puede cambiar.</p>');
  else if (zones.loading) notes.push('<p class="note">Cargando capas oficiales… el resultado puede cambiar.</p>');
  else if (zones.failed) notes.push('<p class="note warn">Algunas capas no se cargaron: el resultado puede estar incompleto. Revisa el panel de capas.</p>');
  // DJI tiene su propio aviso en la ficha.
  const optionalFailed = zones.failedOptional.filter((l) => !l.dji);
  if (optionalFailed.length) {
    notes.push(
      `<p class="note">No se pudo cargar: ${esc(optionalFailed.map((l) => l.label.toLowerCase()).join(', '))}. Consulta también a la autoridad ambiental de la zona.</p>`,
    );
  }
  if (r.noHeadroom) {
    notes.push(
      `<p class="note warn">El terreno aquí (${Math.round(terrainM)} m s.n.m.) ya supera el techo permitido: cualquier vuelo requiere autorización.</p>`,
    );
  } else if (terrainM == null && r.hits.some((h) => h.inside && h.feature.ceilingAmslM != null)) {
    notes.push('<p class="note">Consultando la elevación del terreno para calcular la altura máxima real…</p>');
  }
  if (s.kind === 'gps' && state.gps.accuracy > 100) {
    notes.push(`<p class="note warn">Precisión GPS baja (±${Math.round(state.gps.accuracy)} m). Espera a tener mejor señal.</p>`);
  }

  // Con el GPS activo esto se repite cada segundo: sólo se reemplaza si cambió y se
  // conservan abiertas las observaciones que el usuario esté leyendo.
  const hitsEl = $('#hits');
  const html = `
    ${s.kind === 'picked' && state.poi ? poiHtml(state.poi) : ''}
    <p class="level-text">${esc(level.text(r, c))}</p>
    ${notes.join('')}
    ${r.hits.length ? `<ul class="hit-list">${r.hits.map(hitHtml).join('')}</ul>` : ''}
    ${djiHtml(r)}`;
  if (html !== hitsEl.dataset.html) {
    const open = new Set([...hitsEl.querySelectorAll('details[open]')].map((d) => d.dataset.id));
    hitsEl.innerHTML = html;
    hitsEl.dataset.html = html;
    hitsEl.querySelectorAll('details').forEach((d) => (d.open = open.has(d.dataset.id)));
  }
  renderConditions();
  renderGps();
}

function poiHtml(poi) {
  const type = POI_TYPES[poi.type];
  const meta = [type?.label, poi.department, poi.ele != null ? `${poi.ele.toLocaleString('es')} m s.n.m.` : null, poi.source];
  const [osmType, osmId] = (poi.osm ?? '').split('/');
  return `
    <div class="poi-card">
      <span class="poi-emoji">${type?.emoji ?? '📍'}</span>
      <div>
        <strong>${esc(poiName(poi))}</strong>
        <small>${esc(meta.filter(Boolean).join(' · '))}</small>
        ${poi.description ? `<p>${esc(poi.description)}</p>` : ''}
        ${poi.tip ? `<p class="tip">💡 ${esc(poi.tip)}</p>` : ''}
        ${osmId ? `<a class="small" href="https://www.openstreetmap.org/${esc(osmType)}/${esc(osmId)}" target="_blank" rel="noopener">Ver en OpenStreetMap</a>` : ''}
      </div>
    </div>`;
}

// Qué hará un dron DJI en el punto, según su geovalla. Va aparte de la normativa.
function djiHtml(r) {
  if (r.outside) return '';
  const drone = state.djiDrones.find((d) => d.slug === getDrone())?.name ?? getDrone();
  const status = state.zones.status.get('dji');
  let body;
  if (r.dji.hits.length) {
    // Una fila por tipo de zona, de la más a la menos restrictiva.
    const rank = (f) => ({ 2: 5, 7: 5, 1: 4, 10: 3, 3: 2, 0: 1 })[f.props.level] ?? 0;
    const byLabel = new Map();
    for (const f of [...r.dji.hits].sort((a, b) => rank(b) - rank(a))) {
      const info = djiLevel(f.props);
      if (!byLabel.has(info.label)) byLabel.set(info.label, { info, f, names: new Set() });
      byLabel.get(info.label).names.add(f.name);
    }
    body = `<ul class="dji-list">${[...byLabel.values()]
      .map(
        ({ info, f, names }) => `
          <li>
            <span class="swatch" style="--c:${info.color}"></span>
            <div>
              <strong>${esc(info.label)}</strong>
              <small>${esc([...names].join(' · '))}</small>
              <p>${esc(info.effect(f.props.height))}</p>
            </div>
          </li>`,
      )
      .join('')}</ul>`;
  } else if (!r.dji.complete || status?.state === 'loading') {
    body = '<p class="muted small">Consultando zonas de DJI…</p>';
  } else if (status?.state === 'error') {
    body = '<p class="muted small">No se pudieron consultar las zonas de DJI.</p>';
  } else {
    body = '<p class="small">Sin zonas GEO de DJI: el dron no debería mostrar avisos ni bloqueos aquí.</p>';
  }
  return `
    <div class="dji-box">
      <h3>Tu dron DJI <small>${esc(drone)}</small></h3>
      ${body}
      <p class="muted small">Límites del fabricante según DJI FlySafe (no oficial). No reemplazan la normativa.</p>
    </div>`;
}

function hitHtml(h) {
  const f = h.feature;
  const where = h.inside ? 'Dentro de la zona' : `A ${formatDistance(h.distance)} del límite`;
  let altitude = '';
  if (h.inside && h.ceilingAglM != null) altitude = ` · máx. ${Math.max(0, h.ceilingAglM)} m aquí`;
  else if (h.inside && f.maxAltitudeM != null) altitude = ` · máx. ${Math.min(f.maxAltitudeM, state.country.maxAltitudeM)} m`;
  else if (h.inside && f.ceilingAmslM != null) altitude = ` · techo ${f.ceilingAmslM} m s.n.m.`;
  return `
    <li class="hit">
      <span class="swatch" style="--c:${COLORS[f.category]}"></span>
      <div>
        <strong>${esc(f.name)}</strong>
        <small>${esc([f.layer.label, f.subtitle].filter(Boolean).join(' · '))}</small>
        <small class="hit-where">${CATEGORY_LABEL[f.category]} · ${where}${altitude}</small>
        ${f.details ? `<details data-id="${esc(f.id)}"><summary>Observaciones</summary><p>${esc(f.details)}</p></details>` : ''}
      </div>
    </li>`;
}

// ---------- Condiciones de vuelo ----------
async function track(name, task) {
  if (cond.busy.has(name)) return;
  cond.busy.add(name);
  renderConditions();
  try {
    await task();
  } finally {
    cond.busy.delete(name);
    renderStatus();
  }
}

function refreshConditions() {
  const s = subject();
  if (!s) return;
  const point = s.point;
  const now = Date.now();
  if (!cond.weatherPoint || haversine(cond.weatherPoint, point) > 2000 || now - cond.weatherAt > 10 * 60e3) {
    track('weather', async () => {
      try {
        cond.weather = await fetchWeather(point);
        cond.weatherPoint = point;
        cond.weatherAt = Date.now();
        cond.weatherError = null;
      } catch {
        cond.weatherError = 'No se pudo consultar el clima.';
      }
    });
  }
  if (!cond.terrainPoint || haversine(cond.terrainPoint, point) > 100) {
    track('terrain', async () => {
      try {
        const terrain = await fetchTerrain(point);
        cond.terrainM = terrain.value;
        cond.terrainSource = terrain.source;
        cond.terrainPoint = point;
      } catch {
        /* sin elevación: se usan las alturas fijas de cada zona */
      }
    });
  }
  if (now - cond.kpAt > 15 * 60e3) {
    track('kp', async () => {
      try {
        cond.kp = await fetchKp();
        cond.kpAt = Date.now();
      } catch {
        /* sin índice Kp */
      }
    });
  }
}
setInterval(refreshConditions, 60e3);

const cardinal = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(deg / 45) % 8];

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

function renderConditions() {
  const el = $('#conditions');
  const s = subject();
  el.hidden = !s;
  if (!s) return;

  const w = cond.weatherPoint && haversine(cond.weatherPoint, s.point) <= 2000 ? cond.weather : null;
  const terrainM = terrainAt(s.point);
  const loading = cond.busy.size > 0;

  if (!w && !cond.kp && terrainM == null) {
    el.innerHTML = `<h3>Condiciones de vuelo</h3><p class="muted small">${loading ? 'Consultando clima, terreno e índice Kp…' : esc(cond.weatherError ?? 'Sin datos de condiciones.')}</p>`;
    return;
  }

  const verdict = assess(w, cond.kp);
  const v = VERDICT[verdict.level];
  const time = (d) => d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', timeZone: w?.timezone });
  const items = [];
  if (w) {
    items.push(['Viento 10 m', `${Math.round(w.wind)} km/h ${cardinal(w.windDir)}`]);
    items.push(['Ráfagas', `${Math.round(w.gusts)} km/h`]);
    if (w.wind120 != null) items.push(['Viento 120 m', `${Math.round(w.wind120)} km/h ${cardinal(w.windDir120)}`]);
    items.push(['Cielo', describeWeather(w.code)]);
    items.push(['Temperatura', `${Math.round(w.temperature)} °C`]);
    items.push(['Lluvia', `${w.precipitation} mm${w.rainProb != null ? ` · ${w.rainProb}%` : ''}`]);
    if (w.visibility != null) items.push(['Visibilidad', w.visibility >= 10000 ? '> 10 km' : formatDistance(w.visibility)]);
    items.push(['Nubes', `${w.cloudCover}%`]);
    const now = new Date();
    const light =
      w.isDay && w.sunset > now
        ? `Puesta ${time(w.sunset)} · quedan ${formatDuration((w.sunset - now) / 60000)}`
        : `Amanece ${time(w.sunrise > now ? w.sunrise : w.nextSunrise)}`;
    items.push(['Luz', light]);
  }
  if (cond.kp?.kp != null) {
    items.push(['Índice Kp', `${cond.kp.kp.toFixed(1)} (${kpLabel(cond.kp.kp)})${cond.kp.max24h != null ? ` · máx. 24 h ${cond.kp.max24h.toFixed(1)}` : ''}`]);
  }
  if (terrainM != null) items.push([`Terreno (${cond.terrainSource ?? 'Open-Meteo'})`, `${Math.round(terrainM).toLocaleString('es')} m s.n.m.`]);

  el.innerHTML = `
    <h3>Condiciones de vuelo${loading ? ' <span class="spinner inline"></span>' : ''}</h3>
    <div class="verdict" data-level="${verdict.level}">
      <span class="badge small">${v.icon}</span>
      <div><strong>${v.title}</strong>${verdict.reasons.length ? `<small>${esc(verdict.reasons.join(' · '))}</small>` : ''}</div>
    </div>
    <dl class="grid">${items.map(([k, val]) => `<div><dt>${k}</dt><dd>${esc(val)}</dd></div>`).join('')}</dl>
    <p class="muted small">Datos: Open-Meteo · NOAA SWPC${cond.terrainSource === 'ArcGIS' ? ' · Esri' : ''}${w ? ` · ${time(w.time)}` : ''}. Umbrales orientativos: revisa los límites de tu dron.</p>`;
}

function renderGps() {
  const g = state.gps;
  const el = $('#gps');
  el.hidden = !g;
  if (!g) return;
  const terrainM = terrainAt([g.lat, g.lon]);
  const items = [
    ['Latitud', g.lat.toFixed(6)],
    ['Longitud', g.lon.toFixed(6)],
    ['Precisión', `±${Math.round(g.accuracy)} m`],
    ['Altitud GPS', g.altitude != null ? `${Math.round(g.altitude)} m` : '—'],
    ['Sobre terreno', g.altitude != null && terrainM != null ? `≈ ${Math.round(g.altitude - terrainM)} m` : '—'],
    ['Velocidad', g.speed != null ? `${(g.speed * 3.6).toFixed(1)} km/h` : '—'],
    ['Rumbo', g.heading != null ? `${Math.round(g.heading)}° ${cardinal(g.heading)}` : '—'],
  ];
  el.innerHTML = `
    <h3>GPS</h3>
    <dl class="grid">${items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    <button class="btn small ghost" type="button" data-action="copy-coords">Copiar coordenadas</button>`;
}

$('#sheet').addEventListener('click', async (e) => {
  const target = e.target.closest('[data-action]');
  const action = target?.dataset.action;
  if (action === 'clear-pick') {
    e.stopPropagation();
    clearPicked();
  } else if (action === 'switch-country') {
    switchCountry(target.dataset.code);
  } else if (action === 'copy-coords' && state.gps) {
    const text = `${state.gps.lat.toFixed(6)}, ${state.gps.lon.toFixed(6)}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Coordenadas copiadas');
    } catch {
      toast(text);
    }
  }
});

const toggleSheet = () => $('#sheet').classList.toggle('open');
$('#status').addEventListener('click', toggleSheet);
$('#status').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    toggleSheet();
  }
});

// La altura de la hoja desplaza los botones flotantes y los controles inferiores del mapa.
new ResizeObserver(([entry]) => {
  if (window.matchMedia('(min-width: 900px)').matches) return;
  document.documentElement.style.setProperty('--sheet-h', `${Math.round(entry.borderBoxSize[0].blockSize)}px`);
}).observe($('#sheet'));

// ---------- GPS ----------
const gps = new GpsTracker({
  onFix(fix) {
    const first = !state.gps;
    state.gps = fix;
    const ll = [fix.lat, fix.lon];
    gpsMarker.setLatLng(ll).addTo(map);
    accuracyCircle.setLatLng(ll).setRadius(fix.accuracy).addTo(map);
    const cone = gpsMarker.getElement()?.querySelector('.gps-cone');
    if (cone) {
      const moving = fix.heading != null && (fix.speed ?? 0) > 0.5;
      cone.style.display = moving ? '' : 'none';
      if (moving) cone.style.transform = `rotate(${fix.heading}deg)`;
    }
    if (state.following) map.setView(ll, first ? Math.max(map.getZoom(), 15) : map.getZoom(), { animate: !first });
    if (first && state.zones && !state.zones.inCountry(ll)) {
      const other = countryAt(ll, state.country.code);
      if (other) switchCountry(other.code);
    }
    if (!state.picked) subjectChanged();
    else renderGps();
    maybeRenderNearby();
  },
  onError(err) {
    toast(err.message);
    if (!gps.active) {
      state.following = false;
      updateLocateButton();
    }
  },
});

function stopGps() {
  gps.stop();
  state.gps = null;
  state.following = false;
  gpsMarker.remove();
  accuracyCircle.remove();
}

$('#btn-locate').addEventListener('click', () => {
  if (!gps.active) {
    state.following = true;
    clearPicked();
    gps.start();
  } else if (!state.following) {
    state.following = true;
    clearPicked();
    if (state.gps) map.setView([state.gps.lat, state.gps.lon], Math.max(map.getZoom(), 15));
  } else {
    stopGps();
  }
  updateLocateButton();
  subjectChanged();
});

function updateLocateButton() {
  const btn = $('#btn-locate');
  btn.dataset.state = !gps.active ? 'off' : state.following ? 'follow' : 'on';
  btn.title = !gps.active ? 'Activar GPS' : state.following ? 'Desactivar GPS' : 'Centrar en mi ubicación';
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    gps.resume();
    refreshConditions();
  }
});

// ---------- Paneles ----------
const panels = { layers: $('#panel-layers'), info: $('#panel-info'), nearby: $('#panel-nearby') };

function openPanel(name) {
  for (const [key, el] of Object.entries(panels)) el.hidden = key !== name || !el.hidden;
  if (name === 'nearby') renderNearby();
}

// ---------- Sitios cerca ----------
const NEARBY_LIMIT = 40;
const FLYABLE = new Set(['ok', 'caution', 'limited']);
const SHORT_STATUS = {
  ok: 'Se puede volar',
  caution: 'Precaución',
  limited: 'Altura limitada',
  restricted: 'Requiere autorización',
  prohibited: 'Prohibido',
  unknown: 'Evaluando…',
};
let nearbyItems = [];

function nearbyOrigin() {
  if (state.gps) return { point: [state.gps.lat, state.gps.lon], label: 'Desde tu ubicación', live: true };
  if (state.picked) return { point: state.picked, label: 'Desde el punto seleccionado' };
  const c = map.getCenter();
  return { point: [c.lat, c.lng], label: 'Desde el centro del mapa · activa el GPS para usar tu ubicación' };
}

function bearing([lat1, lon1], [lat2, lon2]) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

function renderNearby() {
  if ($('#panel-nearby').hidden) return;
  const origin = nearbyOrigin();
  $('#nearby-origin').textContent = origin.label;
  $('#nearby-flyable').checked = state.nearbyFlyable;

  // Los sitios sin nombre de OSM sólo aportan ruido en una lista; los mapeados dos veces
  // (mismo nombre a menos de 300 m) se muestran una vez.
  const sorted = poiLayers
    .filter((layer) => layer.visible)
    .flatMap((layer) => layer.items.filter((item) => item.props.name).map((item) => ({ item, def: layer.def })))
    .filter(({ item }) => !state.nearbyFlyable || FLYABLE.has(item.level))
    .map((entry) => ({ ...entry, distance: haversine(origin.point, entry.item.point) }))
    .sort((a, b) => a.distance - b.distance);
  nearbyItems = [];
  for (const entry of sorted) {
    if (nearbyItems.length >= NEARBY_LIMIT) break;
    const name = entry.item.props.name.toLowerCase();
    const dup = nearbyItems.some((e) => e.item.props.name.toLowerCase() === name && haversine(e.item.point, entry.item.point) < 300);
    if (!dup) nearbyItems.push(entry);
  }
  refineNearbyTerrain(nearbyItems);

  $('#nearby-list').innerHTML = nearbyItems.length
    ? nearbyItems
        .map(({ item, def, distance }, i) => {
          const type = POI_TYPES[item.props.type];
          const meta = [`${formatDistance(distance)} ${cardinal(bearing(origin.point, item.point))}`, type?.label, def.style === 'icon' ? 'Destacado' : null];
          return `
            <li>
              <button type="button" data-index="${i}">
                <span class="poi-emoji">${type?.emoji ?? '📍'}</span>
                <span class="nearby-text">
                  <strong>${esc(poiName(item.props))}</strong>
                  <small>${esc(meta.filter(Boolean).join(' · '))}</small>
                </span>
                <span class="status-chip" style="--c:${STATUS_COLORS[item.level]}">${SHORT_STATUS[item.level]}</span>
              </button>
            </li>`;
        })
        .join('')
    : `<li class="muted small">${poiLayers.length ? 'No hay sitios que coincidan.' : 'Aún no hay sitios para este país.'}</li>`;
}

// Con el GPS activo la lista se reordena mientras te mueves, sin redibujar en cada lectura.
let nearbyRenderedAt = 0;
function maybeRenderNearby() {
  if (Date.now() - nearbyRenderedAt < 5000) return;
  nearbyRenderedAt = Date.now();
  renderNearby();
}

$('#btn-nearby').addEventListener('click', () => openPanel('nearby'));

$('#nearby-flyable').addEventListener('change', (e) => {
  state.nearbyFlyable = e.target.checked;
  storage.set('nearbyFlyable', e.target.checked ? '1' : '0');
  renderNearby();
});

$('#nearby-list').addEventListener('click', (e) => {
  const entry = nearbyItems[e.target.closest('button[data-index]')?.dataset.index];
  if (!entry) return;
  map.setView(entry.item.point, Math.max(map.getZoom(), 13));
  selectPoi(entry.item, entry.def);
});

map.on('moveend', () => {
  if (!state.gps && !state.picked) renderNearby();
});

function closePanels() {
  const wasOpen = Object.values(panels).some((el) => !el.hidden);
  for (const el of Object.values(panels)) el.hidden = true;
  $('#search-results').hidden = true;
  return wasOpen;
}

$('#btn-layers').addEventListener('click', () => openPanel('layers'));
$('#btn-info').addEventListener('click', () => openPanel('info'));
document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', closePanels));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePanels();
});

function legendCategory(layer) {
  return layer.legendCategory ?? (typeof layer.category === 'string' ? layer.category : 'restricted');
}

function renderBaseChips() {
  $('#base-layers').innerHTML = Object.entries(BASEMAPS)
    .map(([id, b]) => {
      const locked = b.needs && !state.keys[b.needs];
      return `
        <label class="chip ${locked ? 'locked' : ''}" title="${locked ? `Requiere clave de ${PROVIDERS[b.needs].label}` : ''}">
          <input type="radio" name="base" value="${id}" ${id === state.base ? 'checked' : ''}>
          <span>${locked ? '🔒 ' : ''}${esc(b.label)}</span>
        </label>`;
    })
    .join('');
}

function renderKeyFields() {
  $('#keys-fields').innerHTML = Object.entries(PROVIDERS)
    .map(
      ([id, p]) => `
        <label class="field">
          <span>${esc(p.label)} <small class="muted">${esc(p.help)}</small></span>
          <input type="password" name="${id}" value="${esc(state.keys[id] ?? '')}" spellcheck="false" autocomplete="off">
        </label>`,
    )
    .join('');
}

function renderLayersPanel() {
  const c = state.country;
  const zones = state.zones;
  if (!c) return;

  $('#layer-list').innerHTML = [...c.layers, CUSTOM_LAYER]
    .map((layer) => {
      const st = zones?.status.get(layer.id);
      const cat = legendCategory(layer);
      let info = '';
      if (!st) info = layer.id === 'custom' ? 'Ninguna' : '';
      else if (st.state === 'loading') info = st.tiled ? `${st.count} cargados · cargando…` : 'Cargando…';
      else if (st.state === 'error') info = `<span class="err">Error</span> · <button class="link" type="button" data-retry="${layer.id}">Reintentar</button>`;
      else info = st.tiled ? `${st.count} cargados · se cargan al acercar` : `${st.count} elementos${st.fallback ? ` · ${st.fallback}` : ''}`;
      const legend = layer.legend ?? CATEGORY_LABEL[cat];
      return `
        <label class="layer-row">
          <input type="checkbox" data-layer="${layer.id}" ${state.hidden.has(layer.id) ? '' : 'checked'}>
          <span class="swatch ${cat === 'info' ? 'dot' : ''}" style="--c:${layer.legendColor ?? COLORS[cat]}"></span>
          <span><strong>${esc(layer.label)}</strong><small>${esc(legend)}${info ? ` · ${info}` : ''}</small></span>
        </label>`;
    })
    .join('');

  $('#poi-list').innerHTML = poiLayers.length
    ? poiLayers
        .map(
          ({ def, items }) => `
        <label class="layer-row">
          <input type="checkbox" data-poi="${def.id}" ${state.hiddenPois.has(def.id) ? '' : 'checked'}>
          <span class="poi-swatch">${def.style === 'dot' ? '●' : '★'}</span>
          <span><strong>${esc(def.label)}</strong><small>${esc(def.legend ?? '')} · ${items.length} sitios</small></span>
        </label>`,
        )
        .join('')
    : '<p class="muted small">Aún no hay sitios para este país.</p>';
  $('#hide-blocked').checked = state.hideBlockedPois;

  $('#clear-custom').hidden = !zones?.status.get('custom')?.count;
  const updated = zones?.loadedAt ? ` · actualizado ${zones.loadedAt.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}` : '';
  $('#data-source').innerHTML = c.dataSource
    ? `Fuente: <a href="${c.dataSource.url}" target="_blank" rel="noopener">${esc(c.dataSource.name)}</a>${updated}`
    : '';
}

$('#base-layers').addEventListener('change', (e) => {
  const def = BASEMAPS[e.target.value];
  if (def.needs && !state.keys[def.needs]) {
    toast(`Añade tu clave de ${PROVIDERS[def.needs].label} en «Claves de API».`);
    $('.keys').open = true;
    renderBaseChips();
    return;
  }
  setBaseLayer(e.target.value);
});

$('#keys-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  const previousArcgis = state.keys.arcgis;
  state.keys = saveKeys(data);
  // Una clave nueva invalida las sesiones de Google guardadas.
  for (const key of Object.keys(localStorage)) if (key.startsWith('googleSession:')) storage.remove(key);
  renderBaseChips();
  toast('Claves guardadas en este dispositivo');
  if (BASEMAPS[state.base].needs) setBaseLayer(state.base);

  if (!state.keys.arcgis) {
    storage.remove('arcgisCaps');
  } else if (state.keys.arcgis !== previousArcgis || !storage.getJSON('arcgisCaps')) {
    $('#arcgis-status').textContent = 'Comprobando la clave de ArcGIS…';
    const caps = await validateArcgisKey(state.keys.arcgis);
    const ok = [caps.basemaps && 'mapas', caps.geocode && 'búsqueda', caps.elevation && 'elevación'].filter(Boolean);
    toast(ok.length ? `ArcGIS activo: ${ok.join(', ')}` : 'ArcGIS rechazó la clave: revisa que sea válida y sus privilegios');
    // La elevación cacheada pudo venir de otra fuente: se vuelve a pedir.
    cond.terrainPoint = null;
    refreshConditions();
  }
  renderArcgisStatus();
});

function renderArcgisStatus() {
  const el = $('#arcgis-status');
  if (!state.keys.arcgis) {
    el.textContent = 'ArcGIS: sin clave. Se usan Nominatim (búsqueda) y Open-Meteo (elevación).';
    return;
  }
  const caps = arcgisCapabilities(state.keys.arcgis);
  const mark = (v) => (v ? '✓' : '✗');
  el.textContent = `ArcGIS: mapas ${mark(caps.basemaps)} · búsqueda ${mark(caps.geocode)} · elevación ${mark(caps.elevation)}. Lo que falte usa las fuentes gratuitas.`;
}

$('#layer-list').addEventListener('change', (e) => {
  const id = e.target.dataset.layer;
  if (!id) return;
  if (e.target.checked) state.hidden.delete(id);
  else state.hidden.add(id);
  storage.setJSON('hiddenLayers', [...state.hidden]);
  renderer.setVisible(id, e.target.checked);
  loadVisible();
});

function renderDroneSelect() {
  const current = getDrone();
  const list = state.djiDrones.some((d) => d.slug === current) ? state.djiDrones : [{ slug: current, name: current }, ...state.djiDrones];
  $('#dji-drone').innerHTML = list
    .map((d) => `<option value="${esc(d.slug)}" ${d.slug === current ? 'selected' : ''}>${esc(d.name)}</option>`)
    .join('');
}

$('#dji-drone').addEventListener('change', (e) => {
  setDrone(e.target.value);
  // Las zonas cambian según el modelo: se descarta lo cargado y se pide de nuevo.
  state.zones?.resetLayer('dji');
  renderStatus();
});

fetchDrones().then((drones) => {
  state.djiDrones = drones;
  renderDroneSelect();
  renderStatus();
});

// ---------- Capas meteorológicas ----------
const overlayState = {
  active: new Set(storage.getJSON('weatherLayers') ?? []),
  windHeight: Number(storage.get('windHeight')) || 10,
  opacity: Number(storage.get('satOpacity')) || 0.7,
};
const overlayInstances = new Map();

function overlay(id) {
  let inst = overlayInstances.get(id);
  if (!inst) {
    inst = OVERLAYS[id].create(map);
    inst.opacity = overlayState.opacity;
    if (id === 'viento') inst.height = overlayState.windHeight;
    inst.onError = () => toast('No se pudo consultar el viento. Revisa tu conexión.');
    inst.onUpdate = () => renderOverlayPanel();
    overlayInstances.set(id, inst);
  }
  return inst;
}

async function setOverlay(id, on) {
  if (on) overlayState.active.add(id);
  else overlayState.active.delete(id);
  storage.setJSON('weatherLayers', [...overlayState.active]);
  try {
    if (on) await overlay(id).show();
    else overlay(id).hide();
  } catch {
    toast(`No se pudo cargar: ${OVERLAYS[id].label}`);
  }
  renderOverlayPanel();
}

function renderOverlayPanel() {
  $('#overlay-list').innerHTML = Object.entries(OVERLAYS)
    .map(
      ([id, o]) => `
        <label class="layer-row">
          <input type="checkbox" data-overlay="${id}" ${overlayState.active.has(id) ? 'checked' : ''}>
          <span class="poi-swatch">${{ nubes: '☁️', tormentas: '⛈️', lluvia: '🌧️', viento: '🧭' }[id]}</span>
          <span><strong>${esc(o.label)}</strong><small>${esc(o.legend)}</small></span>
        </label>`,
    )
    .join('');
  $('#wind-height').value = String(overlayState.windHeight);
  $('#sat-opacity').value = String(overlayState.opacity);
  const info = [...overlayState.active].map((id) => overlayInstances.get(id)?.info).filter(Boolean);
  $('#overlay-info').textContent = info.join(' · ');
}

$('#overlay-list').addEventListener('change', (e) => {
  const id = e.target.dataset.overlay;
  if (id) setOverlay(id, e.target.checked);
});

$('#wind-height').addEventListener('change', (e) => {
  overlayState.windHeight = Number(e.target.value);
  storage.set('windHeight', e.target.value);
  overlayInstances.get('viento')?.setHeight(overlayState.windHeight);
});

$('#sat-opacity').addEventListener('input', (e) => {
  overlayState.opacity = Number(e.target.value);
  storage.set('satOpacity', e.target.value);
  for (const id of ['nubes', 'tormentas', 'lluvia']) overlayInstances.get(id)?.setOpacity(overlayState.opacity);
});

$('#poi-list').addEventListener('change', (e) => {
  const id = e.target.dataset.poi;
  const layer = poiLayers.find((p) => p.def.id === id);
  if (!layer) return;
  if (e.target.checked) state.hiddenPois.delete(id);
  else state.hiddenPois.add(id);
  storage.setJSON('hiddenPois', [...state.hiddenPois]);
  layer.visible = e.target.checked;
  layer.refresh();
  renderNearby();
});

$('#hide-blocked').addEventListener('change', (e) => {
  state.hideBlockedPois = e.target.checked;
  storage.set('hideBlockedPois', e.target.checked ? '1' : '0');
  for (const layer of poiLayers) {
    layer.hideBlocked = e.target.checked;
    layer.refresh();
  }
});

$('#layer-list').addEventListener('click', (e) => {
  const id = e.target.closest('[data-retry]')?.dataset.retry;
  if (!id) return;
  e.preventDefault();
  const layer = state.country.layers.find((l) => l.id === id);
  if (layer) state.zones.loadLayer(layer);
});

$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    const features = geojsonToFeatures(json.type === 'Feature' ? { features: [json] } : json, CUSTOM_LAYER);
    if (!features.length) throw new Error('el archivo no contiene puntos ni polígonos');
    state.zones.setCustom(features);
    const saved = storage.setJSON(`custom:${state.country.code}`, json);
    toast(saved ? `${features.length} zonas importadas` : `${features.length} zonas importadas (demasiado grandes para guardarlas)`);
  } catch (err) {
    toast(`No se pudo importar: ${err.message}`);
  }
});

$('#clear-custom').addEventListener('click', () => {
  storage.remove(`custom:${state.country.code}`);
  state.zones.setCustom([]);
});

function renderInfoPanel() {
  const c = state.country;
  $('#info-title').textContent = `Normativa · ${c.name}`;
  $('#info-body').innerHTML = `
    <p class="muted small">Autoridad: <a href="${c.authority.url}" target="_blank" rel="noopener">${esc(c.authority.name)}</a> · ${esc(c.authority.regulation)}</p>
    <h3>Reglas generales</h3>
    <ul>${c.generalRules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    ${c.dataSource ? `<p class="small">Datos de zonas: <a href="${c.dataSource.url}" target="_blank" rel="noopener">${esc(c.dataSource.name)}</a></p>` : ''}`;
}

// ---------- Búsqueda ----------
const COORDS = /^\s*(-?\d{1,2}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/;

$('#search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  const list = $('#search-results');
  if (!q) return;

  const m = q.match(COORDS);
  if (m) {
    const point = [parseFloat(m[1].replace(',', '.')), parseFloat(m[2].replace(',', '.'))];
    if (Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180) {
      list.hidden = true;
      map.setView(point, Math.max(map.getZoom(), 14));
      pickPoint(point);
      return;
    }
  }

  try {
    const results = await searchPlaces(q);
    list.innerHTML = results.length
      ? results
          .map((r) => `<li><button type="button" data-lat="${r.lat}" data-lon="${r.lon}">${esc(r.name)}<small>${esc(r.detail)}</small></button></li>`)
          .join('')
      : '<li class="muted small" style="padding:10px">Sin resultados</li>';
    list.hidden = false;
  } catch {
    toast('No se pudo buscar. Revisa tu conexión.');
  }
});

// Búsqueda con ArcGIS si la clave tiene geocodificación; si no, o si falla, Nominatim (OSM).
async function searchPlaces(q) {
  const { key, caps } = arcgis();
  if (caps.geocode) {
    try {
      const c = map.getCenter();
      return await arcgisGeocode(q, { key, countryCode: state.country.code, near: [c.lat, c.lng] });
    } catch {
      /* se usa Nominatim */
    }
  }
  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '6', 'accept-language': 'es', countrycodes: state.country.code.toLowerCase() });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
  const results = await res.json();
  return results.map((r) => {
    const [name, ...rest] = r.display_name.split(', ');
    return { lat: r.lat, lon: r.lon, name, detail: rest.join(', ') };
  });
}

$('#search-results').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-lat]');
  if (!btn) return;
  const point = [Number(btn.dataset.lat), Number(btn.dataset.lon)];
  $('#search-results').hidden = true;
  $('#search-input').blur();
  map.setView(point, 14);
  pickPoint(point);
});

// ---------- Utilidades ----------
let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

// ---------- Instalación PWA ----------
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#btn-install').hidden = false;
});
$('#btn-install').addEventListener('click', async () => {
  $('#btn-install').hidden = true;
  await installPrompt?.prompt();
  installPrompt = null;
});
if (window.matchMedia('(display-mode: standalone)').matches || !/iPhone|iPad/.test(navigator.userAgent)) {
  $('#install-hint').hidden = true;
}

if ('serviceWorker' in navigator) {
  // updateViaCache: 'none' hace que el navegador busque siempre la última versión de sw.js.
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}

// ---------- Inicio ----------
window.mapaRuas = { map, state, cond }; // para depurar desde la consola
$('#country').innerHTML = COUNTRIES.map((c) => `<option value="${c.code}">${c.name}</option>`).join('');
$('#country').addEventListener('change', (e) => switchCountry(e.target.value));
renderBaseChips();
renderKeyFields();
renderArcgisStatus();
renderDroneSelect();
renderOverlayPanel();
for (const id of overlayState.active) if (OVERLAYS[id]) setOverlay(id, true);
updateLocateButton();
if (!BASEMAPS[state.base]) state.base = 'claro';
setBaseLayer(state.base);
switchCountry(storage.get('country') ?? COUNTRIES[0].code);
