// Sitios de interés para volar. Cada marcador toma el color del estado de vuelo de su
// punto (prohibido, requiere autorización, altura limitada…), calculado con las zonas cargadas.

import { COLORS } from './render.js';

export const POI_TYPES = {
  montaña: { emoji: '⛰️', label: 'Montaña' },
  agua: { emoji: '💧', label: 'Lago o embalse' },
  cascada: { emoji: '💦', label: 'Cascada' },
  playa: { emoji: '🏖️', label: 'Playa' },
  desierto: { emoji: '🏜️', label: 'Desierto' },
  pueblo: { emoji: '🏘️', label: 'Pueblo' },
  cañón: { emoji: '🏞️', label: 'Cañón' },
  isla: { emoji: '🏝️', label: 'Isla' },
  patrimonio: { emoji: '🏛️', label: 'Patrimonio' },
  mirador: { emoji: '🔭', label: 'Mirador' },
};

export const STATUS_COLORS = { ...COLORS, unknown: '#64748b' };
const BLOCKED = new Set(['prohibited', 'restricted']);

export const poiName = (props) => props.name ?? `${POI_TYPES[props.type]?.label ?? 'Sitio'} sin nombre`;

export class PoiLayer {
  constructor(map, def, { onSelect }) {
    this.map = map;
    this.def = def;
    this.onSelect = onSelect;
    this.items = [];
    this.group = L.layerGroup();
    this.visible = true;
    this.hideBlocked = false;
    this.renderer = def.style === 'dot' ? L.canvas({ pane: 'pois', padding: 0.3 }) : null;
    this.onZoom = () => this.refresh();
    map.on('zoomend', this.onZoom);
  }

  async load() {
    const res = await fetch(this.def.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const collection = await res.json();
    this.attribution = collection.attribution ?? null;
    this.items = (collection.features ?? [])
      .filter((f) => f.geometry?.type === 'Point')
      .map((f) => {
        const item = { props: f.properties ?? {}, point: [f.geometry.coordinates[1], f.geometry.coordinates[0]], level: 'unknown' };
        item.marker = this.build(item);
        return item;
      });
    this.refresh();
  }

  build(item) {
    const name = poiName(item.props);
    const marker =
      this.def.style === 'dot'
        ? L.circleMarker(item.point, {
            renderer: this.renderer,
            radius: 5,
            weight: 1.5,
            color: '#fff',
            fillColor: STATUS_COLORS.unknown,
            fillOpacity: 1,
            bubblingMouseEvents: false,
          })
        : L.marker(item.point, { icon: this.icon(item), pane: 'pois', title: name, riseOnHover: true });
    marker.bindTooltip(name, { direction: 'top', offset: this.def.style === 'dot' ? [0, -4] : [0, -16] });
    marker.on('click', () => this.onSelect(item, this.def));
    return marker;
  }

  icon(item) {
    const emoji = POI_TYPES[item.props.type]?.emoji ?? '📍';
    return L.divIcon({
      className: 'poi-icon',
      html: `<span style="--c:${STATUS_COLORS[item.level]}">${emoji}</span>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
  }

  // evaluate(item) -> nivel ('ok', 'caution', … o 'unknown').
  setStatus(evaluate) {
    for (const item of this.items) this.setLevel(item, evaluate(item));
    if (this.hideBlocked) this.refresh();
  }

  setLevel(item, level) {
    if (level === item.level) return;
    item.level = level;
    if (this.def.style === 'dot') item.marker.setStyle({ fillColor: STATUS_COLORS[level] });
    else item.marker.setIcon(this.icon(item));
  }

  refresh() {
    const show = this.visible && (!this.def.minZoom || this.map.getZoom() >= this.def.minZoom);
    this.group.clearLayers();
    if (!show) {
      this.group.remove();
      return;
    }
    for (const item of this.items) {
      if (this.hideBlocked && BLOCKED.has(item.level)) continue;
      this.group.addLayer(item.marker);
    }
    this.group.addTo(this.map);
  }

  destroy() {
    this.group.remove();
    this.map.off('zoomend', this.onZoom);
  }
}
