// Dane z pieca (eModul) przez własnego pośrednika – Cloudflare Worker (worker/emodul-proxy.js).
import { piecUrl } from './firebase-config.js';

const HOUR = 3600e3;
const JUMP_PCT = 10;          // wzrost poziomu o min. tyle punktów % = dosypanie
const MATCH_WINDOW = 4 * HOUR; // ręczny wpis w tym oknie = to samo dosypanie
const LOOKBACK = 14 * 24 * HOUR;
const CACHE = 'pellet-piec-v1';

let st = { status: null, rows: [], error: '', loading: false, at: 0 };
try { const c = JSON.parse(localStorage.getItem(CACHE)); if (c) st = { ...st, status: c.status, rows: c.rows || [] }; } catch { /* brak */ }

export const piecConfigured = () => !!piecUrl;
export const piec = () => st;

async function call(path, token) {
  const r = await fetch(piecUrl.replace(/\/$/, '') + path, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 ? 'Brak dostępu do pieca (e-mail nie jest na liście w Workerze?)' : j.error || `HTTP ${r.status}`);
  return j;
}

/** Pobiera stan i historię. getToken: () => Promise<token Firebase>. */
export async function refreshPiec(getToken) {
  if (!piecUrl || st.loading || Date.now() - st.at < 60e3) return false;
  st.loading = true;
  try {
    const token = await getToken();
    if (!token) return false;
    const [status, hist] = await Promise.all([call('/status', token), call('/history?days=30', token)]);
    st = { status, rows: hist.rows || [], error: '', loading: false, at: Date.now() };
    try { localStorage.setItem(CACHE, JSON.stringify({ status, rows: st.rows })); } catch { /* pełna pamięć */ }
    return true;
  } catch (e) {
    st.error = e.message || String(e);
    return true;
  } finally {
    st.loading = false;
  }
}

/** Skoki poziomu zasobnika w górę (dosypania) z historii odczytów. */
export function levelJumps(rows = st.rows) {
  const pts = rows.filter(r => r[1] != null).sort((a, b) => a[0] - b[0]);
  const jumps = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (b[1] - a[1] < JUMP_PCT) continue;
    const prev = jumps[jumps.length - 1];
    // kilka worków wsypanych w odstępach – łączymy w jedno dosypanie
    if (prev && a[0] - prev.ts <= 2 * HOUR) { prev.ts = b[0]; prev.to = b[1]; }
    else jumps.push({ start: a[0], ts: b[0], from: a[1], to: b[1] });
  }
  return jumps;
}

const matchFill = (j, fills) => fills.find(f => f.ts >= j.start - MATCH_WINDOW && f.ts <= j.ts + MATCH_WINDOW);

// Na panelu pieca można zaznaczyć tylko „napełniono do pełna” – wtedy poziom wraca do 100%,
// a potem piec odlicza spalone paliwo z pracy podajnika. Dosypań częściowych piec nie widzi.
const nearJump = (f, jumps) => jumps.some(j => f.ts >= j.start - MATCH_WINDOW && f.ts <= j.ts + MATCH_WINDOW);

/** Ręczne dosypania bez napełnienia do pełna w przedziale (from, to] – piec ich nie wliczył. */
function partialBetween(fills, jumps, from, to) {
  return fills.filter(f => f.ts > from && f.ts <= to && !nearJump(f, jumps));
}

/** Worki dosypane od ostatniego „napełniono do pełna” na panelu – do doliczenia do poziomu z pieca. */
export function partialFills(fills, rows = st.rows) {
  const jumps = levelJumps(rows);
  const first = rows.length ? Math.min(...rows.map(r => r[0])) : Infinity;
  const since = Math.max(first, jumps.length ? jumps[jumps.length - 1].ts : -Infinity);
  const list = partialBetween(fills, jumps, since, Date.now());
  return { bags: list.reduce((s, f) => s + (f.bags || 0), 0), list };
}

/** Pojemność zasobnika w workach: z ustawień albo wyliczona z dosypań do pełna wpisanych ręcznie. */
export function hopperBags(settings, fills, rows = st.rows) {
  if (settings.hopperBags > 0) return { bags: settings.hopperBags, estimated: false };
  const jumps = levelJumps(rows);
  const ratios = jumps
    .map((j, i) => {
      // częściowe dosypania przed tym napełnieniem zaniżyły poziom „przed” – taki skok nie nadaje się do wyliczenia
      if (i > 0 && partialBetween(fills, jumps, jumps[i - 1].ts, j.start).length) return null;
      const f = matchFill(j, fills);
      return f ? f.bags / ((j.to - j.from) / 100) : null;
    })
    .filter(x => x > 0).sort((a, b) => a - b);
  if (!ratios.length) return null;
  return { bags: Math.round(ratios[Math.floor(ratios.length / 2)] * 10) / 10, estimated: true };
}

/** Ostatnie ręczne dosypanie (do 24 h), po którym poziom w piecu nie wzrósł – częściowe albo niezaznaczone na panelu. */
export function unconfirmedFill(fills, rows = st.rows) {
  const now = Date.now();
  const f = fills.filter(x => x.ts <= now - HOUR && x.ts >= now - 24 * HOUR).sort((a, b) => b.ts - a.ts)[0];
  if (!f) return null;
  if (!rows.some(r => r[0] >= f.ts + HOUR && r[1] != null)) return null; // brak świeżych odczytów – nie wiadomo
  return levelJumps(rows).some(j => j.ts >= f.ts - MATCH_WINDOW && j.start <= f.ts + MATCH_WINDOW) ? null : f;
}

/** Dosypania wykryte przez piec, których nie ma we wpisach i których nie odrzucono. */
export function pendingRefills(settings, fills) {
  const dismissed = new Set(settings.dismissedRefills || []);
  const cap = hopperBags(settings, fills);
  return levelJumps()
    .filter(j => j.ts >= Date.now() - LOOKBACK && !dismissed.has(j.ts) && !matchFill(j, fills))
    .map(j => ({ ...j, bags: cap ? Math.max(1, Math.round(((j.to - j.from) / 100) * cap.bags)) : null }));
}

// ---------- uruchomienia palnika ----------
// Stany „pracuje” i „nie pracuje”; pozostałe (Alarm, Czyszczenie, nieznane) nie zmieniają oceny.
// Rozpoznajemy po początku nazwy – sterowniki dopisują warianty, np. „Praca PID”.
const KINDS = [
  [/^rozpal/i, 'ignite', true], [/^(praca|stabiliz)/i, 'on', true], [/^podtrzym/i, 'low', true],
  [/^wygaszanie/i, 'fade', false], [/^(wygaszon|postój|nadzór)/i, 'off', false], [/^wyłącz/i, 'power', false],
  [/alarm/i, 'alarm', null], [/^(czyszcz|kalibr)/i, 'clean', null],
];

/** Rodzaj stanu sterownika: { kind, on } – on: true pali się, false nie, null nie wiadomo (alarm, czyszczenie, nieznany). */
export function stateKind(state) {
  const k = KINDS.find(([re]) => re.test(String(state || '').trim()));
  return k ? { kind: k[1], on: k[2] } : { kind: 'unknown', on: null };
}

/** Cykle pracy z historii stanów: [{ start, end }] – start = przejście z postoju do pracy (lub nowe rozpalanie). */
export function burnerCycles(rows = st.rows) {
  const pts = rows.filter(r => r[5]).sort((a, b) => a[0] - b[0]);
  const cycles = [];
  let on = null, prevState = null;
  for (const [ts, , , , , state] of pts) {
    const { kind, on: isOn } = stateKind(state);
    if (isOn === true) {
      const restart = kind === 'ignite' && stateKind(prevState).kind !== 'ignite' && on === true;
      if (on === false || restart) {
        if (restart && cycles.length && cycles[cycles.length - 1].end == null) cycles[cycles.length - 1].end = ts;
        cycles.push({ start: ts, end: null });
      }
    } else if (isOn === false && on === true && cycles.length && cycles[cycles.length - 1].end == null) {
      cycles[cycles.length - 1].end = ts;
    }
    if (isOn != null) on = isOn;
    prevState = state;
  }
  return cycles;
}

/** Statystyki uruchomień: dziś, średnio na dobę (do 7 dni wstecz) i średni czas cyklu. */
export function burnerStats(rows = st.rows) {
  const withState = rows.filter(r => r[5]);
  if (withState.length < 2) return null;
  const now = Date.now();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const first = Math.min(...withState.map(r => r[0]));
  const cycles = burnerCycles(rows);
  const span = Math.min(7 * 24 * HOUR, now - first);
  const inSpan = cycles.filter(c => c.start >= now - span);
  const done = inSpan.filter(c => c.end != null);
  return {
    today: cycles.filter(c => c.start >= midnight.getTime()).length,
    perDay: span >= 24 * HOUR ? inSpan.length / (span / (24 * HOUR)) : null,
    days: Math.round(span / (24 * HOUR)),
    avgCycleMin: done.length ? done.reduce((s, c) => s + (c.end - c.start), 0) / done.length / 60e3 : null,
  };
}
