// Logika obliczeń: stan magazynu, model zużycia, prognoza.
// Czyste funkcje bez DOM – można je testować w Node.

export const DAY = 86400000;

export function ymd(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
export function addDays(t, n) {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
}
export const hdd = (t, base) => Math.max(0, base - t);

/** Początek sezonu grzewczego (1 września) dla danej chwili. */
export function seasonStart(t) {
  const d = new Date(t);
  const y = d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
  return new Date(y, 8, 1).getTime();
}
export function seasonLabel(t) {
  const y = new Date(seasonStart(t)).getFullYear();
  return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
}

/** Zdarzenia magazynowe posortowane w czasie. */
export function stockEvents(data) {
  const ev = [];
  for (const p of data.purchases) ev.push({ ts: parseYmd(p.date).getTime(), kind: 'purchase', kg: p.kg, ref: p });
  for (const f of data.fills) ev.push({ ts: f.ts, kind: 'fill', kg: f.kg, ref: f });
  for (const i of data.inventories) ev.push({ ts: i.ts, kind: 'inventory', kg: i.kg, ref: i });
  // przy tym samym czasie: spis z natury najpierw, potem zakup, potem zużycie
  const order = { inventory: 0, purchase: 1, fill: 2 };
  ev.sort((a, b) => a.ts - b.ts || order[a.kind] - order[b.kind]);
  return ev;
}

/** Aktualny stan magazynu w kg. */
export function computeStock(data) {
  let stock = 0;
  for (const e of stockEvents(data)) {
    if (e.kind === 'inventory') stock = e.kg;
    else if (e.kind === 'purchase') stock += e.kg;
    else stock -= e.kg;
  }
  return stock;
}

/**
 * Przedziały między kolejnymi dosypaniami. Pellet wsypany w chwili t_i
 * spala się do następnego dosypania t_{i+1}. Krótkie przedziały łączymy (min. 2 dni),
 * zbyt długie (przerwa w paleniu / brak wpisów) pomijamy.
 */
export function fillIntervals(fills, { minDays = 2, maxDays = 21 } = {}) {
  const s = fills.slice().sort((a, b) => a.ts - b.ts);
  const out = [];
  let cur = null;
  for (let i = 0; i < s.length - 1; i++) {
    const f = s[i], n = s[i + 1];
    if ((n.ts - f.ts) / DAY > maxDays) { cur = null; continue; }
    if (!cur) cur = { start: f.ts, end: n.ts, kg: f.kg };
    else { cur.end = n.ts; cur.kg += f.kg; }
    if ((cur.end - cur.start) / DAY >= minDays) { out.push(cur); cur = null; }
  }
  return out;
}

/** Suma stopniodni w przedziale [start,end) – z ułamkami dni. null gdy brak temperatur. */
export function hddIntegral(start, end, tempMap, base) {
  let h = 0;
  let t = start;
  while (t < end) {
    const next = Math.min(end, addDays(startOfDay(t), 1));
    const temp = tempMap[ymd(t)];
    if (temp == null) return null;
    h += hdd(temp, base) * (next - t) / DAY;
    t = next;
  }
  return h;
}

/**
 * Dopasowanie modelu: kg/dzień = a + b·HDD.
 * Zwraca { type: 'weather'|'average'|'manual'|'none', a, b, avg, spread, n }
 */
export function fitModel(data, tempMap, now = Date.now()) {
  const base = data.settings.baseTemp;
  const intervals = fillIntervals(data.fills).filter(iv => iv.end > now - 120 * DAY);

  // średnia z ostatnich ~30 dni (lub ze wszystkich, jeśli mniej)
  const recent = intervals.filter(iv => iv.end > now - 30 * DAY);
  const pool = recent.length >= 2 ? recent : intervals;
  const pDays = pool.reduce((s, iv) => s + (iv.end - iv.start) / DAY, 0);
  const pKg = pool.reduce((s, iv) => s + iv.kg, 0);
  const avg = pDays >= 3 ? pKg / pDays : null;

  if (avg == null) {
    const manual = Number(data.settings.fallbackKgPerDay) || 0;
    if (manual > 0) return { type: 'manual', a: manual, b: 0, avg: manual, spread: 0.3, n: 0 };
    return { type: 'none', a: 0, b: 0, avg: null, spread: 0, n: 0 };
  }

  const pts = [];
  if (tempMap) {
    for (const iv of intervals) {
      const H = hddIntegral(iv.start, iv.end, tempMap, base);
      if (H == null) continue;
      pts.push({ D: (iv.end - iv.start) / DAY, H, y: iv.kg });
    }
  }
  const totalDays = pts.reduce((s, p) => s + p.D, 0);
  if (pts.length >= 4 && totalDays >= 10) {
    let Sdd = 0, Sdh = 0, Shh = 0, Sdy = 0, Shy = 0;
    for (const p of pts) {
      Sdd += p.D * p.D; Sdh += p.D * p.H; Shh += p.H * p.H; Sdy += p.D * p.y; Shy += p.H * p.y;
    }
    const det = Sdd * Shh - Sdh * Sdh;
    // wymagamy zróżnicowania temperatur, inaczej regresja jest niestabilna
    if (Shh > 0 && det > 0.02 * Sdd * Shh) {
      let a = (Sdy * Shh - Shy * Sdh) / det;
      let b = (Shy * Sdd - Sdy * Sdh) / det;
      if (b < 0) { b = 0; a = Sdy / Sdd; }
      if (a < 0) { a = 0; b = Shy / Shh; }
      // błąd względny dopasowania -> szerokość widełek
      let se = 0, sy = 0;
      for (const p of pts) { const e = p.y - (a * p.D + b * p.H); se += e * e; sy += p.y * p.y; }
      const spread = Math.min(0.35, Math.max(0.1, Math.sqrt(se / sy)));
      return { type: 'weather', a, b, avg, spread, n: pts.length };
    }
  }
  return { type: 'average', a: avg, b: 0, avg, spread: 0.25, n: pool.length };
}

/** Zużycie (kg/dzień) dla podanej temperatury. */
export function rateAt(model, temp, base) {
  if (model.type !== 'weather') return model.a;
  if (temp == null) return model.avg;
  return model.a + model.b * hdd(temp, base);
}

/**
 * Symulacja dzień po dniu, aż skończy się pellet.
 * tempFor(ymd) -> temperatura lub null. mult – mnożnik zużycia (widełki).
 */
export function simulate(stock, model, tempFor, base, now = Date.now(), mult = 1, maxDays = 730) {
  const series = [{ t: now, kg: Math.max(0, stock) }];
  if (stock <= 0) return { days: 0, runOut: now, series };
  if (model.type === 'none') return { days: null, runOut: null, series };
  let remain = stock;
  let elapsed = 0;
  const sod = startOfDay(now);
  for (let i = 0; i < maxDays; i++) {
    const dayStart = addDays(sod, i);
    const len = i === 0 ? (addDays(sod, 1) - now) / DAY : 1;
    const r = rateAt(model, tempFor(ymd(dayStart)), base) * mult * len;
    if (r >= remain && r > 0) {
      elapsed += len * remain / r;
      series.push({ t: now + elapsed * DAY, kg: 0 });
      return { days: elapsed, runOut: now + elapsed * DAY, series };
    }
    remain -= r;
    elapsed += len;
    series.push({ t: addDays(sod, i + 1), kg: remain });
  }
  return { days: null, runOut: null, series };
}

/** Klimatologia: średnia temperatura dla każdego dnia roku (MM-DD), wygładzona ±7 dni. */
export function buildClimatology(tempMap) {
  const sums = new Array(365).fill(0), cnt = new Array(365).fill(0);
  for (const [k, v] of Object.entries(tempMap)) {
    if (v == null) continue;
    const i = doyIndex(k.slice(5));
    sums[i] += v; cnt[i]++;
  }
  const out = {};
  for (let i = 0; i < 365; i++) {
    let s = 0, c = 0;
    for (let j = -7; j <= 7; j++) {
      const k = (i + j + 365) % 365;
      s += sums[k]; c += cnt[k];
    }
    if (c) out[mmddFromIndex(i)] = Math.round((s / c) * 10) / 10;
  }
  return out;
}
const MDAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function doyIndex(mmdd) {
  let [m, d] = mmdd.split('-').map(Number);
  if (m === 2 && d === 29) d = 28;
  let i = 0;
  for (let k = 0; k < m - 1; k++) i += MDAYS[k];
  return i + d - 1;
}
function mmddFromIndex(i) {
  let m = 0;
  while (i >= MDAYS[m]) { i -= MDAYS[m]; m++; }
  return `${String(m + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
}

/** Cena za kg (z transportem) dla zakupu. */
export const pricePerKg = p => (p.kg > 0 ? ((Number(p.goodsPrice) || 0) + (Number(p.transport) || 0)) / p.kg : 0);

/** Aktualna cena za kg – z ostatniego zakupu. */
export function currentPricePerKg(data) {
  const ps = data.purchases.filter(p => p.kg > 0 && p.goodsPrice > 0).sort((a, b) => b.date.localeCompare(a.date));
  return ps.length ? pricePerKg(ps[0]) : 0;
}
