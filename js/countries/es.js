// España — zonas geográficas UAS oficiales de ENAIRE, en formato ED-269.

import { ED269 } from '../sources.js';

const ENAIRE = 'https://servais.enaire.es/insignia/rest/services/NSF_SRV/SRV_UAS_ZG_V1/FeatureServer';

export default {
  code: 'ES',
  name: 'España',
  flag: '🇪🇸',
  center: [40.2, -3.7],
  zoom: 6,
  bounds: [[27.4, -18.5], [44.0, 4.6]],
  maxAltitudeM: 120,
  cautionMarginM: 300,
  authority: {
    name: 'Agencia Estatal de Seguridad Aérea (AESA)',
    regulation: 'Reglamentos (UE) 2019/947 y 2019/945 y normativa nacional',
    url: 'https://www.seguridadaerea.gob.es/es/ambitos/drones',
  },
  dataSource: {
    name: 'ENAIRE — Zonas geográficas UAS (ED-269)',
    url: 'https://drones.enaire.es',
  },

  layers: [
    {
      id: 'urbano',
      label: 'Zonas urbanas',
      legend: 'Núcleos de población',
      source: { type: 'arcgis', url: `${ENAIRE}/3` },
      ...ED269,
    },
    {
      id: 'aero',
      label: 'Zonas aeronáuticas',
      legend: 'Aeródromos y espacio aéreo controlado',
      legendCategory: 'restricted',
      source: { type: 'arcgis', url: `${ENAIRE}/2`, tiled: { tileDeg: 0.5, minZoom: 8 } },
      ...ED269,
    },
    {
      id: 'infra',
      label: 'Infraestructuras',
      legend: 'Ferrocarril, energía, instalaciones sensibles',
      legendCategory: 'caution',
      source: { type: 'arcgis', url: `${ENAIRE}/0`, simplify: 0.0001, tiled: { tileDeg: 0.25, minZoom: 11 } },
      ...ED269,
    },
  ],

  generalRules: [
    'Altura máxima de 120 m sobre el terreno en categoría abierta.',
    'Registra tu condición de operador en AESA y lleva el número visible en el dron (si pesa 250 g o más, o tiene cámara).',
    'Obtén el certificado de piloto que exija la subcategoría (A1/A3, A2) y contrata un seguro.',
    'Mantén el dron siempre en línea de vista (VLOS) y cede el paso a aeronaves tripuladas.',
    'No sobrevueles aglomeraciones de personas.',
    'En zonas geográficas que requieren autorización, solicítala al gestor indicado antes de volar.',
    'Consulta NOTAM y restricciones temporales en la app ENAIRE Drones antes de cada vuelo.',
  ],
};
