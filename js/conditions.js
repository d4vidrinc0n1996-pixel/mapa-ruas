// Condiciones de vuelo: meteorología y sol (Open-Meteo), elevación del terreno
// (Open-Meteo, modelo Copernicus de 90 m) e índice geomagnético Kp (NOAA SWPC).

const WEATHER = {
  0: 'Despejado',
  1: 'Mayormente despejado',
  2: 'Parcialmente nublado',
  3: 'Nublado',
  45: 'Niebla',
  48: 'Niebla con escarcha',
  51: 'Llovizna ligera',
  53: 'Llovizna',
  55: 'Llovizna intensa',
  56: 'Llovizna helada',
  57: 'Llovizna helada',
  61: 'Lluvia ligera',
  63: 'Lluvia',
  65: 'Lluvia intensa',
  66: 'Lluvia helada',
  67: 'Lluvia helada',
  71: 'Nieve ligera',
  73: 'Nieve',
  75: 'Nieve intensa',
  77: 'Granizo fino',
  80: 'Chubascos ligeros',
  81: 'Chubascos',
  82: 'Chubascos fuertes',
  85: 'Chubascos de nieve',
  86: 'Chubascos de nieve',
  95: 'Tormenta',
  96: 'Tormenta con granizo',
  99: 'Tormenta con granizo',
};

// Umbrales orientativos para drones de consumo: ajústalos a tu equipo.
export const LIMITS = {
  gustBad: 40, // km/h
  gustCaution: 28,
  wind120Bad: 45,
  wind120Caution: 30,
  visibilityBad: 1000, // m
  visibilityCaution: 3000,
  rainProbCaution: 60, // %
  kpCaution: 5,
  kpBad: 7,
  sunsetCautionMin: 30,
};

export const describeWeather = (code) => WEATHER[code] ?? '—';

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Las horas de Open-Meteo vienen en hora local sin desfase: se les añade el del lugar.
function localDate(text, offsetSeconds) {
  const sign = offsetSeconds < 0 ? '-' : '+';
  const abs = Math.abs(offsetSeconds);
  const hh = String(Math.floor(abs / 3600)).padStart(2, '0');
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, '0');
  return new Date(`${text}:00${sign}${hh}:${mm}`);
}

export async function fetchWeather([lat, lon]) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    current:
      'temperature_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,is_day',
    hourly: 'wind_speed_120m,wind_direction_120m,precipitation_probability',
    daily: 'sunrise,sunset',
    timezone: 'auto',
    forecast_days: '2',
    wind_speed_unit: 'kmh',
  });
  const j = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`);
  const c = j.current;
  const offset = j.utc_offset_seconds ?? 0;
  const hour = c.time.slice(0, 13);
  const i = Math.max(0, j.hourly.time.findIndex((t) => t.startsWith(hour)));
  const nextHours = j.hourly.precipitation_probability.slice(i, i + 3).filter((v) => v != null);
  return {
    time: localDate(c.time, offset),
    temperature: c.temperature_2m,
    precipitation: c.precipitation,
    code: c.weather_code,
    cloudCover: c.cloud_cover,
    wind: c.wind_speed_10m,
    windDir: c.wind_direction_10m,
    gusts: c.wind_gusts_10m,
    wind120: j.hourly.wind_speed_120m[i],
    windDir120: j.hourly.wind_direction_120m[i],
    rainProb: nextHours.length ? Math.max(...nextHours) : null,
    visibility: c.visibility,
    isDay: c.is_day === 1,
    sunrise: localDate(j.daily.sunrise[0], offset),
    sunset: localDate(j.daily.sunset[0], offset),
    nextSunrise: localDate(j.daily.sunrise[1], offset),
    timezone: j.timezone,
  };
}

export async function fetchElevation([lat, lon]) {
  const j = await getJson(`https://api.open-meteo.com/v1/elevation?latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}`);
  return j.elevation?.[0] ?? null;
}

// Elevación de varios puntos a la vez (la API admite hasta 100 por petición).
export async function fetchElevations(points) {
  const out = [];
  for (let i = 0; i < points.length; i += 100) {
    const batch = points.slice(i, i + 100);
    const lat = batch.map(([la]) => la.toFixed(5)).join(',');
    const lon = batch.map(([, lo]) => lo.toFixed(5)).join(',');
    const j = await getJson(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
    out.push(...(j.elevation ?? []));
  }
  return out;
}

export async function fetchKp() {
  const [now, forecast] = await Promise.all([
    getJson('https://services.swpc.noaa.gov/json/planetary_k_index_1m.json'),
    getJson('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json').catch(() => []),
  ]);
  const last = now.at(-1);
  const horizon = Date.now() + 24 * 3600e3;
  const upcoming = forecast
    .filter((r) => !Array.isArray(r) && r.observed !== 'observed')
    .filter((r) => new Date(`${r.time_tag}Z`).getTime() <= horizon)
    .map((r) => Number(r.kp));
  return {
    kp: last ? Number(last.estimated_kp ?? last.kp_index) : null,
    max24h: upcoming.length ? Math.max(...upcoming) : null,
  };
}

// Veredicto de condiciones: 'good' | 'caution' | 'bad', con los motivos.
export function assess(weather, kp, now = new Date()) {
  const bad = [];
  const caution = [];
  if (weather) {
    if (!weather.isDay) bad.push('Es de noche');
    else {
      const minutesLeft = (weather.sunset - now) / 60000;
      if (minutesLeft > 0 && minutesLeft < LIMITS.sunsetCautionMin) caution.push(`Anochece en ${Math.round(minutesLeft)} min`);
    }
    if (weather.gusts >= LIMITS.gustBad) bad.push(`Ráfagas de ${Math.round(weather.gusts)} km/h`);
    else if (weather.gusts >= LIMITS.gustCaution) caution.push(`Ráfagas de ${Math.round(weather.gusts)} km/h`);
    if (weather.wind120 >= LIMITS.wind120Bad) bad.push(`Viento de ${Math.round(weather.wind120)} km/h a 120 m`);
    else if (weather.wind120 >= LIMITS.wind120Caution) caution.push(`Viento de ${Math.round(weather.wind120)} km/h a 120 m`);
    if (weather.precipitation > 0.1 || [55, 57, 63, 65, 67, 73, 75, 81, 82, 86, 95, 96, 99].includes(weather.code)) {
      bad.push(describeWeather(weather.code));
    } else if (weather.rainProb >= LIMITS.rainProbCaution) caution.push(`Probabilidad de lluvia ${weather.rainProb}%`);
    if (weather.visibility != null && weather.visibility < LIMITS.visibilityBad) bad.push('Visibilidad muy baja');
    else if (weather.visibility != null && weather.visibility < LIMITS.visibilityCaution) caution.push('Visibilidad reducida');
    if (weather.temperature <= 0 || weather.temperature >= 40) caution.push(`Temperatura de ${Math.round(weather.temperature)} °C (baterías)`);
  }
  if (kp?.kp != null) {
    if (kp.kp >= LIMITS.kpBad) bad.push(`Tormenta geomagnética (Kp ${kp.kp.toFixed(1)}): GPS poco fiable`);
    else if (kp.kp >= LIMITS.kpCaution) caution.push(`Actividad geomagnética (Kp ${kp.kp.toFixed(1)}): GPS degradado`);
  }
  return { level: bad.length ? 'bad' : caution.length ? 'caution' : 'good', reasons: [...bad, ...caution] };
}

export const kpLabel = (kp) =>
  kp == null ? '—' : kp < 4 ? 'tranquilo' : kp < 5 ? 'inestable' : kp < 7 ? 'tormenta' : 'tormenta fuerte';
