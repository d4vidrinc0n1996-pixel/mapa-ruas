// Estados Unidos — capas públicas de la FAA (UAS Data Delivery System).

const FAA = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services';
const service = (name, extra = {}) => ({ type: 'arcgis', url: `${FAA}/${name}/FeatureServer/0`, ...extra });
const FT = 0.3048;

const SUA_TYPE = {
  P: 'Prohibida',
  R: 'Restringida',
  MOA: 'Operaciones militares (MOA)',
  W: 'Advertencia',
  A: 'Alerta',
  D: 'Peligro',
};

export default {
  code: 'US',
  name: 'Estados Unidos',
  flag: '🇺🇸',
  center: [39.5, -98.35],
  zoom: 4,
  bounds: [[18.5, -179.9], [71.5, -64.5]],
  maxAltitudeM: 122,
  cautionMarginM: 300,
  authority: {
    name: 'Federal Aviation Administration (FAA)',
    regulation: '14 CFR Part 107 y 49 U.S.C. 44809 (recreativo)',
    url: 'https://www.faa.gov/uas',
  },
  dataSource: {
    name: 'FAA UAS Data Delivery System',
    url: 'https://udds-faa.opendata.arcgis.com',
  },

  layers: [
    {
      id: 'sua',
      label: 'Espacio aéreo de uso especial',
      legend: 'Prohibido (P), restringido (R), MOA, alerta',
      legendCategory: 'restricted',
      source: service('Special_Use_Airspace', { simplify: 0.0003 }),
      category: (p) => ({ P: 'prohibited', R: 'restricted' })[p.TYPE_CODE] ?? 'caution',
      name: (p) => p.NAME,
      subtitle: (p) =>
        [SUA_TYPE[p.TYPE_CODE], `${p.LOWER_VAL ?? 0}–${p.UPPER_DESC === 'UNL' ? 'ilimitado' : p.UPPER_VAL} ft`, p.TIMESOFUSE]
          .filter(Boolean)
          .join(' · '),
      details: (p) => [p.CONT_AGENT && `Controla: ${p.CONT_AGENT}`, p.COMM_NAME].filter(Boolean).join('\n'),
    },
    {
      id: 'laanc',
      label: 'Espacio controlado (LAANC)',
      legend: 'Requiere autorización; techo autorizable',
      source: service('FAA_UAS_FacilityMap_Data', { tiled: { tileDeg: 0.5, minZoom: 9 } }),
      category: 'restricted',
      name: (p) => (p.APT1_NAME ? `${p.APT1_NAME} (${p.APT1_ICAO || p.APT1_FAAID})` : 'Espacio aéreo controlado'),
      subtitle: (p) => `Techo autorizable: ${p.CEILING} ft (${Math.round(p.CEILING * FT)} m)`,
      details: (p) =>
        Number(p.CEILING) > 0
          ? `Requiere autorización por LAANC o FAADroneZone. Altura máxima autorizable aquí: ${p.CEILING} ft sobre el terreno.`
          : 'No hay autorización automática por LAANC: solicítala en FAADroneZone.',
    },
    {
      id: 'nda',
      label: 'Defensa nacional (TFR)',
      source: service('National_Defense_Airspace_TFR_Areas'),
      category: 'prohibited',
      name: (p) => p.NAME,
      subtitle: (p) => p.WKHR_RMK,
    },
    {
      id: 'seguridad',
      label: 'Restricciones de seguridad nacional',
      source: service('Part_Time_National_Security_UAS_Flight_Restrictions'),
      category: 'prohibited',
      name: (p) => p.Facility,
      subtitle: (p) => [p.Floor, p.Ceiling].filter(Boolean).join(' – '),
      details: (p) => [p.Reason, p.ADVISENOTE].filter(Boolean).join('\n'),
    },
    {
      id: 'estadios',
      label: 'Estadios',
      legend: 'TFR de 3 NM durante eventos',
      source: service('Stadiums'),
      category: 'caution',
      radiusM: 5556,
      name: (p) => p.NAME,
      subtitle: (p) => [p.CITY, p.STATE].filter(Boolean).join(', '),
      note: 'Prohibido volar a menos de 3 NM y por debajo de 3.000 ft desde 1 h antes hasta 1 h después de eventos con 30.000 personas o más.',
    },
  ],

  generalRules: [
    'Altura máxima de 400 ft (122 m) sobre el terreno.',
    'En espacio aéreo controlado (clases B, C, D y E de superficie) necesitas autorización: LAANC o FAADroneZone.',
    'Registra el dron en FAADroneZone si pesa más de 250 g o vuelas bajo la Parte 107, y cumple con Remote ID.',
    'Uso recreativo: aprueba el TRUST. Uso comercial: certificado de piloto remoto (Parte 107).',
    'Mantén el dron en línea de vista y no vueles sobre personas ni vehículos en movimiento sin cumplir los requisitos.',
    'Consulta TFR y NOTAM vigentes antes de volar: no todos aparecen en este mapa.',
  ],
};
