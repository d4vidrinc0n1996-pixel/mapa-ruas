// Registro de países. Para agregar uno nuevo: crea js/countries/<código>.js con
// la misma forma que co.js, añádelo aquí y en la lista SHELL de sw.js.
// bounds permite sugerir el país correcto cuando el punto consultado cae fuera del actual.

export const COUNTRIES = [
  { code: 'CO', name: 'Colombia', bounds: [[-4.3, -82.0], [13.6, -66.8]], load: () => import('./co.js') },
  { code: 'ES', name: 'España', bounds: [[27.4, -18.5], [44.0, 4.6]], load: () => import('./es.js') },
  { code: 'US', name: 'Estados Unidos', bounds: [[18.5, -179.9], [71.5, -64.5]], load: () => import('./us.js') },
];

export async function loadCountry(code) {
  const entry = COUNTRIES.find((c) => c.code === code) ?? COUNTRIES[0];
  return (await entry.load()).default;
}

export function countryAt([lat, lon], exceptCode) {
  return COUNTRIES.find(({ code, bounds: [[s, w], [n, e]] }) => code !== exceptCode && lat >= s && lat <= n && lon >= w && lon <= e);
}
