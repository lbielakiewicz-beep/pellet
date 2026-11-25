// Synchronizacja z chmurą: Firebase (logowanie kontem Google + baza Firestore).
// Dane zostają też w telefonie (localStorage i bufor Firestore), więc aplikacja
// działa bez internetu, a zmiany wysyłają się po odzyskaniu połączenia.
//
// Układ w Firestore:
//   households/{hid}                 { owner, members: [e-maile], settings }
//   households/{hid}/{kolekcja}/{id} jeden dokument na wpis
// hid = uid właściciela. Domownik dopisany do members widzi te same dane.
import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
export const COLS = ['fills', 'purchases', 'inventories', 'suppliers'];
const HID_KEY = 'pellet-cloud-hid';
const BACKUP_KEY = 'pellet-data-before-cloud';

let fb = null, auth = null, db = null;
let hid = null, uid = null;
let unsubs = [];
let remote = {};          // kolekcja -> Map(id -> json) – ostatni znany stan w chmurze
let remoteSettings = null;
let pending = {};
let dirty = false;        // zmiany lokalne zanim chmura była gotowa
let hooks = { getData: () => null, onRemote: () => {}, onState: () => {} };

const state = { configured: !!firebaseConfig, ready: false, user: null, needsVerify: false, owner: null, members: [], pending: false, error: '' };
export const cloudState = () => state;
export const signedIn = () => !!(state.user && hid);

function set(patch) { Object.assign(state, patch); hooks.onState(state); }

/** JSON z posortowanymi kluczami – do porównywania rekordów. */
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

export async function initCloud(h) {
  hooks = { ...hooks, ...h };
  if (!firebaseConfig) return;
  try {
    const [appM, authM, fsM] = await Promise.all([
      import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`),
    ]);
    fb = { ...authM, ...fsM };
    const app = appM.initializeApp(firebaseConfig);
    auth = authM.getAuth(app);
    db = fsM.initializeFirestore(app, {
      localCache: fsM.persistentLocalCache({ tabManager: fsM.persistentMultipleTabManager() }),
      ignoreUndefinedProperties: true,
    });
    auth.languageCode = 'pl';
    set({ ready: true });
    authM.onAuthStateChanged(auth, u => onUser(u).catch(fail));
  } catch (e) {
    // np. pierwsze uruchomienie bez internetu – działamy lokalnie
    fail(e);
  }
}

function fail(e) {
  console.warn('Chmura:', e);
  set({ error: e?.code === 'permission-denied' ? 'Brak dostępu do danych w chmurze.' : (e?.message || String(e)) });
}

function needAuth() { if (!auth) throw new Error('Chmura niedostępna – sprawdź internet i otwórz aplikację ponownie.'); }

// konto e-mail musi być potwierdzone (link w mailu), zanim dostanie dostęp do danych
async function onUser(u) {
  if (u && !u.emailVerified) {
    disconnect();
    set({ user: { email: (u.email || '').toLowerCase(), name: u.email }, needsVerify: true, owner: null, members: [] });
    return;
  }
  set({ needsVerify: false });
  return connect(u);
}

/** Logowanie przez okno Google (nie działa pewnie w aplikacji z ekranu głównego na iPhonie). */
export async function signIn() {
  needAuth();
  await fb.signInWithPopup(auth, new fb.GoogleAuthProvider());
}

export async function signInEmail(email, pass) {
  needAuth();
  await fb.signInWithEmailAndPassword(auth, email.trim(), pass);
}

export async function signUpEmail(email, pass) {
  needAuth();
  const cred = await fb.createUserWithEmailAndPassword(auth, email.trim(), pass);
  await fb.sendEmailVerification(cred.user);
}

export async function resendVerification() {
  needAuth();
  if (auth.currentUser) await fb.sendEmailVerification(auth.currentUser);
}

/** Po kliknięciu linku w mailu: odśwież stan konta. Zwraca true, gdy potwierdzone. */
export async function checkVerified() {
  const u = auth?.currentUser;
  if (!u) return false;
  await u.reload();
  if (!u.emailVerified) return false;
  await u.getIdToken(true); // nowy token z email_verified = true (wymagane przez reguły)
  await onUser(u);
  return true;
}

export async function resetPassword(email) {
  needAuth();
  await fb.sendPasswordResetEmail(auth, email.trim());
}

/** Komunikat błędu logowania po polsku. */
export function authError(e) {
  return ({
    'auth/invalid-credential': 'Zły e-mail lub hasło.',
    'auth/wrong-password': 'Zły e-mail lub hasło.',
    'auth/user-not-found': 'Nie ma konta z tym e-mailem – załóż je.',
    'auth/email-already-in-use': 'Konto z tym e-mailem już istnieje – zaloguj się.',
    'auth/weak-password': 'Hasło musi mieć co najmniej 6 znaków.',
    'auth/invalid-email': 'Nieprawidłowy adres e-mail.',
    'auth/missing-password': 'Podaj hasło.',
    'auth/too-many-requests': 'Za dużo prób – spróbuj za kilka minut.',
    'auth/network-request-failed': 'Brak internetu.',
    'auth/operation-not-allowed': 'Ten sposób logowania nie jest włączony w Firebase.',
  })[e?.code] || e?.message || String(e);
}

export async function signOut() {
  if (!auth) return;
  localStorage.removeItem(HID_KEY);
  await fb.signOut(auth);
}

function disconnect() {
  unsubs.forEach(u => u());
  unsubs = []; hid = null; remote = {}; remoteSettings = null; pending = {};
}

async function findHousehold(email) {
  const { collection, query, where, getDocsFromServer } = fb;
  try {
    const snap = await getDocsFromServer(query(collection(db, 'households'), where('members', 'array-contains', email)));
    // wspólne gospodarstwo (cudze) ma pierwszeństwo przed własnym
    const docs = snap.docs.sort((a, b) => (a.data().owner === uid) - (b.data().owner === uid));
    return docs[0]?.id || null;
  } catch (e) {
    if (e.code === 'unavailable') return localStorage.getItem(HID_KEY); // offline → ostatnio używane
    throw e;
  }
}

async function connect(user) {
  disconnect();
  if (!user) { set({ user: null, owner: null, members: [], pending: false }); return; }
  uid = user.uid;
  const email = (user.email || '').toLowerCase();
  set({ user: { email, name: user.displayName || email }, error: '' });
  const { doc, getDoc, setDoc } = fb;

  let id = await findHousehold(email);
  const local = hooks.getData();
  if (!id) {
    // pierwsze logowanie: zakładamy gospodarstwo i przenosimy dane z telefonu
    id = uid;
    const ref = doc(db, 'households', id);
    const ex = await getDoc(ref).catch(() => null);
    if (!ex?.exists()) {
      await setDoc(ref, { owner: uid, members: [email], settings: local.settings, createdAt: Date.now() });
      hid = id;
      await uploadAll(local);
    }
  } else if (hasData(local) && localStorage.getItem(HID_KEY) !== id) {
    // dane w chmurze już są – lokalne zachowujemy na wszelki wypadek
    localStorage.setItem(BACKUP_KEY, JSON.stringify(local));
  }
  hid = id;
  localStorage.setItem(HID_KEY, id);
  subscribe();
}

const hasData = d => d && COLS.some(c => d[c]?.length);

function subscribe() {
  const { doc, collection, onSnapshot } = fb;
  unsubs.push(onSnapshot(doc(db, 'households', hid), s => {
    const d = s.data();
    if (!d) return;
    remoteSettings = stable(d.settings || {});
    set({ owner: d.owner, members: d.members || [] });
    hooks.onRemote({ settings: d.settings || {} });
  }, fail));
  for (const col of COLS) {
    unsubs.push(onSnapshot(collection(db, 'households', hid, col), { includeMetadataChanges: true }, snap => {
      const m = new Map(), arr = [];
      snap.forEach(d => { const r = { ...d.data(), id: d.id }; m.set(d.id, stable(r)); arr.push(r); });
      arr.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const first = !remote[col];
      remote[col] = m;
      pending[col] = snap.metadata.hasPendingWrites;
      set({ pending: Object.values(pending).some(Boolean) });
      hooks.onRemote({ [col]: arr });
      if (first && dirty && COLS.every(c => remote[c])) { dirty = false; push(hooks.getData()); }
    }, fail));
  }
}

async function uploadAll(d) {
  const { writeBatch, doc } = fb;
  const ops = [];
  for (const col of COLS) for (const r of d[col] || []) ops.push(b => b.set(doc(db, 'households', hid, col, r.id), r));
  await commit(ops, writeBatch);
}

function commit(ops, writeBatch) {
  const jobs = [];
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach(op => op(b));
    jobs.push(b.commit().catch(fail)); // offline: zatwierdzi się po powrocie sieci
  }
  return Promise.all(jobs);
}

/** Wysyła do chmury różnice między danymi w aplikacji a ostatnim stanem chmury. */
export function push(d) {
  if (!signedIn()) return;
  if (!COLS.every(c => remote[c])) { dirty = true; return; }
  const { writeBatch, doc } = fb;
  const ops = [];
  for (const col of COLS) {
    const known = remote[col], seen = new Set();
    for (const r of d[col]) {
      if (!r.id) continue;
      seen.add(r.id);
      const s = stable(r);
      if (known.get(r.id) !== s) { known.set(r.id, s); ops.push(b => b.set(doc(db, 'households', hid, col, r.id), r)); }
    }
    for (const id of [...known.keys()]) {
      if (!seen.has(id)) { known.delete(id); ops.push(b => b.delete(doc(db, 'households', hid, col, id))); }
    }
  }
  const st = stable(d.settings);
  if (remoteSettings !== st) { remoteSettings = st; ops.push(b => b.update(doc(db, 'households', hid), { settings: d.settings })); }
  if (ops.length) commit(ops, writeBatch);
}

export async function addMember(email) {
  email = email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Podaj poprawny e-mail');
  await fb.updateDoc(fb.doc(db, 'households', hid), { members: fb.arrayUnion(email) });
}

export async function removeMember(email) {
  await fb.updateDoc(fb.doc(db, 'households', hid), { members: fb.arrayRemove(email) });
}

export const isOwner = () => signedIn() && state.owner === uid;
