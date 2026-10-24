// Dibujo de zonas en Leaflet. Cada capa tiene su propio pane y canvas para
// respetar el orden (zonas grandes abajo, puntos de referencia arriba).

export const COLORS = {
  prohibited: '#dc2626',
  restricted: '#f97316',
  limited: '#eab308',
  caution: '#eab308',
  info: '#2563eb',
  ok: '#16a34a',
};

export class ZoneRenderer {
  constructor(map, hidden) {
    this.map = map;
    this.hidden = hidden;
    this.groups = new Map();
    this.layers = new Map();
    this.renderers = new Map();
    this.fallback = L.canvas({ padding: 0.3 });
  }

  setLayerOrder(layerDefs) {
    layerDefs.forEach((def, i) => {
      const name = `zones-${def.id}`;
      const pane = this.map.getPane(name) ?? this.map.createPane(name);
      pane.style.zIndex = String(401 + i);
      pane.style.pointerEvents = 'none';
      if (!this.renderers.has(def.id)) this.renderers.set(def.id, L.canvas({ pane: name, padding: 0.3 }));
    });
  }

  group(layerId) {
    let group = this.groups.get(layerId);
    if (!group) {
      group = L.layerGroup();
      this.groups.set(layerId, group);
      if (!this.hidden.has(layerId)) group.addTo(this.map);
    }
    return group;
  }

  build(f) {
    const color = COLORS[f.category] ?? COLORS.restricted;
    const style = {
      renderer: this.renderers.get(f.layer.id) ?? this.fallback,
      interactive: false,
      color,
      weight: 1.2,
      opacity: 0.9,
      fillColor: color,
      // Opacidad baja: en ciudades se superponen muchas zonas y no deben tapar el mapa base.
      fillOpacity: f.category === 'limited' ? 0.08 : 0.12,
    };
    if (f.kind === 'point') {
      return L.circleMarker(f.center, { ...style, radius: 4, weight: 1.5, color: '#fff', fillOpacity: 1 });
    }
    if (f.kind === 'circle') return L.circle(f.center, { ...style, radius: f.radius });
    return L.polygon(f.rings, style);
  }

  sync(features) {
    for (const [id, entry] of this.layers) {
      if (features.get(id) === entry.feature) continue;
      this.group(entry.feature.layer.id).removeLayer(entry.layer);
      this.layers.delete(id);
    }
    for (const f of features.values()) {
      if (this.layers.has(f.id)) continue;
      const layer = this.build(f);
      this.group(f.layer.id).addLayer(layer);
      this.layers.set(f.id, { feature: f, layer });
    }
  }

  setVisible(layerId, visible) {
    const group = this.group(layerId);
    if (visible) group.addTo(this.map);
    else group.remove();
  }

  clear() {
    for (const group of this.groups.values()) group.remove();
    this.groups.clear();
    this.layers.clear();
  }
}
