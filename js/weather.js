// Pogoda z Open-Meteo (darmowe, bez klucza). Wyniki są buforowane lokalnie,
// a temperatury z przeszłości zbierane w historii – model uczy się na nich.
import { buildClimatology, ymd } from './forecast.js';

const KEY = 'pellet-weather-v1';
const FC_TTL = 3600 * 1000;
const CLIM_TTL = 60 * 86400 * 1000;

function loadCache() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function saveCache(c) {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* pełna pamięć – pomijamy */ }
}

function dailyMeans(json) {
  const d = json.daily, out = {};
  for (let i = 0; i < d.time.length; i++) {
    const mx = d.temperature_2m_max[i], mn = d.temperature_2m_min[i];
    if (mx != null && mn != null) out[d.time[i]] = Math.round(((mx + mn) / 2) * 10) / 10;
  }
  return out;
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo: HTTP ${r.status}`);
  return r.json();
}

/**
 * Zwraca { history, forecast, climatology, updatedAt } albo null, gdy brak lokalizacji.
 * history/forecast: { 'YYYY-MM-DD': temp }, climatology: { 'MM-DD': temp }
 */
export async function getWeather(lat, lon, { force = false } = {}) {
  if (lat == null || lon == null) return null;
  const loc = `${(+lat).toFixed(2)},${(+lon).toFixed(2)}`;
  let c = loadCache();
  if (c.loc !== loc) c = { loc, history: {} };
  const now = Date.now();
  const today = ymd(now);

  try {
    if (force || !c.forecast || !c.days || now - (c.fcAt || 0) > FC_TTL) {
      const j = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day` +
        `&past_days=92&forecast_days=16&timezone=auto`);
      const all = dailyMeans(j);
      // szczegóły dni od dziś (do panelu pogody)
      const d = j.daily;
      c.days = {};
      for (let i = 0; i < d.time.length; i++) {
        if (d.time[i] < today) continue;
        c.days[d.time[i]] = { max: d.temperature_2m_max[i], min: d.temperature_2m_min[i], code: d.weather_code[i], rain: d.precipitation_sum[i] };
      }
      const cu = j.current || {};
      c.current = { temp: cu.temperature_2m, feels: cu.apparent_temperature, hum: cu.relative_humidity_2m, code: cu.weather_code, wind: cu.wind_speed_10m, isDay: cu.is_day !== 0 };
      c.forecast = {};
      for (const [k, v] of Object.entries(all)) {
        if (k < today) c.history[k] = v; else c.forecast[k] = v;
      }
      // historia: zostawiamy ok. 2 lata
      const cutoff = ymd(now - 730 * 86400000);
      for (const k of Object.keys(c.history)) if (k < cutoff) delete c.history[k];
      c.fcAt = now;
    }
    if (force || !c.climatology || now - (c.climAt || 0) > CLIM_TTL) {
      const end = new Date(now - 7 * 86400000);
      const start = new Date(end); start.setFullYear(start.getFullYear() - 5);
      const j = await getJson(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
        `&start_date=${ymd(start)}&end_date=${ymd(end)}&daily=temperature_2m_max,temperature_2m_min&timezone=auto`);
      const temps = dailyMeans(j);
      c.climatology = buildClimatology(temps);
      // archiwum uzupełnia też historię (do nauki modelu na starszych wpisach)
      const cutoff = ymd(now - 730 * 86400000);
      for (const [k, v] of Object.entries(temps)) if (k >= cutoff && c.history[k] == null) c.history[k] = v;
      c.climAt = now;
    }
    saveCache(c);
  } catch (e) {
    console.warn('Pogoda niedostępna, używam bufora', e);
    if (!c.forecast && !c.climatology) return { history: c.history || {}, forecast: {}, climatology: {}, current: null, days: {}, updatedAt: null, error: e.message };
  }
  return { history: c.history, forecast: c.forecast || {}, climatology: c.climatology || {}, current: c.current || null, days: c.days || {}, updatedAt: c.fcAt || null };
}

/** Szukanie miejscowości. */
export async function geocode(name) {
  const j = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=6&language=pl&format=json`);
  return (j.results || []).map(r => ({
    name: [r.name, r.admin1, r.country_code].filter(Boolean).join(', '),
    lat: Math.round(r.latitude * 1000) / 1000,
    lon: Math.round(r.longitude * 1000) / 1000,
  }));
}

/** Kod pogody WMO → [ikona, opis]. */
export function weatherInfo(code, isDay = true) {
  const c = Number(code);
  if (c === 0) return [isDay ? '☀️' : '🌙', 'bezchmurnie'];
  if (c === 1) return [isDay ? '🌤️' : '🌙', 'przeważnie pogodnie'];
  if (c === 2) return ['⛅', 'częściowe zachmurzenie'];
  if (c === 3) return ['☁️', 'pochmurno'];
  if (c === 45 || c === 48) return ['🌫️', 'mgła'];
  if (c >= 51 && c <= 57) return ['🌦️', 'mżawka'];
  if (c >= 61 && c <= 67) return ['🌧️', 'deszcz'];
  if (c >= 71 && c <= 77) return ['🌨️', 'śnieg'];
  if (c >= 80 && c <= 82) return ['🌦️', 'przelotny deszcz'];
  if (c === 85 || c === 86) return ['🌨️', 'przelotny śnieg'];
  if (c >= 95) return ['⛈️', 'burza'];
  return ['🌡️', ''];
}

/** Temperatura dla dnia: prognoza → historia → klimatologia. */
export function tempLookup(w) {
  if (!w) return () => null;
  return d => w.forecast[d] ?? w.history[d] ?? w.climatology[d.slice(5)] ?? null;
}
