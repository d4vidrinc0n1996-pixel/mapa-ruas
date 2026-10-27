// Colombia — capas oficiales del Visor Geográfico UAS (RUAS) de la Aerocivil.
// Las restricciones y radios provienen de las observaciones publicadas en cada capa.

const RUAS = 'https://services7.arcgis.com/oJtolNh5k8HxCVtB/arcgis/rest/services/UAS_WEBLAYER/FeatureServer';
const arcgis = (...ids) => ({ type: 'arcgis', url: ids.map((id) => `${RUAS}/${id}`) });

const AIP_CATEGORY = {
  PROHIBIDA: 'prohibited',
  PELIGROSA: 'prohibited',
  RESTRINGIDA: 'restricted',
  MILITAR: 'restricted',
  ENTRENAMIENTO: 'restricted',
};

const capitalize = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : '');

// Registro Único Nacional de Áreas Protegidas, servido por Parques Nacionales Naturales.
const RUNAP = 'https://mapas.parquesnacionales.gov.co/arcgis/rest/services/pnn/runap/MapServer/0';

// Áreas del Sistema de Parques Nacionales: volar drones exige autorización de PNN.
// El resto (regionales, reservas forestales, distritos) depende de cada autoridad ambiental.
const SISTEMA_PNN = new Set([
  'Parque Nacional Natural',
  'Santuario de Fauna y Flora',
  'Santuario de Flora',
  'Reserva Natural',
  'Área Natural Única',
  'Vía Parque',
]);

// Varios helipuertos no traen NOMBRE: se usa el explotador y el código OACI.
const heliport = {
  name: (p) => p.NOMBRE ?? [p.NOMBRE_DEL_EXPLOTADOR, p.DESIGNADOR_OACI].filter(Boolean).join(' — '),
  subtitle: (p) => [capitalize(p.MUNICIPIO ?? p.DEPARTAMENTO), p.NOMBRE ? p.DESIGNADOR_OACI : null].filter(Boolean).join(' · '),
  details: (p) => p.OBSERVACIONES,
};

export default {
  code: 'CO',
  name: 'Colombia',
  flag: '🇨🇴',
  center: [4.6, -74.1],
  zoom: 6,
  bounds: [[-4.3, -82.0], [13.6, -66.8]],
  maxAltitudeM: 123,
  cautionMarginM: 500,
  authority: {
    name: 'Aeronáutica Civil de Colombia (Aerocivil)',
    regulation: 'RAC 100 y AIP Colombia',
    url: 'https://www.aerocivil.gov.co/servicios-a-la-navegacion/sistema-%20de-aeronaves-pilotadas-a-distancia-rpas-drones/Paginas/default.aspx',
  },
  dataSource: {
    name: 'Visor Geográfico UAS (RUAS) — Aerocivil',
    url: 'https://aerocivil.maps.arcgis.com/apps/instant/media/index.html?appid=b4be4d501c8d4bcabd0c35297521c16e',
  },

  // Orden de dibujo: de abajo hacia arriba.
  layers: [
    {
      id: 'protegidas',
      label: 'Áreas protegidas (RUNAP)',
      legend: 'Parques Nacionales: autorización · regionales: consultar',
      legendCategory: 'restricted',
      source: {
        type: 'arcgis',
        format: 'esrijson',
        url: RUNAP,
        // Las reservas de la sociedad civil son predios privados: se omiten.
        where: "ap_categoria <> 'Reserva Natural de la Sociedad Civil'",
        outFields: 'ap_categoria,ap_nombre,organizacion,url',
        orderBy: 'objectid',
        simplify: 0.0004,
        pageSize: 1000,
      },
      category: (p) => (SISTEMA_PNN.has(p.ap_categoria) ? 'restricted' : 'caution'),
      name: (p) => `${p.ap_categoria} ${p.ap_nombre}`,
      subtitle: (p) => p.organizacion,
      details: (p) =>
        [
          SISTEMA_PNN.has(p.ap_categoria)
            ? 'Área del Sistema de Parques Nacionales: para volar drones necesitas autorización de Parques Nacionales Naturales de Colombia.'
            : 'Área protegida: consulta a la autoridad ambiental que la administra las restricciones para drones antes de volar.',
          p.url ? `Más información: ${p.url}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
    },
    {
      id: 'aip',
      label: 'Áreas AIP',
      legend: 'Prohibidas, peligrosas, restringidas, militares',
      legendCategory: 'restricted',
      source: arcgis(80),
      category: (p) => AIP_CATEGORY[p['CLASIFICACIÓN']] ?? 'restricted',
      name: (p) => `${p.DESIGNADOR} — ${capitalize(p['UBICACIÓN'])}`,
      subtitle: (p) => `${capitalize(p['CLASIFICACIÓN'])} · ${p.LIMITES_VERTICALES}`,
      details: (p) => p.OBSERVACIONES,
    },
    {
      id: 'deportiva',
      label: 'Aviación deportiva',
      legend: 'Coordinar con la dependencia ATS',
      source: arcgis(90),
      category: 'restricted',
      name: (p) => `${p.DESIGNADOR} — ${capitalize(p['UBICACIÓN'])}`,
      subtitle: (p) => [capitalize(p['CLASIFICACIÓN']), p.LIMITES_VERTICALES, p.FRECUENCIA].filter(Boolean).join(' · '),
      details: (p) => p.OBSERVACIONES,
    },
    {
      id: 'aeropuerto9',
      label: 'Aeropuertos — 6 a 9 km',
      legend: 'Altura máx. 61 m (200 ft)',
      source: arcgis(50),
      category: 'limited',
      maxAltitudeM: 61,
      // 61 m sobre la elevación de referencia del aeródromo: con la elevación del terreno
      // se obtiene la altura real disponible en cada punto.
      ceilingAmslM: (p) => (p['ELEVACIÓN_DE_REFERENCIA__m_'] != null ? Math.round(p['ELEVACIÓN_DE_REFERENCIA__m_'] + 61) : null),
      group: (p) => p.DESIGNADOR_OACI,
      name: (p) => `${p.NOMBRE_DEL_AD} (${p.DESIGNADOR_OACI})`,
      subtitle: (p) => [p.CIUDAD, p['TIPO_DE_OPERACIÓN'], p.FRECUENCIA__VHF_].filter(Boolean).join(' · '),
      details: (p) => p.OBSERVACIONES,
    },
    {
      id: 'aeropuerto6',
      label: 'Aeropuertos — radio 6 km',
      source: arcgis(40),
      category: 'prohibited',
      group: (p) => p.DESIGNADOR_OACI,
      name: (p) => p.DESIGNADOR_OACI,
      note:
        'Operación de UAS restringida en categorías abierta y específica dentro de 6 km del punto de referencia del aeródromo (ARP).',
    },
    {
      id: 'helipuerto',
      label: 'Helipuertos — radio 3 km',
      source: arcgis(60, 70),
      category: 'prohibited',
      ...heliport,
    },
    {
      id: 'infraestructura',
      label: 'Infraestructura aeronáutica',
      legend: 'Radares y estaciones',
      source: arcgis(100),
      category: 'prohibited',
      name: (p) => `Estación ${capitalize(p.ESTACION)}`,
      note: 'Infraestructura de navegación aérea: no sobrevolar.',
    },
    {
      id: 'znvd',
      label: 'Zonas de no vuelo dron (ZNVD)',
      legend: 'Policía, FF. MM., INPEC, energía…',
      source: arcgis(110),
      category: 'prohibited',
      name: (p) => p['UBICACIÓN'],
      subtitle: (p) => p.ENTIDAD,
      details: (p) => p.OBSERVACIONES,
    },
    {
      id: 'aeropuertos',
      label: 'Aeropuertos (ARP)',
      legend: 'Punto de referencia',
      source: arcgis(10),
      category: 'info',
      group: (p) => p.DESIGNADOR_OACI,
      name: (p) => p.DESIGNADOR_OACI,
    },
    {
      id: 'helipuertos',
      label: 'Helipuertos (HRP)',
      legend: 'Punto de referencia',
      source: arcgis(20, 30),
      category: 'info',
      ...heliport,
    },
  ],

  // Sitios de interés para volar. Cada marcador se colorea según el estado de vuelo del punto.
  pois: [
    {
      id: 'destacados',
      label: 'Sitios destacados',
      legend: 'Selección de paisajes icónicos',
      url: 'data/co/sitios.geojson',
      style: 'icon',
    },
    {
      id: 'miradores',
      label: 'Miradores y cascadas',
      legend: 'OpenStreetMap · visibles al acercar',
      url: 'data/co/miradores-osm.geojson',
      style: 'dot',
      minZoom: 9,
    },
  ],

  // La capa de 6 km sólo trae el código OACI: se completa con el nombre de la capa de 9 km.
  enrich(features) {
    const names = new Map();
    for (const f of features.values()) if (f.layer.id === 'aeropuerto9') names.set(f.group, f.name);
    for (const f of features.values()) {
      if ((f.layer.id === 'aeropuerto6' || f.layer.id === 'aeropuertos') && names.has(f.group)) f.name = names.get(f.group);
    }
  },

  generalRules: [
    'Altura máxima de 123 m (400 ft) sobre el terreno en categoría abierta.',
    'Aeropuertos: no operar dentro de 6 km del ARP. Entre 6 y 9 km, máximo 61 m (200 ft) sobre el umbral más bajo.',
    'Helipuertos: no operar en categoría abierta dentro de 3 km del HRP.',
    'Respeta las Zonas de No Vuelo Dron (instalaciones de Policía, Fuerzas Militares, INPEC, energía, Presidencia).',
    'En Parques Nacionales Naturales necesitas autorización de Parques Nacionales; en otras áreas protegidas, consulta a la autoridad ambiental.',
    'Mantén siempre el dron en línea de vista directa (VLOS) y cede el paso a aeronaves tripuladas.',
    'No sobrevueles aglomeraciones de personas.',
    'Antes de volar, consulta NOTAM y restricciones temporales que no aparecen en este mapa.',
  ],
};
