// Capas meteorológicas sobre el mapa, todas gratuitas y sin clave:
// - Nubes y tormentas: satélite GOES-East vía NASA GIBS (cada 10 min, ~1 h de retraso).
// - Lluvia: radar de RainViewer.
// - Viento: cuadrícula de flechas con datos actuales de Open-Meteo para la zona visible.

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const REFRESH_MS = 10 * 60e3;

export const WIND_COLORS = [
  [15, '#16a34a'],
  [25, '#84cc16'],
  [35, '#eab308'],
  [45, '#f97316'],
  [Infinity, '#dc2626'],
];
const windColor = (kmh) => WIND_COLORS.find(([max]) => kmh < max)[1];

// Capa de teselas que se refresca sola para mostrar siempre la imagen más reciente.
class RefreshingTiles {
  constructor(map, makeLayer) {
    this.map = map;
    this.makeLayer = makeLayer;
    this.layer = null;
    this.timer = null;
    this.info = '';
  }

  async show() {
    if (this.layer) return;
    this.layer = await this.makeLayer(this);
    this.layer.addTo(this.map);
    this.timer = setInterval(() => this.reload(), REFRESH_MS);
  }

  async reload() {
    const fresh = await this.makeLayer(this).catch(() => null);
    if (!fresh || !this.layer) return;
    const old = this.layer;
    this.layer = fresh.addTo(this.map);
    // Se retira la anterior cuando la nueva ya cargó, para que no parpadee.
    fresh.once('load', () => old.remove());
  }

  hide() {
    clearInterval(this.timer);
    this.layer?.remove();
    this.layer = null;
  }

  setOpacity(value) {
    this.opacity = value;
    this.layer?.setOpacity(value);
  }
}

function gibsLayer(id, level, attribution) {
  return (self) =>
    L.tileLayer(`${GIBS}/${id}/default/default/GoogleMapsCompatible_Level${level}/{z}/{y}/{x}.png`, {
      pane: 'weather',
      maxNativeZoom: level,
      maxZoom: 19,
      opacity: self.opacity ?? 0.7,
      crossOrigin: 'anonymous',
      attribution,
    });
}

async function rainviewerLayer(self) {
  const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
  const j = await res.json();
  const frame = j.radar?.past?.at(-1);
  if (!frame) throw new Error('Sin datos de radar');
  self.info = `Radar de las ${new Date(frame.time * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`;
  return L.tileLayer(`${j.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
    pane: 'weather',
    maxNativeZoom: 7,
    maxZoom: 19,
    opacity: self.opacity ?? 0.8,
    attribution: 'Radar: <a href="https://www.rainviewer.com">RainViewer</a>',
  });
}

export const OVERLAYS = {
  nubes: {
    label: 'Nubes (satélite)',
    legend: 'GOES-East en color · NASA GIBS · cada 10 min',
    create: (map) => new RefreshingTiles(map, gibsLayer('GOES-East_ABI_GeoColor', 7, 'Nubes: NASA GIBS / NOAA GOES-East')),
  },
  tormentas: {
    label: 'Tormentas (infrarrojo)',
    legend: 'Topes de nube fríos en amarillo y rojo',
    create: (map) =>
      new RefreshingTiles(map, gibsLayer('GOES-East_ABI_Band13_Clean_Infrared', 6, 'Infrarrojo: NASA GIBS / NOAA GOES-East')),
  },
  lluvia: {
    label: 'Lluvia (radar)',
    legend: 'RainViewer · cobertura según radares disponibles',
    create: (map) => new RefreshingTiles(map, rainviewerLayer),
  },
  viento: {
    label: 'Viento (flechas)',
    legend: 'Open-Meteo · hacia dónde sopla y velocidad',
    create: (map) => new WindLayer(map),
  },
};

// ---------- Viento ----------

const CELL_PX = 85; // separación aproximada entre flechas
const MAX_POINTS = 100;

export class WindLayer {
  constructor(map) {
    this.map = map;
    this.height = 10; // 10 o 120 m
    this.group = L.layerGroup();
    this.onMove = debounce(() => this.update(), 700);
    this.cacheKey = null;
    this.fetchedAt = 0;
    this.info = '';
    this.onError = null;
  }

  show() {
    this.group.addTo(this.map);
    this.map.on('moveend', this.onMove);
    this.timer = setInterval(() => this.update(true), REFRESH_MS);
    return this.update();
  }

  hide() {
    this.map.off('moveend', this.onMove);
    clearInterval(this.timer);
    this.group.clearLayers().remove();
    this.cacheKey = null;
  }

  setHeight(height) {
    this.height = height;
    this.update(true);
  }

  grid() {
    const size = this.map.getSize();
    let cols = Math.max(2, Math.round(size.x / CELL_PX));
    let rows = Math.max(2, Math.round(size.y / CELL_PX));
    while (cols * rows > MAX_POINTS) {
      cols = Math.max(2, cols - 1);
      rows = Math.max(2, rows - 1);
    }
    const points = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const ll = this.map.containerPointToLatLng([((c + 0.5) * size.x) / cols, ((r + 0.5) * size.y) / rows]);
        points.push([ll.lat, ll.lng]);
      }
    }
    return points;
  }

  async update(force = false) {
    const points = this.grid();
    const key = `${this.height}|${points.map(([a, b]) => `${a.toFixed(2)},${b.toFixed(2)}`).join(';')}`;
    if (!force && key === this.cacheKey && Date.now() - this.fetchedAt < REFRESH_MS) return;
    const vars = this.height === 120 ? 'wind_speed_120m,wind_direction_120m' : 'wind_speed_10m,wind_direction_10m,wind_gusts_10m';
    const params = new URLSearchParams({
      latitude: points.map(([lat]) => lat.toFixed(3)).join(','),
      longitude: points.map(([, lon]) => lon.toFixed(3)).join(','),
      current: vars,
      wind_speed_unit: 'kmh',
    });
    try {
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const list = Array.isArray(j) ? j : [j];
      this.cacheKey = key;
      this.fetchedAt = Date.now();
      this.draw(points, list.map((d) => d.current));
      // Open-Meteo responde en UTC si no se pide zona horaria: se muestra en hora local.
      const time = list[0]?.current?.time;
      const local = time ? new Date(`${time}Z`).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
      this.info = local ? `Viento a ${this.height} m de las ${local}` : '';
      this.onUpdate?.();
    } catch (err) {
      this.onError?.(err);
    }
  }

  draw(points, data) {
    this.group.clearLayers();
    const h = this.height;
    points.forEach((point, i) => {
      const d = data[i];
      const speed = d?.[`wind_speed_${h}m`];
      const from = d?.[`wind_direction_${h}m`];
      if (speed == null || from == null) return;
      const gust = d.wind_gusts_10m;
      const color = windColor(speed);
      // La dirección meteorológica indica de dónde viene: la flecha apunta hacia donde va.
      const html = `
        <div class="wind-arrow" title="${Math.round(speed)} km/h desde ${Math.round(from)}°${gust != null ? ` · ráfagas ${Math.round(gust)} km/h` : ''}">
          <svg viewBox="0 0 24 24" width="26" height="26" style="transform:rotate(${(from + 180) % 360}deg)">
            <path d="M12 2 L18 12 L13.5 11 L13.5 22 L10.5 22 L10.5 11 L6 12 Z" fill="${color}" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>
          </svg>
          <span>${Math.round(speed)}</span>
        </div>`;
      L.marker(point, {
        pane: 'wind',
        interactive: false,
        keyboard: false,
        icon: L.divIcon({ className: 'wind-icon', html, iconSize: [40, 40], iconAnchor: [20, 20] }),
      }).addTo(this.group);
    });
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
