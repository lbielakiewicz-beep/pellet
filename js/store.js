// Przechowywanie danych lokalnie na telefonie (localStorage) + kopia zapasowa.

const KEY = 'pellet-data-v1';

export const DEFAULT_SETTINGS = {
  bagKg: 15,
  palletBags: 65,
  baseTemp: 18,
  leadDays: 3,
  safetyDays: 7,
  fallbackKgPerDay: 0,
  lat: null,
  lon: null,
  placeName: '',
  lastBackup: null,
};

export function emptyData() {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, purchases: [], fills: [], inventories: [], suppliers: [] };
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyData();
    return normalize(JSON.parse(raw));
  } catch (e) {
    console.error('Nie udało się wczytać danych', e);
    return emptyData();
  }
}

export function save(data) {
  localStorage.setItem(KEY, JSON.stringify(data));
}

export function normalize(d) {
  if (!d || typeof d !== 'object') throw new Error('Nieprawidłowy plik');
  for (const k of ['purchases', 'fills', 'inventories', 'suppliers']) {
    if (d[k] != null && !Array.isArray(d[k])) throw new Error(`Pole „${k}” ma zły format`);
  }
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) },
    purchases: d.purchases || [],
    fills: d.fills || [],
    inventories: d.inventories || [],
    suppliers: d.suppliers || [],
  };
}

/** Prośba do przeglądarki, by nie czyściła danych przy braku miejsca. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* brak wsparcia – trudno */ }
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** Udostępnij (e-mail, Dysk, komunikator) lub pobierz plik. */
export async function shareOrDownload(content, name, type) {
  const blob = new Blob([content], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'aborted';
    }
  }
  downloadBlob(blob, name);
  return 'downloaded';
}
