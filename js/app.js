import { COUNTRIES, loadCountry, countryAt } from './countries/index.js';
import { ZoneStore } from './zones.js';
import { ZoneRenderer, COLORS } from './render.js';
import { GpsTracker } from './gps.js';
import { CUSTOM_LAYER, geojsonToFeatures } from './sources.js';
import { BASEMAPS, PROVIDERS, createBaseLayers, getKeys, saveKeys } from './basemaps.js';
import { fetchWeather, fetchElevation, fetchKp, assess, describeWeather, kpLabel } from './conditions.js';
import { PoiLayer, POI_TYPES, poiName } from './pois.js';
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
    text: () => 'Todavía no se han cargado todas las zonas de este punto. No asumas que puedes volar.',
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
// Los sitios de interés van por encima de todas las zonas.
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
  const country = await loadCountry(code);
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

// Nunca se da luz verde si faltan capas o el punto no se ha podido evaluar del todo.
function displayLevel(r, zones) {
  const incomplete = !r.outside && (!r.complete || zones.loadingRequired || zones.failed);
  return r.level === 'ok' && incomplete ? 'unknown' : r.level;
}

// Recalcular el estado de miles de sitios es costoso: se agrupan los cambios de zonas.
const schedulePoiStatus = debounce(() => {
  const zones = state.zones;
  if (!zones) return;
  const evaluate = (point) => {
    const r = zones.evaluate(point);
    return r.outside ? 'unknown' : displayLevel(r, zones);
  };
  poiLayers.forEach((layer) => layer.setStatus(evaluate));
}, 400);

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
  const optionalFailed = zones.failedOptional;
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
    ${r.hits.length ? `<ul class="hit-list">${r.hits.map(hitHtml).join('')}</ul>` : ''}`;
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
        cond.terrainM = await fetchElevation(point);
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
  if (terrainM != null) items.push(['Terreno', `${Math.round(terrainM).toLocaleString('es')} m s.n.m.`]);

  el.innerHTML = `
    <h3>Condiciones de vuelo${loading ? ' <span class="spinner inline"></span>' : ''}</h3>
    <div class="verdict" data-level="${verdict.level}">
      <span class="badge small">${v.icon}</span>
      <div><strong>${v.title}</strong>${verdict.reasons.length ? `<small>${esc(verdict.reasons.join(' · '))}</small>` : ''}</div>
    </div>
    <dl class="grid">${items.map(([k, val]) => `<div><dt>${k}</dt><dd>${esc(val)}</dd></div>`).join('')}</dl>
    <p class="muted small">Datos: Open-Meteo · NOAA SWPC${w ? ` · ${time(w.time)}` : ''}. Umbrales orientativos: revisa los límites de tu dron.</p>`;
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
const panels = { layers: $('#panel-layers'), info: $('#panel-info') };

function openPanel(name) {
  for (const [key, el] of Object.entries(panels)) el.hidden = key !== name || !el.hidden;
}

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
          <span class="swatch ${cat === 'info' ? 'dot' : ''}" style="--c:${COLORS[cat]}"></span>
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

$('#keys-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  state.keys = saveKeys(data);
  // Una clave nueva invalida las sesiones de Google guardadas.
  for (const key of Object.keys(localStorage)) if (key.startsWith('googleSession:')) storage.remove(key);
  renderBaseChips();
  toast('Claves guardadas en este dispositivo');
  if (BASEMAPS[state.base].needs) setBaseLayer(state.base);
});

$('#layer-list').addEventListener('change', (e) => {
  const id = e.target.dataset.layer;
  if (!id) return;
  if (e.target.checked) state.hidden.delete(id);
  else state.hidden.add(id);
  storage.setJSON('hiddenLayers', [...state.hidden]);
  renderer.setVisible(id, e.target.checked);
  loadVisible();
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

  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '6', 'accept-language': 'es', countrycodes: state.country.code.toLowerCase() });
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
    const results = await res.json();
    list.innerHTML = results.length
      ? results
          .map((r) => {
            const [name, ...rest] = r.display_name.split(', ');
            return `<li><button type="button" data-lat="${r.lat}" data-lon="${r.lon}">${esc(name)}<small>${esc(rest.join(', '))}</small></button></li>`;
          })
          .join('')
      : '<li class="muted small" style="padding:10px">Sin resultados</li>';
    list.hidden = false;
  } catch {
    toast('No se pudo buscar. Revisa tu conexión.');
  }
});

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
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---------- Inicio ----------
window.mapaRuas = { map, state, cond }; // para depurar desde la consola
$('#country').innerHTML = COUNTRIES.map((c) => `<option value="${c.code}">${c.name}</option>`).join('');
$('#country').addEventListener('change', (e) => switchCountry(e.target.value));
renderBaseChips();
renderKeyFields();
updateLocateButton();
if (!BASEMAPS[state.base]) state.base = 'claro';
setBaseLayer(state.base);
switchCountry(storage.get('country') ?? COUNTRIES[0].code);
