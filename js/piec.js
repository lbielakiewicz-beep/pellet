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

/** Pojemność zasobnika w workach: z ustawień albo wyliczona z dosypań wpisanych ręcznie. */
export function hopperBags(settings, fills, rows = st.rows) {
  if (settings.hopperBags > 0) return { bags: settings.hopperBags, estimated: false };
  const ratios = levelJumps(rows)
    .map(j => { const f = matchFill(j, fills); return f ? f.bags / ((j.to - j.from) / 100) : null; })
    .filter(x => x > 0).sort((a, b) => a - b);
  if (!ratios.length) return null;
  return { bags: Math.round(ratios[Math.floor(ratios.length / 2)] * 10) / 10, estimated: true };
}

/** Ostatnie ręczne dosypanie (do 24 h), po którym poziom w piecu nie wzrósł – zapewne niepotwierdzone na panelu. */
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
