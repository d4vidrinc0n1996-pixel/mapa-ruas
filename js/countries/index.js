// Registro de países. Para agregar uno nuevo: crea js/countries/<código>.js con
// la misma forma que co.js y añádelo aquí.

export const COUNTRIES = [
  { code: 'CO', name: 'Colombia', flag: '🇨🇴', load: () => import('./co.js') },
];

export async function loadCountry(code) {
  const entry = COUNTRIES.find((c) => c.code === code) ?? COUNTRIES[0];
  return (await entry.load()).default;
}
