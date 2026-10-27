// Extrae de OpenStreetMap (Overpass) los miradores y cascadas de un país y los guarda
// como GeoJSON compacto para la capa de sitios de interés.
// Uso: node tools/update-osm-sitios.mjs [código ISO, por defecto CO]

import { writeFileSync, mkdirSync } from 'node:fs';

const code = (process.argv[2] ?? 'CO').toUpperCase();
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const query = `[out:json][timeout:240];
area["ISO3166-1"="${code}"]["admin_level"="2"]->.pais;
(
  nwr["tourism"="viewpoint"](area.pais);
  node["waterway"="waterfall"](area.pais);
  node["natural"="waterfall"](area.pais);
);
out center tags;`;

// Los servidores públicos de Overpass se saturan a menudo: se prueban todos, varias rondas.
async function overpass(rounds = 3) {
  for (let round = 1; round <= rounds; round++) {
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          body: new URLSearchParams({ data: query }),
          headers: { 'User-Agent': 'MapaRUAS (+https://github.com/d4vidrinc0n1996-pixel/mapa-ruas)' },
        });
        if (res.ok) return res.json();
        console.warn(`${url}: HTTP ${res.status}`);
      } catch (err) {
        console.warn(`${url}: ${err.message}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 15000 * round));
  }
  throw new Error('Ningún servidor Overpass respondió');
}

const data = await overpass();
const features = data.elements
  .map((el) => {
    const t = el.tags ?? {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null) return null;
    const type = t.tourism === 'viewpoint' ? 'mirador' : 'cascada';
    const props = { name: t.name ?? t['name:es'] ?? null, type };
    const ele = parseFloat(t.ele);
    if (Number.isFinite(ele)) props.ele = Math.round(ele);
    props.osm = `${el.type}/${el.id}`;
    return { type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [+lon.toFixed(5), +lat.toFixed(5)] } };
  })
  .filter(Boolean);

const dir = new URL(`../data/${code.toLowerCase()}/`, import.meta.url);
mkdirSync(dir, { recursive: true });
const file = new URL('miradores-osm.geojson', dir);
writeFileSync(
  file,
  JSON.stringify({
    type: 'FeatureCollection',
    generated: new Date().toISOString().slice(0, 10),
    attribution: '© colaboradores de OpenStreetMap (ODbL)',
    features,
  }),
);
const byType = features.reduce((acc, f) => ({ ...acc, [f.properties.type]: (acc[f.properties.type] ?? 0) + 1 }), {});
console.log(`${features.length} sitios (${JSON.stringify(byType)}) → ${file.pathname}`);
