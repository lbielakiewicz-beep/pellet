// Cloudflare Worker: pośrednik między aplikacją Pellet a eModul (TECH / Defro).
// - GET /status   – aktualny stan pieca (na żywo z eModul)
// - GET /history?days=30 – odczyty zapisywane co 5 min (zasobnik, temperatury, stan – do liczenia uruchomień)
// - cron (*/5 * * * *) – zapis odczytu do KV (288 zapisów/dobę, w limicie darmowego KV)
// Dostęp tylko dla zalogowanych użytkowników aplikacji (token Firebase) z listy ALLOWED_EMAILS.
//
// Zmienne (Settings → Variables and Secrets):
//   EMODUL_TOKEN        (sekret)  token API z emodul.pl
//   ALLOWED_EMAILS      (tekst)   e-maile z dostępem, po przecinku
//   FIREBASE_PROJECT_ID (tekst)   pellet-b7fc1
//   EMODUL_USER_ID      (tekst, opcjonalnie) – gdy nie da się go odczytać z tokenu
//   EMODUL_USERNAME / EMODUL_PASSWORD (sekrety, opcjonalnie) – logowanie, gdy token wygaśnie
// Powiązanie (Bindings): KV namespace pod nazwą KV.

const API = 'https://emodul.pl/api/v1/';
const ORIGINS = ['https://lbielakiewicz-beep.github.io', 'http://localhost:8000', 'http://localhost:8765'];
const KEEP_DAYS = 400;

// najczęstsze teksty stanów (pełny słownik eModul ma 800 kB – nie ładujemy go za każdym razem)
const TXT = {
  65: 'Alarm', 239: 'Czyszczenie', 312: 'Kalibracja', 473: 'Ogrzewanie domu', 563: 'Podtrzymanie',
  587: 'Pompy równoległe', 594: 'Praca', 608: 'Priorytet bojlera', 671: 'Rozpalanie', 683: 'Podtrzymanie',
  684: 'Praca', 811: 'Tryb letni', 912: 'Wygaszanie', 924: 'Wyłączony', 1067: 'Wygaszony', 1068: 'Nadzór',
  2364: 'Wyłączony', 3894: 'Postój', 8223: 'Stabilizacja', 9819: 'Wygaszanie', 16829: 'Podtrzymanie',
  814: 'Tryb pracy', 1039: 'Stan sterownika', 550: 'Podajnik', 571: 'Pompa CO', 573: 'Pompa CWU', 1042: 'Grzałka',
  1050: 'Temperatura CO', 1041: 'Temperatura CWU', 791: 'Temperatura spalin', 795: 'Temperatura zewnętrzna',
};

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    const url = new URL(req.url);
    try {
      const who = await verifyFirebase(req, env);
      if (!who) return json(req, { error: 'unauthorized' }, 401);
      if (url.pathname === '/status') {
        const s = await readStatus(env);
        ctx.waitUntil(saveReading(env, s).catch(() => {}));
        return json(req, s);
      }
      if (url.pathname === '/history') {
        const days = Math.min(KEEP_DAYS, Math.max(1, Number(url.searchParams.get('days')) || 30));
        return json(req, await readHistory(env, days));
      }
      return json(req, { error: 'not found' }, 404);
    } catch (e) {
      return json(req, { error: String(e.message || e) }, 502);
    }
  },
  async scheduled(ev, env, ctx) {
    ctx.waitUntil(readStatus(env).then(s => saveReading(env, s)));
  },
};

// ---------- HTTP ----------
function cors(req) {
  const o = req.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(o) ? o : ORIGINS[0],
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
const json = (req, body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(req) },
});

// ---------- weryfikacja tokenu Firebase (RS256) ----------
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));
const b64uJson = s => JSON.parse(new TextDecoder().decode(b64u(s)));
let jwks = null, jwksAt = 0;

async function verifyFirebase(req, env) {
  const m = /^Bearer (.+)$/.exec(req.headers.get('Authorization') || '');
  if (!m) return null;
  const [h, p, sig] = m[1].split('.');
  if (!sig) return null;
  const head = b64uJson(h), pay = b64uJson(p);
  const pid = env.FIREBASE_PROJECT_ID;
  const now = Date.now() / 1000;
  if (head.alg !== 'RS256' || pay.aud !== pid || pay.iss !== `https://securetoken.google.com/${pid}` || pay.exp < now || pay.iat > now + 300) return null;
  if (!pay.email_verified) return null;
  const allowed = String(env.ALLOWED_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(String(pay.email || '').toLowerCase())) return null;
  if (!jwks || Date.now() - jwksAt > 3600e3) {
    const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    jwks = (await r.json()).keys; jwksAt = Date.now();
  }
  const jwk = jwks.find(k => k.kid === head.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(sig), new TextEncoder().encode(`${h}.${p}`));
  return ok ? pay.email : null;
}

// ---------- eModul ----------
async function token(env) { return (await env.KV.get('emodul-token')) || env.EMODUL_TOKEN; }

async function login(env) {
  const r = await fetch(API + 'authentication', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: env.EMODUL_USERNAME, password: env.EMODUL_PASSWORD }),
  });
  const j = await r.json();
  if (!j.authenticated) throw new Error('eModul: logowanie nieudane');
  await env.KV.put('emodul-token', j.token);
  await env.KV.put('emodul-uid', String(j.user_id));
  return j.token;
}

async function emodul(env, path) {
  const get = t => fetch(API + path, { headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' } });
  let r = await get(await token(env));
  if ((r.status === 401 || r.status === 403) && env.EMODUL_USERNAME && env.EMODUL_PASSWORD) r = await get(await login(env));
  if (!r.ok) throw new Error(`eModul HTTP ${r.status}`);
  return r.json();
}

async function userId(env) {
  if (env.EMODUL_USER_ID) return env.EMODUL_USER_ID;
  const k = await env.KV.get('emodul-uid');
  if (k) return k;
  try {
    const p = b64uJson(String(env.EMODUL_TOKEN).split('.')[1]);
    for (const f of ['user_id', 'userId', 'uid', 'id', 'sub']) if (p[f] != null) return String(p[f]);
  } catch { /* token nie jest JWT */ }
  throw new Error('Brak EMODUL_USER_ID');
}

async function text(env, id) {
  if (id == null) return '';
  if (TXT[id]) return TXT[id];
  const k = await env.KV.get(`txt:${id}`);
  if (k != null) return k;
  try { // rzadko: nieznany tekst – pobierz słownik raz i zapamiętaj ten wpis
    const r = await fetch(API + 'i18n/pl');
    const t = (await r.json()).data?.[String(id)] || `#${id}`;
    await env.KV.put(`txt:${id}`, t);
    return t;
  } catch { return `#${id}`; }
}

async function readStatus(env) {
  const uid = await userId(env);
  const mods = await emodul(env, `users/${uid}/modules`);
  const m = (env.EMODUL_UDID && mods.find(x => x.udid === env.EMODUL_UDID)) || mods.find(x => x.default) || mods[0];
  if (!m) throw new Error('Brak sterownika w eModul');
  const d = await emodul(env, `users/${uid}/modules/${m.udid}`);
  const tiles = (d.tiles || []).filter(t => t.visibility !== false);
  const temp = txtId => { const t = tiles.find(x => x.type === 1 && x.params?.txtId === txtId); return t ? t.params.value / 10 : null; };
  const relay = txtId => { const t = tiles.find(x => x.type === 11 && x.params?.txtId === txtId); return t ? !!t.params.workingStatus : null; };
  const fuel = tiles.find(t => t.type === 31)?.params;
  const fan = tiles.find(t => t.type === 22)?.params;
  const fire = tiles.find(t => t.type === 2)?.params;
  const texts = {};
  for (const t of tiles.filter(x => x.type === 40)) texts[await text(env, t.params?.headerId)] = await text(env, t.params?.statusId);
  return {
    ts: Date.now(),
    name: m.name, controller: m.version, online: m.controllerStatus === 'active',
    fuelPct: fuel?.percentage ?? null, fuelHours: fuel?.hours ?? null,
    tempCO: temp(1050), tempCWU: temp(1041), tempFlue: temp(791), tempOut: temp(795),
    feeder: relay(550), pumpCO: relay(571), pumpCWU: relay(573), heater: relay(1042),
    fanGear: fan?.gear ?? null, fire: fire?.value ?? null,
    state: texts['Stan sterownika'] || null, mode: texts['Tryb pracy'] || null,
  };
}

// ---------- historia w KV: jeden klucz na dzień ----------
const day = t => new Date(t).toISOString().slice(0, 10);

async function saveReading(env, s) {
  const key = `r:${day(s.ts)}`;
  const arr = (await env.KV.get(key, 'json')) || [];
  const last = arr[arr.length - 1];
  if (last && s.ts - last[0] < 4 * 60e3) return; // nie częściej niż co ~5 min (zapas na opóźnienia crona)
  arr.push([s.ts, s.fuelPct, s.tempOut, s.tempCO, s.feeder ? 1 : 0, s.state]);
  await env.KV.put(key, JSON.stringify(arr), { expirationTtl: KEEP_DAYS * 86400 });
}

async function readHistory(env, days) {
  const now = Date.now();
  const keys = Array.from({ length: days }, (_, i) => `r:${day(now - (days - 1 - i) * 86400e3)}`);
  const parts = await Promise.all(keys.map(k => env.KV.get(k, 'json')));
  return { fields: ['ts', 'fuelPct', 'tempOut', 'tempCO', 'feeder', 'state'], rows: parts.filter(Boolean).flat() };
}
