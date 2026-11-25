import * as S from './store.js';
import * as F from './forecast.js';
import { getWeather, geocode, tempLookup } from './weather.js';

const DAY = F.DAY;
let data = S.load();
let weather = null;
let weatherLoading = false;

// ---------- pomocnicze ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (n, d = 0) => new Intl.NumberFormat('pl-PL', { maximumFractionDigits: d, minimumFractionDigits: 0 }).format(n);
const money = (n, d = 0) => new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN', maximumFractionDigits: d, minimumFractionDigits: d }).format(n);
const sameYear = t => new Date(t).getFullYear() === new Date().getFullYear();
const fmtDate = t => new Date(t).toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', ...(sameYear(t) ? {} : { year: 'numeric' }) });
const fmtShort = t => new Date(t).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
const fmtTime = t => new Date(t).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
const fmtDay = t => {
  const d = F.startOfDay(t), today = F.startOfDay(Date.now());
  if (d === today) return 'Dziś';
  if (d === F.addDays(today, -1)) return 'Wczoraj';
  const s = new Date(t).toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', ...(sameYear(t) ? {} : { year: 'numeric' }) });
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const toLocalInput = t => { const d = new Date(t); return `${F.ymd(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };

function wordBags(n) {
  if (!Number.isInteger(n)) return 'worka';
  if (n === 1) return 'worek';
  const d = n % 10, h = n % 100;
  return d >= 2 && d <= 4 && !(h >= 12 && h <= 14) ? 'worki' : 'worków';
}
const bags = kg => {
  const b = Math.round((kg / data.settings.bagKg) * 10) / 10;
  return `${nf(b, 1)} ${wordBags(b)}`;
};
const wordDays = n => (n === 1 ? 'dzień' : 'dni');

function persist() { S.save(data); render(); }

function toast(msg, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">Cofnij</button>' : ''}`;
  el.hidden = false;
  clearTimeout(toast.t);
  if (undo) el.querySelector('button').onclick = () => { undo(); el.hidden = true; };
  toast.t = setTimeout(() => (el.hidden = true), undo ? 6000 : 3000);
}

const ICON = {
  warn: '<svg viewBox="0 0 24 24" class="ic"><path d="M12 3 2 21h20L12 3zm0 6v5m0 3v.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ok: '<svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="m8 12 3 3 5-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  crit: '<svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v6m0 3.5v.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  phone: '<svg viewBox="0 0 24 24" class="ic"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
};

// ---------- obliczenia ----------
function compute() {
  const now = Date.now();
  const base = data.settings.baseTemp;
  const stock = F.computeStock(data);
  const tempMap = weather ? { ...weather.history, ...weather.forecast } : null;
  const model = F.fitModel(data, tempMap, now);
  const tf = tempLookup(weather);
  const mid = F.simulate(stock, model, tf, base, now);
  const pess = F.simulate(stock, model, tf, base, now, 1 + model.spread);
  const opt = F.simulate(stock, model, tf, base, now, Math.max(0.1, 1 - model.spread));
  const todayTemp = tf(F.ymd(now));
  const todayRate = model.type === 'none' ? null : F.rateAt(model, todayTemp, base);
  const price = F.currentPricePerKg(data);
  let orderBy = null;
  if (pess.runOut) orderBy = pess.runOut - (Number(data.settings.leadDays) + Number(data.settings.safetyDays)) * DAY;
  return { now, stock, model, mid, pess, opt, todayTemp, todayRate, price, orderBy };
}

function avgLastDays(n) {
  if (!data.fills.length) return null;
  const now = Date.now();
  const first = Math.min(...data.fills.map(f => f.ts));
  const span = Math.min(n, (now - first) / DAY);
  if (span < 1) return null;
  const kg = data.fills.filter(f => f.ts >= now - n * DAY).reduce((s, f) => s + f.kg, 0);
  return kg / span;
}

// ---------- formularze (okno dialogowe) ----------
function fieldHtml(f) {
  const id = `f_${f.name}`;
  const req = f.required ? 'required' : '';
  let input;
  if (f.type === 'select') {
    input = `<select id="${id}" name="${f.name}" ${req}>${f.options.map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  } else if (f.type === 'textarea') {
    input = `<textarea id="${id}" name="${f.name}" rows="2" placeholder="${esc(f.placeholder || '')}">${esc(f.value)}</textarea>`;
  } else {
    const isNum = f.type === 'number';
    input = `<input id="${id}" name="${f.name}" type="${isNum ? 'text' : f.type || 'text'}" ${isNum ? `inputmode="decimal"` : ''} value="${esc(f.value)}" placeholder="${esc(f.placeholder || '')}" ${req} ${f.autofocus ? 'autofocus' : ''}>`;
  }
  return `<label class="field ${f.half ? 'half' : ''}" for="${id}"><span>${esc(f.label)}</span>${input}${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</label>`;
}

function openForm({ title, fields, submitLabel = 'Zapisz', onSubmit, onDelete, intro = '' }) {
  const dlg = $('#dlg'), form = $('#dlgForm');
  form.innerHTML = `<h2>${esc(title)}</h2>${intro}<div class="fields">${fields.map(fieldHtml).join('')}</div>
    <p class="form-err" hidden></p>
    <div class="dlg-actions">
      ${onDelete ? '<button type="button" class="btn danger" data-act="del">Usuń</button>' : ''}
      <span class="sp"></span>
      <button type="button" class="btn ghost" data-act="cancel">Anuluj</button>
      <button type="submit" class="btn primary">${esc(submitLabel)}</button>
    </div>`;
  form.onsubmit = e => {
    e.preventDefault();
    const err = onSubmit(Object.fromEntries(new FormData(form)));
    if (err) { const p = form.querySelector('.form-err'); p.textContent = err; p.hidden = false; return; }
    dlg.close();
  };
  form.querySelector('[data-act=cancel]').onclick = () => dlg.close();
  if (onDelete) form.querySelector('[data-act=del]').onclick = () => {
    if (confirm('Na pewno usunąć ten wpis?')) { onDelete(); dlg.close(); }
  };
  dlg.showModal();
}

// --- zużycie ---
function addFill(bagCount, ts = Date.now(), note = '') {
  const f = { id: S.uid(), ts, bags: bagCount, kg: bagCount * data.settings.bagKg, note };
  data.fills.push(f);
  persist();
  toast(`Dodano ${nf(bagCount, 1)} ${wordBags(bagCount)} (${nf(f.kg, 1)} kg)`, () => {
    data.fills = data.fills.filter(x => x.id !== f.id);
    persist();
  });
}

function fillForm(existing) {
  openForm({
    title: existing ? 'Edytuj dosypanie' : 'Dosypanie do zasobnika',
    fields: [
      { name: 'bags', label: 'Liczba worków', type: 'number', value: existing ? existing.bags : 1, required: true, hint: `1 worek = ${nf(data.settings.bagKg, 1)} kg (zmienisz w Ustawieniach)`, autofocus: true },
      { name: 'ts', label: 'Kiedy', type: 'datetime-local', value: toLocalInput(existing ? existing.ts : Date.now()), required: true },
      { name: 'note', label: 'Notatka', type: 'textarea', value: existing?.note || '' },
    ],
    onSubmit: v => {
      const b = num(v.bags);
      if (!(b > 0)) return 'Podaj liczbę worków większą od zera.';
      const ts = new Date(v.ts).getTime();
      if (!ts) return 'Podaj datę.';
      if (existing) {
        Object.assign(existing, { bags: b, kg: b * data.settings.bagKg, ts, note: v.note.trim() });
        persist();
      } else addFill(b, ts, v.note.trim());
    },
    onDelete: existing ? () => { data.fills = data.fills.filter(x => x !== existing); persist(); } : null,
  });
}

function inventoryForm(existing) {
  const cur = F.computeStock(data);
  openForm({
    title: existing ? 'Edytuj spis z natury' : 'Spis z natury (korekta stanu)',
    intro: existing ? '' : `<p class="muted">Policz worki w magazynie. Aplikacja wyliczyła: <b>${bags(Math.max(0, cur))}</b>. Wpisany stan zastąpi wyliczenie od tej chwili.</p>`,
    fields: [
      { name: 'bags', label: 'Worków w magazynie', type: 'number', value: existing ? existing.kg / data.settings.bagKg : '', required: true, autofocus: true },
      { name: 'ts', label: 'Kiedy', type: 'datetime-local', value: toLocalInput(existing ? existing.ts : Date.now()), required: true },
      { name: 'note', label: 'Notatka', type: 'textarea', value: existing?.note || '' },
    ],
    onSubmit: v => {
      const b = num(v.bags);
      if (!(b >= 0)) return 'Podaj liczbę worków.';
      const rec = { kg: b * data.settings.bagKg, ts: new Date(v.ts).getTime(), note: v.note.trim() };
      if (existing) Object.assign(existing, rec); else data.inventories.push({ id: S.uid(), ...rec });
      persist();
    },
    onDelete: existing ? () => { data.inventories = data.inventories.filter(x => x !== existing); persist(); } : null,
  });
}

// --- zakupy ---
function purchaseForm(existing) {
  const sOpts = [{ value: '', label: '— wybierz —' }, ...data.suppliers.map(s => ({ value: s.id, label: s.name }))];
  const e = existing || {};
  openForm({
    title: existing ? 'Edytuj zakup' : 'Nowy zakup pelletu',
    intro: data.suppliers.length ? '' : '<p class="muted">Dostawców dodasz w zakładce „Dostawcy”.</p>',
    fields: [
      { name: 'date', label: 'Data dostawy', type: 'date', value: e.date || F.ymd(Date.now()), required: true },
      { name: 'qty', label: 'Ilość', type: 'number', value: e.qty ?? '', required: true, half: true, autofocus: !existing },
      { name: 'unit', label: 'Jednostka', type: 'select', value: e.unit || 't', half: true, options: [{ value: 't', label: 'tony' }, { value: 'bags', label: 'worki' }, { value: 'kg', label: 'kg' }] },
      { name: 'price', label: 'Cena', type: 'number', value: e.priceInput ?? '', half: true },
      { name: 'priceMode', label: 'Cena za', type: 'select', value: e.priceMode || 'perT', half: true, options: [{ value: 'perT', label: 'tonę' }, { value: 'total', label: 'całość' }, { value: 'perBag', label: 'worek' }] },
      { name: 'transport', label: 'Transport (zł)', type: 'number', value: e.transport ?? '', placeholder: '0' },
      { name: 'supplierId', label: 'Dostawca', type: 'select', value: e.supplierId || '', options: sOpts },
      { name: 'grade', label: 'Rodzaj / certyfikat', value: e.grade || '', placeholder: 'np. ENplus A1, 6 mm' },
      { name: 'note', label: 'Notatka', type: 'textarea', value: e.note || '' },
    ],
    onSubmit: v => {
      const qty = num(v.qty);
      if (!(qty > 0)) return 'Podaj ilość.';
      const bagKg = data.settings.bagKg;
      const kg = v.unit === 't' ? qty * 1000 : v.unit === 'bags' ? qty * bagKg : qty;
      const price = v.price === '' ? 0 : num(v.price);
      if (!(price >= 0)) return 'Cena ma zły format.';
      const goodsPrice = v.priceMode === 'perT' ? price * kg / 1000 : v.priceMode === 'perBag' ? price * kg / bagKg : price;
      const transport = v.transport === '' ? 0 : num(v.transport);
      if (!(transport >= 0)) return 'Koszt transportu ma zły format.';
      const rec = {
        date: v.date, qty, unit: v.unit, kg, priceInput: price, priceMode: v.priceMode,
        goodsPrice: Math.round(goodsPrice * 100) / 100, transport, supplierId: v.supplierId || null,
        grade: v.grade.trim(), note: v.note.trim(),
      };
      if (existing) Object.assign(existing, rec); else data.purchases.push({ id: S.uid(), ...rec });
      persist();
      if (!existing) toast(`Dodano zakup: ${nf(kg)} kg`);
    },
    onDelete: existing ? () => { data.purchases = data.purchases.filter(x => x !== existing); persist(); } : null,
  });
}

// --- dostawcy ---
function supplierForm(existing) {
  const e = existing || {};
  openForm({
    title: existing ? 'Edytuj dostawcę' : 'Nowy dostawca',
    fields: [
      { name: 'name', label: 'Nazwa', value: e.name || '', required: true, autofocus: !existing },
      { name: 'phone', label: 'Telefon', type: 'tel', value: e.phone || '' },
      { name: 'address', label: 'Adres', value: e.address || '' },
      { name: 'leadDays', label: 'Czas dostawy (dni)', type: 'number', value: e.leadDays ?? '', half: true },
      { name: 'rating', label: 'Ocena pelletu', type: 'select', value: e.rating || '', half: true, options: [{ value: '', label: '—' }, ...[5, 4, 3, 2, 1].map(n => ({ value: n, label: '★'.repeat(n) }))] },
      { name: 'note', label: 'Notatka', type: 'textarea', value: e.note || '', placeholder: 'np. dużo popiołu, dobra kaloryczność' },
    ],
    onSubmit: v => {
      if (!v.name.trim()) return 'Podaj nazwę.';
      const rec = { name: v.name.trim(), phone: v.phone.trim(), address: v.address.trim(), leadDays: v.leadDays === '' ? null : num(v.leadDays), rating: v.rating ? Number(v.rating) : null, note: v.note.trim() };
      if (existing) Object.assign(existing, rec); else data.suppliers.push({ id: S.uid(), ...rec });
      persist();
    },
    onDelete: existing ? () => {
      data.suppliers = data.suppliers.filter(x => x !== existing);
      for (const p of data.purchases) if (p.supplierId === existing.id) p.supplierId = null;
      persist();
    } : null,
  });
}

// ---------- wykresy (SVG) ----------
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function drawStockChart(el, series, orderBy) {
  const W = el.clientWidth || 320, H = 180, P = { l: 44, r: 12, t: 12, b: 26 };
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const ymax = niceMax(Math.max(...series.map(p => p.kg)));
  const x = t => P.l + (t - t0) / Math.max(1, t1 - t0) * (W - P.l - P.r);
  const y = v => P.t + (1 - v / ymax) * (H - P.t - P.b);
  const pts = series.map(p => `${x(p.t).toFixed(1)},${y(p.kg).toFixed(1)}`);
  const grid = [0, 0.5, 1].map(f => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(ymax * f)}" y2="${y(ymax * f)}" class="grid"/><text x="${P.l - 6}" y="${y(ymax * f) + 4}" class="axis" text-anchor="end">${nf(ymax * f)}</text>`).join('');
  const xt = [t0, t0 + (t1 - t0) / 2, t1].map((t, i) => `<text x="${x(t)}" y="${H - 6}" class="axis" text-anchor="${['start', 'middle', 'end'][i]}">${fmtShort(t)}</text>`).join('');
  let order = '';
  if (orderBy && orderBy > t0 && orderBy < t1) {
    order = `<line x1="${x(orderBy)}" x2="${x(orderBy)}" y1="${P.t}" y2="${H - P.b}" class="marker"/><text x="${x(orderBy) + 4}" y="${P.t + 10}" class="axis">zamów</text>`;
  }
  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Prognoza stanu magazynu">
    ${grid}${xt}
    <path d="M${pts[0]} L${pts.join(' L')} L${x(t1)},${y(0)} L${x(t0)},${y(0)} Z" class="area"/>
    <polyline points="${pts.join(' ')}" class="line"/>
    ${order}
    <g class="hover" visibility="hidden"><line class="cross" y1="${P.t}" y2="${H - P.b}"/><circle r="5" class="dot"/></g>
    <rect x="${P.l}" y="0" width="${W - P.l - P.r}" height="${H}" fill="transparent" class="hit"/>
  </svg><div class="tip" hidden></div>`;
  const svg = el.querySelector('svg'), g = el.querySelector('.hover'), tip = el.querySelector('.tip');
  const move = ev => {
    const r = svg.getBoundingClientRect();
    const t = t0 + (ev.clientX - r.left - P.l) / (W - P.l - P.r) * (t1 - t0);
    let best = series[0];
    for (const p of series) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    const cx = x(best.t), cy = y(best.kg);
    g.setAttribute('visibility', 'visible');
    g.querySelector('line').setAttribute('x1', cx); g.querySelector('line').setAttribute('x2', cx);
    g.querySelector('circle').setAttribute('cx', cx); g.querySelector('circle').setAttribute('cy', cy);
    tip.hidden = false;
    tip.innerHTML = `<b>${fmtDate(best.t)}</b><br>${nf(best.kg)} kg · ${bags(best.kg)}`;
    tip.style.left = `${Math.min(W - tip.offsetWidth - 4, Math.max(4, cx - tip.offsetWidth / 2))}px`;
    tip.style.top = `${Math.max(0, cy - tip.offsetHeight - 12)}px`;
  };
  const hide = () => { g.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', hide);
}

function drawBarChart(el, items, fmtVal) {
  const W = el.clientWidth || 320, H = 190, P = { l: 44, r: 8, t: 12, b: 26 };
  const ymax = niceMax(Math.max(1, ...items.map(i => i.v)));
  const n = items.length, slot = (W - P.l - P.r) / n, bw = Math.max(4, slot - 4);
  const y = v => P.t + (1 - v / ymax) * (H - P.t - P.b);
  const grid = [0, 0.5, 1].map(f => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(ymax * f)}" y2="${y(ymax * f)}" class="grid"/><text x="${P.l - 6}" y="${y(ymax * f) + 4}" class="axis" text-anchor="end">${nf(ymax * f)}</text>`).join('');
  const bars = items.map((it, i) => {
    const x0 = P.l + i * slot + (slot - bw) / 2, top = y(it.v), bot = y(0), h = bot - top;
    const r = Math.min(4, bw / 2, h);
    const path = h <= 0 ? '' : `M${x0},${bot} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${bot} Z`;
    return `<path d="${path}" class="bar"/><rect x="${P.l + i * slot}" y="${P.t}" width="${slot}" height="${H - P.t}" fill="transparent" data-i="${i}"/>
      ${i % Math.ceil(n / 6) === 0 || i === n - 1 ? `<text x="${x0 + bw / 2}" y="${H - 6}" class="axis" text-anchor="middle">${esc(it.label)}</text>` : ''}`;
  }).join('');
  el.innerHTML = `<svg width="${W}" height="${H}" role="img">${grid}${bars}</svg><div class="tip" hidden></div>`;
  const tip = el.querySelector('.tip');
  el.querySelectorAll('rect[data-i]').forEach(r => {
    const show = () => {
      const i = +r.dataset.i, it = items[i];
      tip.hidden = false;
      tip.innerHTML = `<b>${esc(it.full)}</b><br>${fmtVal(it.v)}`;
      const cx = P.l + i * slot + slot / 2;
      tip.style.left = `${Math.min(W - tip.offsetWidth - 4, Math.max(4, cx - tip.offsetWidth / 2))}px`;
      tip.style.top = `${Math.max(0, y(it.v) - tip.offsetHeight - 8)}px`;
    };
    r.addEventListener('pointerenter', show);
    r.addEventListener('pointerdown', show);
    r.addEventListener('pointerleave', () => (tip.hidden = true));
  });
}

// ---------- widoki ----------
function viewDashboard() {
  const empty = !data.fills.length && !data.purchases.length && !data.inventories.length;
  if (empty) return viewOnboarding();
  const c = compute();
  const s = data.settings;
  const todayBags = data.fills.filter(f => F.startOfDay(f.ts) === F.startOfDay(c.now)).reduce((a, f) => a + f.bags, 0);

  // główna karta
  let hero;
  if (c.stock <= 0) {
    hero = `<div class="status crit">${ICON.crit}<span>Magazyn pusty – dodaj zakup albo zrób spis z natury.</span></div>`;
  } else if (c.model.type === 'none') {
    hero = `<p class="muted">Wpisuj dosypane worki przez kilka dni, żeby zobaczyć prognozę. Możesz też podać szacowane zużycie w Ustawieniach.</p>`;
  } else if (c.mid.days == null) {
    hero = `<div class="big">ponad 2 lata</div>`;
  } else {
    const d = Math.floor(c.mid.days);
    const range = c.pess.days != null
      ? `${fmtShort(c.pess.runOut)} – ${c.opt.days != null ? fmtShort(c.opt.runOut) : 'później'}`
      : '';
    hero = `<div class="label">Wystarczy na</div>
      <div class="big">${nf(d)} <small>${wordDays(d)}</small></div>
      <div class="sub">do <b>${fmtDate(c.mid.runOut)}</b>${range ? ` <span class="muted">(${range})</span>` : ''}</div>`;
  }

  // kiedy zamówić
  let order = '';
  if (c.orderBy && c.stock > 0) {
    const left = (c.orderBy - c.now) / DAY;
    const cls = left <= 0 ? 'crit' : left <= 14 ? 'warn' : 'ok';
    const txt = left <= 0 ? '<b>Zamów pellet teraz.</b>' : `Zamów najpóźniej <b>${fmtDate(c.orderBy)}</b> (za ${nf(Math.floor(left))} ${wordDays(Math.floor(left))})`;
    order = `<div class="status ${cls}">${ICON[cls === 'ok' ? 'ok' : cls === 'warn' ? 'warn' : 'crit']}<span>${txt}<br><small>dostawa ${s.leadDays} dni + zapas ${s.safetyDays} dni, wersja ostrożna</small></span></div>`;
  }

  const a7 = avgLastDays(7), a30 = avgLastDays(30);
  const ss = F.seasonStart(c.now);
  const seasonKg = data.fills.filter(f => f.ts >= ss).reduce((a, f) => a + f.kg, 0);
  const tiles = [
    ['Teraz (prognoza)', c.todayRate != null ? `${nf(c.todayRate, 1)} kg/dobę` : '—', c.todayTemp != null ? `śr. temp. dziś ${nf(c.todayTemp, 1)} °C` : ''],
    ['Średnio 7 dni', a7 != null ? `${nf(a7, 1)} kg/dobę` : '—', a7 != null ? bags(a7) + ' dziennie' : ''],
    ['Średnio 30 dni', a30 != null ? `${nf(a30, 1)} kg/dobę` : '—', ''],
    ['Koszt dobowy', c.price && c.todayRate != null ? money(c.todayRate * c.price, 2) : '—', c.price ? `${money(c.price * 1000)}/t` : 'dodaj zakup z ceną'],
    ['Koszt / 30 dni', c.price && c.todayRate != null ? money(c.todayRate * c.price * 30) : '—', 'przy obecnej pogodzie'],
    [`Sezon ${F.seasonLabel(c.now)}`, `${nf(seasonKg)} kg`, c.price ? `ok. ${money(seasonKg * c.price)}` : ''],
  ];

  const modelTxt = {
    weather: `Prognoza uwzględnia pogodę (${esc(s.placeName || 'lokalizacja')}).`,
    average: s.lat == null ? 'Prognoza ze średniego zużycia. Ustaw lokalizację, żeby uwzględniała pogodę.' : 'Prognoza ze średniego zużycia; model pogodowy włączy się po ok. 2 tygodniach wpisów.',
    manual: 'Prognoza z zużycia wpisanego w Ustawieniach.',
    none: '',
  }[c.model.type];

  const backupDue = !s.lastBackup || c.now - s.lastBackup > 30 * DAY;

  return `
    <section class="card hero">
      <div class="stock"><span class="label">W magazynie</span><span class="val">${bags(Math.max(0, c.stock))}</span><span class="muted">${nf(Math.max(0, c.stock))} kg</span></div>
      ${hero}
    </section>
    <section class="quick">
      <button class="btn add1" data-act="fill1"><span class="plus">+1</span> worek<small>${todayBags ? `dziś: ${nf(todayBags, 1)} ${wordBags(todayBags)}` : 'dosypany do zasobnika'}</small></button>
      <button class="btn secondary" data-act="fillN">Inna ilość</button>
    </section>
    ${order}
    ${c.mid.series.length > 2 ? `<section class="card"><h3>Prognoza stanu magazynu</h3><div class="chart" id="stockChart"></div><p class="muted small">${modelTxt}${weatherLoading ? ' Pobieram pogodę…' : ''}</p></section>` : modelTxt ? `<p class="muted small pad">${modelTxt}</p>` : ''}
    <section class="tiles">${tiles.map(([l, v, sub]) => `<div class="tile"><span class="label">${l}</span><span class="v">${v}</span>${sub ? `<span class="muted small">${sub}</span>` : ''}</div>`).join('')}</section>
    ${backupDue ? `<a class="status info" href="#wiecej">${ICON.warn}<span>Dane są tylko na tym telefonie. <b>Zrób kopię zapasową</b> w zakładce Więcej.</span></a>` : ''}
  `;
}

function viewOnboarding() {
  return `<section class="card">
    <h2>Witaj! 👋</h2>
    <p>Na start podaj, ile pelletu masz teraz w magazynie. Potem dopisuj każdy worek wsypany do zasobnika, a aplikacja policzy, na ile wystarczy.</p>
    <form id="onb" class="fields">
      ${fieldHtml({ name: 'bags', label: 'Ile worków masz w magazynie?', type: 'number', required: true, placeholder: 'np. 65' })}
      ${fieldHtml({ name: 'bagKg', label: 'Waga worka (kg)', type: 'number', value: data.settings.bagKg })}
      <button class="btn primary" type="submit">Zaczynamy</button>
    </form>
    <p class="muted small">Zamiast tego możesz od razu <a href="#zakupy">dodać zakup</a> albo <a href="#wiecej">wczytać kopię zapasową</a>.</p>
  </section>`;
}

function viewFills() {
  const items = [
    ...data.fills.map(f => ({ ...f, kind: 'fill', ref: f })),
    ...data.inventories.map(i => ({ ...i, kind: 'inv', ref: i })),
  ].sort((a, b) => b.ts - a.ts);
  const groups = new Map();
  for (const it of items.slice(0, 300)) {
    const k = F.startOfDay(it.ts);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const list = [...groups.entries()].map(([day, arr]) => {
    const tot = arr.filter(x => x.kind === 'fill').reduce((s, x) => s + x.bags, 0);
    return `<div class="group"><div class="ghead"><span>${fmtDay(day)}</span><span class="muted">${tot ? `${nf(tot, 1)} ${wordBags(tot)}` : ''}</span></div>
      ${arr.map(x => x.kind === 'fill'
        ? `<button class="row" data-edit-fill="${x.id}"><span class="time">${fmtTime(x.ts)}</span><span class="main">+${nf(x.bags, 1)} ${wordBags(x.bags)} <span class="muted">(${nf(x.kg, 1)} kg)</span>${x.note ? `<small>${esc(x.note)}</small>` : ''}</span></button>`
        : `<button class="row inv" data-edit-inv="${x.id}"><span class="time">${fmtTime(x.ts)}</span><span class="main">Spis z natury: ${bags(x.kg)} <span class="muted">(${nf(x.kg)} kg)</span>${x.note ? `<small>${esc(x.note)}</small>` : ''}</span></button>`).join('')}
    </div>`;
  }).join('');
  return `
    <section class="quick">
      <button class="btn add1" data-act="fill1"><span class="plus">+1</span> worek</button>
      <button class="btn secondary" data-act="fillN">Inna ilość</button>
    </section>
    <button class="btn ghost wide" data-act="inventory">Spis z natury (korekta stanu)</button>
    ${list || '<p class="muted pad">Brak wpisów. Dodaj pierwszy dosypany worek.</p>'}`;
}

function supplierName(id) { return data.suppliers.find(s => s.id === id)?.name || ''; }

function viewPurchases() {
  const ps = data.purchases.slice().sort((a, b) => b.date.localeCompare(a.date));
  const ss = F.ymd(F.seasonStart(Date.now()));
  const season = ps.filter(p => p.date >= ss);
  const sKg = season.reduce((a, p) => a + p.kg, 0);
  const sCost = season.reduce((a, p) => a + (p.goodsPrice || 0) + (p.transport || 0), 0);
  return `
    <button class="btn primary wide" data-act="purchase">+ Dodaj zakup</button>
    ${season.length ? `<section class="tiles two">
      <div class="tile"><span class="label">Kupiono w sezonie ${F.seasonLabel(Date.now())}</span><span class="v">${nf(sKg / 1000, 2)} t</span><span class="muted small">${bags(sKg)}</span></div>
      <div class="tile"><span class="label">Wydano</span><span class="v">${money(sCost)}</span><span class="muted small">${sKg ? `śr. ${money(sCost / sKg * 1000)}/t` : ''}</span></div>
    </section>` : ''}
    ${ps.map(p => {
      const ppk = F.pricePerKg(p);
      const total = (p.goodsPrice || 0) + (p.transport || 0);
      return `<button class="card item" data-edit-purchase="${p.id}">
        <div class="irow"><b>${fmtDate(F.parseYmd(p.date))}</b><b>${total ? money(total) : ''}</b></div>
        <div class="irow"><span>${nf(p.kg / 1000, 2)} t · ${bags(p.kg)}</span><span class="muted">${ppk ? `${money(ppk * 1000)}/t` : 'bez ceny'}</span></div>
        <div class="irow muted small"><span>${esc(supplierName(p.supplierId) || 'dostawca nieznany')}${p.grade ? ` · ${esc(p.grade)}` : ''}</span><span>${p.transport ? `w tym transport ${money(p.transport)}` : ''}</span></div>
        ${p.note ? `<div class="muted small">${esc(p.note)}</div>` : ''}
      </button>`;
    }).join('') || '<p class="muted pad">Brak zakupów.</p>'}`;
}

function viewSuppliers() {
  return `
    <button class="btn primary wide" data-act="supplier">+ Dodaj dostawcę</button>
    ${data.suppliers.map(s => {
      const ps = data.purchases.filter(p => p.supplierId === s.id).sort((a, b) => b.date.localeCompare(a.date));
      const last = ps[0];
      const kg = ps.reduce((a, p) => a + p.kg, 0);
      return `<div class="card item">
        <button class="item-main" data-edit-supplier="${s.id}">
          <div class="irow"><b>${esc(s.name)}</b><span class="stars">${s.rating ? '★'.repeat(s.rating) + '☆'.repeat(5 - s.rating) : ''}</span></div>
          ${s.address ? `<div class="muted small">${esc(s.address)}</div>` : ''}
          <div class="irow small"><span>${ps.length ? `${ps.length} zakup(y), ${nf(kg / 1000, 2)} t` : 'brak zakupów'}</span><span>${last && F.pricePerKg(last) ? `ostatnio ${money(F.pricePerKg(last) * 1000)}/t` : ''}</span></div>
          ${s.leadDays != null ? `<div class="muted small">dostawa ok. ${nf(s.leadDays)} ${wordDays(s.leadDays)}</div>` : ''}
          ${s.note ? `<div class="muted small">${esc(s.note)}</div>` : ''}
        </button>
        ${s.phone ? `<a class="btn secondary call" href="tel:${esc(s.phone.replace(/\s/g, ''))}">${ICON.phone} ${esc(s.phone)}</a>` : ''}
      </div>`;
    }).join('') || '<p class="muted pad">Brak dostawców.</p>'}`;
}

function monthlyConsumption() {
  const now = new Date();
  const items = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const e = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const v = data.fills.filter(f => f.ts >= d.getTime() && f.ts < e.getTime()).reduce((a, f) => a + f.kg, 0);
    items.push({ v, label: d.toLocaleDateString('pl-PL', { month: 'short' }), full: d.toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' }) });
  }
  return items;
}

function seasonsTable() {
  const map = new Map();
  const get = t => { const k = F.seasonLabel(t); if (!map.has(k)) map.set(k, { burned: 0, bought: 0, cost: 0 }); return map.get(k); };
  for (const f of data.fills) get(f.ts).burned += f.kg;
  for (const p of data.purchases) { const r = get(F.parseYmd(p.date).getTime()); r.bought += p.kg; r.cost += (p.goodsPrice || 0) + (p.transport || 0); }
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function viewMore() {
  const s = data.settings;
  const c = compute();
  let modelInfo = '';
  if (c.model.type === 'weather') {
    const rows = [10, 5, 0, -5, -10, -15].map(t => `<tr><td>${t} °C</td><td>${nf(F.rateAt(c.model, t, s.baseTemp), 1)} kg</td><td>${bags(F.rateAt(c.model, t, s.baseTemp))}</td></tr>`).join('');
    modelInfo = `<p class="small">Dobowe zużycie przy średniej temperaturze dnia (wyliczone z ${c.model.n} okresów między dosypaniami):</p>
      <table class="tbl"><thead><tr><th>Temp.</th><th>kg/dobę</th><th>worki</th></tr></thead><tbody>${rows}</tbody></table>`;
  } else if (c.model.type === 'average') {
    modelInfo = `<p class="small">Średnie zużycie: <b>${nf(c.model.avg, 1)} kg/dobę</b>. ${s.lat == null ? 'Ustaw lokalizację poniżej, żeby prognoza uwzględniała pogodę.' : 'Model pogodowy potrzebuje min. ~2 tygodni wpisów przy różnej pogodzie.'}</p>`;
  } else {
    modelInfo = '<p class="small muted">Za mało danych.</p>';
  }
  const seasons = seasonsTable();
  return `
    <section class="card">
      <h3>Zużycie miesięczne (kg)</h3>
      ${data.fills.length ? '<div class="chart" id="monthChart"></div>' : '<p class="muted small">Brak danych.</p>'}
    </section>
    <section class="card">
      <h3>Jak zużycie zależy od pogody</h3>
      ${modelInfo}
    </section>
    ${seasons.length ? `<section class="card"><h3>Sezony grzewcze</h3>
      <table class="tbl"><thead><tr><th>Sezon</th><th>Spalono</th><th>Kupiono</th><th>Wydano</th></tr></thead><tbody>
      ${seasons.map(([k, r]) => `<tr><td>${k}</td><td>${nf(r.burned / 1000, 2)} t</td><td>${nf(r.bought / 1000, 2)} t</td><td>${money(r.cost)}</td></tr>`).join('')}
      </tbody></table></section>` : ''}

    <section class="card">
      <h3>Ustawienia</h3>
      <form id="settings" class="fields">
        ${fieldHtml({ name: 'bagKg', label: 'Waga worka (kg)', type: 'number', value: s.bagKg, half: true })}
        ${fieldHtml({ name: 'leadDays', label: 'Czas dostawy (dni)', type: 'number', value: s.leadDays, half: true })}
        ${fieldHtml({ name: 'safetyDays', label: 'Zapas bezpieczeństwa (dni)', type: 'number', value: s.safetyDays, half: true })}
        ${fieldHtml({ name: 'baseTemp', label: 'Temp. bazowa (°C)', type: 'number', value: s.baseTemp, half: true, hint: 'powyżej niej dom nie potrzebuje grzania' })}
        ${fieldHtml({ name: 'fallbackKgPerDay', label: 'Szacowane zużycie na start (kg/dobę)', type: 'number', value: s.fallbackKgPerDay || '', hint: 'używane, dopóki nie ma własnych danych' })}
        <button class="btn primary" type="submit">Zapisz ustawienia</button>
      </form>
      <div class="loc">
        <span class="label">Lokalizacja (do prognozy pogody)</span>
        <p>${s.lat != null ? `<b>${esc(s.placeName || `${s.lat}, ${s.lon}`)}</b>` : '<span class="muted">nie ustawiono</span>'}</p>
        <form id="locSearch" class="inline"><input name="q" placeholder="Wpisz miejscowość" aria-label="Miejscowość"><button class="btn secondary" type="submit">Szukaj</button></form>
        <div id="locResults"></div>
        <button class="btn ghost" data-act="gps">Użyj GPS telefonu</button>
        ${s.lat != null ? '<button class="btn ghost" data-act="locClear">Usuń lokalizację</button>' : ''}
      </div>
    </section>

    <section class="card">
      <h3>Kopia zapasowa</h3>
      <p class="small">Dane są zapisane tylko na tym telefonie. Kopię możesz wysłać sobie mailem albo zapisać na Dysku Google. Ostatnia kopia: <b>${s.lastBackup ? fmtDate(s.lastBackup) : 'nigdy'}</b>.</p>
      <div class="btns">
        <button class="btn primary" data-act="backup">Zapisz / wyślij kopię</button>
        <label class="btn secondary">Wczytaj kopię<input type="file" accept=".json,application/json" id="importFile" hidden></label>
        <button class="btn ghost" data-act="csv">Eksport do Excela (CSV)</button>
      </div>
    </section>
    <p class="muted small pad">Pellet · dane pogodowe: Open-Meteo.com</p>`;
}

// ---------- routing i obsługa zdarzeń ----------
const VIEWS = {
  pulpit: ['Pellet', viewDashboard],
  zuzycie: ['Zużycie', viewFills],
  zakupy: ['Zakupy', viewPurchases],
  dostawcy: ['Dostawcy', viewSuppliers],
  wiecej: ['Statystyki i ustawienia', viewMore],
};

function current() { const h = location.hash.slice(1); return VIEWS[h] ? h : 'pulpit'; }

function render() {
  const tab = current();
  const [title, fn] = VIEWS[tab];
  $('#title').textContent = title;
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#${tab}`));
  $('#view').innerHTML = fn();
  drawCharts();
}

function drawCharts() {
  const sc = $('#stockChart');
  if (sc) {
    const c = compute();
    let ser = c.mid.series;
    const limit = c.now + 120 * DAY;
    ser = ser.filter(p => p.t <= limit);
    if (ser.length > 2) drawStockChart(sc, ser, c.orderBy);
  }
  const mc = $('#monthChart');
  if (mc) drawBarChart(mc, monthlyConsumption(), v => `${nf(v)} kg · ${bags(v)}`);
}

async function refreshWeather(force = false) {
  const s = data.settings;
  if (s.lat == null) { weather = null; return; }
  weatherLoading = true;
  try { weather = await getWeather(s.lat, s.lon, { force }); }
  finally { weatherLoading = false; }
  render();
}

function toCsv() {
  const sep = ';';
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const dec = n => String(Math.round(n * 100) / 100).replace('.', ',');
  const lines = [['typ', 'data', 'kg', 'worki', 'cena towaru zł', 'transport zł', 'zł/t', 'dostawca', 'rodzaj', 'notatka'].join(sep)];
  for (const f of data.fills) lines.push(['dosypanie', toLocalInput(f.ts).replace('T', ' '), dec(f.kg), dec(f.bags), '', '', '', '', '', q(f.note)].join(sep));
  for (const i of data.inventories) lines.push(['spis z natury', toLocalInput(i.ts).replace('T', ' '), dec(i.kg), dec(i.kg / data.settings.bagKg), '', '', '', '', '', q(i.note)].join(sep));
  for (const p of data.purchases) lines.push(['zakup', p.date, dec(p.kg), dec(p.kg / data.settings.bagKg), dec(p.goodsPrice || 0), dec(p.transport || 0), dec(F.pricePerKg(p) * 1000), q(supplierName(p.supplierId)), q(p.grade), q(p.note)].join(sep));
  return '﻿' + lines.join('\r\n');
}

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act],[data-edit-fill],[data-edit-inv],[data-edit-purchase],[data-edit-supplier],[data-loc]');
  if (!t) return;
  const d = t.dataset;
  if (d.editFill) return fillForm(data.fills.find(x => x.id === d.editFill));
  if (d.editInv) return inventoryForm(data.inventories.find(x => x.id === d.editInv));
  if (d.editPurchase) return purchaseForm(data.purchases.find(x => x.id === d.editPurchase));
  if (d.editSupplier) return supplierForm(data.suppliers.find(x => x.id === d.editSupplier));
  if (d.loc) {
    const r = JSON.parse(d.loc);
    Object.assign(data.settings, { lat: r.lat, lon: r.lon, placeName: r.name });
    persist();
    toast(`Lokalizacja: ${r.name}`);
    return refreshWeather(true);
  }
  switch (d.act) {
    case 'fill1': return addFill(1);
    case 'fillN': return fillForm();
    case 'inventory': return inventoryForm();
    case 'purchase': return purchaseForm();
    case 'supplier': return supplierForm();
    case 'gps':
      if (!navigator.geolocation) return toast('GPS niedostępny');
      navigator.geolocation.getCurrentPosition(pos => {
        Object.assign(data.settings, { lat: Math.round(pos.coords.latitude * 1000) / 1000, lon: Math.round(pos.coords.longitude * 1000) / 1000, placeName: 'moja lokalizacja (GPS)' });
        persist();
        refreshWeather(true);
      }, () => toast('Nie udało się pobrać lokalizacji'), { timeout: 15000 });
      return;
    case 'locClear':
      Object.assign(data.settings, { lat: null, lon: null, placeName: '' });
      weather = null;
      return persist();
    case 'backup': {
      const name = `pellet-kopia-${F.ymd(Date.now())}.json`;
      const res = await S.shareOrDownload(JSON.stringify({ ...data, settings: { ...data.settings, lastBackup: Date.now() } }, null, 1), name, 'application/json');
      if (res !== 'aborted') { data.settings.lastBackup = Date.now(); persist(); toast('Kopia zapisana'); }
      return;
    }
    case 'csv':
      return S.shareOrDownload(toCsv(), `pellet-${F.ymd(Date.now())}.csv`, 'text/csv');
  }
});

document.addEventListener('submit', async e => {
  const f = e.target;
  if (f.id === 'onb') {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    const b = num(v.bags), kgb = num(v.bagKg);
    if (!(b >= 0)) return toast('Podaj liczbę worków');
    if (kgb > 0) data.settings.bagKg = kgb;
    data.inventories.push({ id: S.uid(), ts: Date.now(), kg: b * data.settings.bagKg, note: 'stan początkowy' });
    persist();
  } else if (f.id === 'settings') {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    const s = data.settings;
    const pos = (x, def) => (num(x) > 0 ? num(x) : def);
    const nn = (x, def) => (num(x) >= 0 ? num(x) : def);
    s.bagKg = pos(v.bagKg, s.bagKg);
    s.leadDays = nn(v.leadDays, s.leadDays);
    s.safetyDays = nn(v.safetyDays, s.safetyDays);
    s.baseTemp = Number.isFinite(num(v.baseTemp)) ? num(v.baseTemp) : s.baseTemp;
    s.fallbackKgPerDay = nn(v.fallbackKgPerDay, 0);
    persist();
    toast('Zapisano ustawienia');
  } else if (f.id === 'locSearch') {
    e.preventDefault();
    const q = new FormData(f).get('q').trim();
    if (!q) return;
    const box = $('#locResults');
    box.innerHTML = '<p class="muted small">Szukam…</p>';
    try {
      const res = await geocode(q);
      box.innerHTML = res.length
        ? res.map(r => `<button class="row" data-loc='${esc(JSON.stringify(r))}'>${esc(r.name)}</button>`).join('')
        : '<p class="muted small">Nie znaleziono.</p>';
    } catch {
      box.innerHTML = '<p class="muted small">Brak połączenia z internetem.</p>';
    }
  }
});

document.addEventListener('change', async e => {
  if (e.target.id !== 'importFile') return;
  const file = e.target.files[0];
  if (!file) return;
  try {
    const imported = S.normalize(JSON.parse(await file.text()));
    const n = imported.fills.length + imported.purchases.length;
    if (!confirm(`Wczytać kopię (${n} wpisów)? Obecne dane na tym telefonie zostaną zastąpione.`)) return;
    data = imported;
    persist();
    toast('Wczytano kopię');
    refreshWeather();
  } catch (err) {
    alert(`Nie udało się wczytać pliku: ${err.message}`);
  } finally {
    e.target.value = '';
  }
});

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
let rt;
window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawCharts, 150); });
// po powrocie do aplikacji (np. następnego dnia) odśwież widok i pogodę
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); refreshWeather(); } });
window.addEventListener('storage', e => { if (e.key === 'pellet-data-v1') { data = S.load(); render(); } });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW', err));
}
S.requestPersistence();
render();
refreshWeather();
