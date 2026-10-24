import { COUNTRIES, loadCountry } from './countries/index.js';
import { ZoneStore } from './zones.js';
import { ZoneRenderer, COLORS } from './render.js';
import { GpsTracker } from './gps.js';
import { CUSTOM_LAYER, geojsonToFeatures } from './sources.js';
import { storage } from './storage.js';
import { formatDistance, formatCoord } from './geo.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const BASE_LAYERS = {
  mapa: {
    label: 'Mapa',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, attribution: '&copy; colaboradores de <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
  },
  satelite: {
    label: 'Satélite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: { maxZoom: 19, attribution: 'Imágenes &copy; Esri, Maxar, Earthstar Geographics' },
  },
  topo: {
    label: 'Relieve',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 17, attribution: '&copy; OpenStreetMap, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' },
  },
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
    text: (r) => `Puedes volar sin superar ${r.maxAltitudeM} m de altura. Revisa las condiciones de la zona.`,
  },
  caution: {
    icon: '!',
    title: 'Precaución',
    text: (r, c) => `Estás a menos de ${formatDistance(c.cautionMarginM)} de una zona restringida. Mantén distancia.`,
  },
  ok: {
    icon: '✓',
    title: 'Sin restricciones conocidas',
    text: (r, c) => `Puedes volar en categoría abierta respetando las reglas generales (máx. ${c.maxAltitudeM} m).`,
  },
};

const state = {
  country: null,
  zones: null,
  gps: null, // última posición
  following: false,
  picked: null, // [lat, lon] tocado en el mapa
  base: storage.get('baseLayer') ?? 'mapa',
  hidden: new Set(storage.getJSON('hiddenLayers') ?? []),
};

// ---------- Mapa ----------
const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([4.6, -74.1], 6);
L.control.zoom({ position: 'topright' }).addTo(map);
L.control.scale({ imperial: false, position: 'topleft' }).addTo(map);
map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

let baseLayer = null;
function setBaseLayer(key) {
  const def = BASE_LAYERS[key] ?? BASE_LAYERS.mapa;
  baseLayer?.remove();
  baseLayer = L.tileLayer(def.url, { ...def.options, crossOrigin: 'anonymous' }).addTo(map);
  state.base = BASE_LAYERS[key] ? key : 'mapa';
  storage.set('baseLayer', state.base);
}
setBaseLayer(state.base);

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
  });
  zones.addEventListener('status', () => {
    if (zones !== state.zones) return;
    $('#busy').hidden = !zones.loading;
    renderLayersPanel();
    renderStatus();
  });

  const custom = storage.getJSON(`custom:${country.code}`);
  if (custom) zones.setCustom(geojsonToFeatures(custom, CUSTOM_LAYER));

  renderInfoPanel();
  renderLayersPanel();
  if (!state.following && !state.picked) map.setView(country.center, country.zoom);
  renderStatus();

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

function pickPoint(point) {
  state.picked = point;
  state.following = false;
  pickMarker.setLatLng(point).addTo(map);
  $('#sheet').classList.add('open');
  updateLocateButton();
  renderStatus();
}

function clearPicked() {
  state.picked = null;
  pickMarker.remove();
  renderStatus();
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
    renderGps();
    return;
  }

  const r = zones.evaluate(s.point);
  const level = LEVELS[r.level];
  const where =
    s.kind === 'gps' ? `Tu ubicación · precisión ±${Math.round(state.gps.accuracy)} m` : `Punto seleccionado · ${formatCoord(...s.point)}`;
  card.dataset.level = r.level;
  card.innerHTML = `
    <div class="badge">${level.icon}</div>
    <div class="status-text"><h2>${level.title}</h2><p>${esc(where)}</p></div>
    ${s.kind === 'picked' ? '<button class="icon-btn" data-action="clear-pick" aria-label="Quitar punto">✕</button>' : ''}`;

  const notes = [];
  if (r.outside) notes.push(`<p class="note warn">Este punto está fuera de ${esc(c.name)}: las zonas cargadas no aplican aquí.</p>`);
  if (zones.loading) notes.push('<p class="note">Cargando capas oficiales… el resultado puede cambiar.</p>');
  else if (zones.failed) notes.push('<p class="note warn">Algunas capas no se cargaron: el resultado puede estar incompleto. Revisa el panel de capas.</p>');
  if (s.kind === 'gps' && state.gps.accuracy > 100) {
    notes.push(`<p class="note warn">Precisión GPS baja (±${Math.round(state.gps.accuracy)} m). Espera a tener mejor señal.</p>`);
  }

  // Con el GPS activo esto se repite cada segundo: sólo se reemplaza si cambió y se
  // conservan abiertas las observaciones que el usuario esté leyendo.
  const hitsEl = $('#hits');
  const html = `
    <p class="level-text">${esc(level.text(r, c))}</p>
    ${notes.join('')}
    ${r.hits.length ? `<ul class="hit-list">${r.hits.map(hitHtml).join('')}</ul>` : ''}`;
  if (html !== hitsEl.dataset.html) {
    const open = new Set([...hitsEl.querySelectorAll('details[open]')].map((d) => d.dataset.id));
    hitsEl.innerHTML = html;
    hitsEl.dataset.html = html;
    hitsEl.querySelectorAll('details').forEach((d) => (d.open = open.has(d.dataset.id)));
  }
  renderGps();
}

function hitHtml({ feature: f, inside, distance }) {
  const where = inside ? 'Dentro de la zona' : `A ${formatDistance(distance)} del límite`;
  const altitude = inside && f.maxAltitudeM ? ` · máx. ${f.maxAltitudeM} m` : '';
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

const cardinal = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(deg / 45) % 8];

function renderGps() {
  const g = state.gps;
  const el = $('#gps');
  el.hidden = !g;
  if (!g) return;
  const items = [
    ['Latitud', g.lat.toFixed(6)],
    ['Longitud', g.lon.toFixed(6)],
    ['Precisión', `±${Math.round(g.accuracy)} m`],
    ['Altitud GPS', g.altitude != null ? `${Math.round(g.altitude)} m` : '—'],
    ['Velocidad', g.speed != null ? `${(g.speed * 3.6).toFixed(1)} km/h` : '—'],
    ['Rumbo', g.heading != null ? `${Math.round(g.heading)}° ${cardinal(g.heading)}` : '—'],
  ];
  el.innerHTML = `
    <h3>GPS</h3>
    <dl>${items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    <button class="btn small ghost" type="button" data-action="copy-coords">Copiar coordenadas</button>`;
}

$('#sheet').addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'clear-pick') {
    e.stopPropagation();
    clearPicked();
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
    renderStatus();
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
  renderStatus();
});

function updateLocateButton() {
  const btn = $('#btn-locate');
  btn.dataset.state = !gps.active ? 'off' : state.following ? 'follow' : 'on';
  btn.title = !gps.active ? 'Activar GPS' : state.following ? 'Desactivar GPS' : 'Centrar en mi ubicación';
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') gps.resume();
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

function renderLayersPanel() {
  const c = state.country;
  const zones = state.zones;
  if (!c) return;

  $('#base-layers').innerHTML = Object.entries(BASE_LAYERS)
    .map(
      ([key, b]) =>
        `<label><input type="radio" name="base" value="${key}" ${key === state.base ? 'checked' : ''}><span>${b.label}</span></label>`,
    )
    .join('');

  $('#layer-list').innerHTML = [...c.layers, CUSTOM_LAYER]
    .map((layer) => {
      const st = zones?.status.get(layer.id);
      const cat = legendCategory(layer);
      let info = '';
      if (!st) info = layer.id === 'custom' ? 'Ninguna' : '';
      else if (st.state === 'loading') info = 'Cargando…';
      else if (st.state === 'error') info = `<span class="err">Error</span> · <button class="link" type="button" data-retry="${layer.id}">Reintentar</button>`;
      else info = `${st.count} elementos`;
      const legend = layer.legend ?? CATEGORY_LABEL[cat];
      return `
        <label class="layer-row">
          <input type="checkbox" data-layer="${layer.id}" ${state.hidden.has(layer.id) ? '' : 'checked'}>
          <span class="swatch ${cat === 'info' ? 'dot' : ''}" style="--c:${COLORS[cat]}"></span>
          <span><strong>${esc(layer.label)}</strong><small>${esc(legend)}${info ? ` · ${info}` : ''}</small></span>
        </label>`;
    })
    .join('');

  $('#clear-custom').hidden = !zones?.status.get('custom')?.count;
  const updated = zones?.loadedAt ? ` · actualizado ${zones.loadedAt.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}` : '';
  $('#data-source').innerHTML = c.dataSource
    ? `Fuente: <a href="${c.dataSource.url}" target="_blank" rel="noopener">${esc(c.dataSource.name)}</a>${updated}`
    : '';
}

$('#base-layers').addEventListener('change', (e) => setBaseLayer(e.target.value));

$('#layer-list').addEventListener('change', (e) => {
  const id = e.target.dataset.layer;
  if (!id) return;
  if (e.target.checked) state.hidden.delete(id);
  else state.hidden.add(id);
  storage.setJSON('hiddenLayers', [...state.hidden]);
  renderer.setVisible(id, e.target.checked);
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
  $('#info-title').textContent = `Normativa · ${c.flag} ${c.name}`;
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
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
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
window.mapaRuas = { map, state }; // para depurar desde la consola
$('#country').innerHTML = COUNTRIES.map((c) => `<option value="${c.code}">${c.name}</option>`).join('');
$('#country').addEventListener('change', (e) => switchCountry(e.target.value));
updateLocateButton();
switchCountry(storage.get('country') ?? COUNTRIES[0].code);
