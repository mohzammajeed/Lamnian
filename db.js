// ALL saving and loading of website data happens here (browser → Firebase directly,
// protected by firestore.rules). Same idea as the RishtaCV site.
//
// Firestore layout:
//   news / gallery / events / notices / directory  /{postId}   one document per post
//        { status: 'pending'|'approved'|'rejected', featured, createdAt, image (photo as data-URL), ...fields }
//   contacts/{postId}   { col, contact }   private phone number of a news/gallery post (admin only)
//   settings/alert      { text, level, updatedAt }   banner at the top of the site
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut as fbSignOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, getDocs, query, where, limit, writeBatch, setDoc } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

export const NAMES = ['news', 'gallery', 'events', 'notices', 'directory'];
const PRIVATE = { news: 'contact', gallery: 'contact' }; // field kept out of the public document
const MAX_IMAGE = 450000;                                 // characters; must match firestore.rules

/* ---------------- connection ---------------- */
let conn = null;
function init() {
  if (!conn) conn = fetch('/config.json').then((r) => r.json()).then((c) => {
    const app = initializeApp(c.firebase.config);
    return { auth: getAuth(app), db: getFirestore(app) };
  }).catch((e) => { conn = null; throw e; });
  return conn;
}
const TO = (p, ms = 12000) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(Object.assign(new Error('timeout'), { code: 'unavailable' })), ms))]);

// Turns Firebase errors into messages a person can act on.
function explain(e) {
  const c = e.code || '';
  let msg = e.message;
  if (c === 'permission-denied') msg = 'Not allowed. Publish firestore.rules in Firebase (Firestore Database → Rules), or this account is not an admin.';
  else if (c === 'not-found' || c === 'failed-precondition') msg = 'The Firestore database is not created yet (Firebase → Firestore Database → Create database).';
  else if (c === 'unavailable') msg = 'Could not reach Firebase. Check your internet and try again.';
  else if (c === 'resource-exhausted') msg = 'The free daily Firebase limit was reached. Try again tomorrow.';
  else if (/import|Failed to fetch|NetworkError/i.test(msg || '')) msg = 'Could not load Firebase. Check your internet.';
  return Object.assign(new Error(msg || 'Something went wrong.'), { code: c });
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { throw e.friendly ? e : Object.assign(explain(e), { friendly: true }); } };
const mine = (msg) => Object.assign(new Error(msg), { friendly: true }); // our own validation messages

/* ---------------- validation (rules re-check everything on the server side) ---------------- */
function clean(v, max, multiline) {
  let s = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = multiline ? s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return s.trim().slice(0, max);
}
function fieldsOf(name, input) {
  const out = {};
  for (const f of window.LAM.FORMS[name].fields) {
    const v = clean(input[f.name], f.max || 200, f.type === 'textarea');
    if (f.req && !v) throw mine(`Please fill in “${f.label}”.`);
    if (v && f.min && v.length < f.min) throw mine(`“${f.label}” is too short (at least ${f.min} characters).`);
    if (v && f.type === 'select' && !f.options.includes(v)) throw mine(`Invalid ${f.label}.`);
    if (v && f.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)))) throw mine('Invalid date.');
    out[f.name] = v;
  }
  return out;
}
function imageOf(name, data) {
  const need = window.LAM.FORMS[name].image === 'required';
  if (!data) { if (need) throw mine('Please add a photo.'); return null; }
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(data)) throw mine('Only JPG, PNG or WebP photos are allowed.');
  if (data.length > MAX_IMAGE) throw mine('That photo is too large. Please choose a smaller one.');
  return data;
}

// Writes one post (+ its private contact) in a single step.
async function writePost(db, name, input, status, featured) {
  const all = fieldsOf(name, input), image = imageOf(name, input.image);
  const priv = PRIVATE[name], contact = priv ? all[priv] : '';
  if (priv) delete all[priv];
  const ref = doc(collection(db, name));
  const item = { ...all, status, featured: !!featured, createdAt: new Date().toISOString() };
  if (image) item.image = image;
  const b = writeBatch(db);
  b.set(ref, item);
  if (contact) b.set(doc(db, 'contacts', ref.id), { col: name, contact });
  await TO(b.commit(), 20000);
}

/* ---------------- public site ---------------- */
function sortItems(name, items) {
  if (name === 'events') return items.sort((a, b) => a.date.localeCompare(b.date));
  if (name === 'directory') return items.sort((a, b) => a.name.localeCompare(b.name));
  return items.sort((a, b) => (b.featured - a.featured) || b.createdAt.localeCompare(a.createdAt));
}

export const listApproved = guard(async (name) => {
  const { db } = await init();
  const snap = await TO(getDocs(query(collection(db, name), where('status', '==', 'approved'), limit(300))));
  return sortItems(name, snap.docs.map((d) => ({ ...d.data(), id: d.id })));
});

export const getAlert = guard(async () => {
  const { db } = await init();
  const s = await TO(getDoc(doc(db, 'settings', 'alert')));
  const a = s.exists() ? s.data() : null;
  return a && a.text ? a : null;
});

// Visitors send posts here. They stay "pending" until the admin approves them.
export const submit = guard(async (name, input) => {
  if (input.website) return; // honeypot: bots fill this hidden field
  const now = Date.now();
  let log = [];
  try { log = JSON.parse(localStorage.getItem('lam-posts') || '[]').filter((t) => now - t < 3600e3); } catch { /* ignore */ }
  if (log.length >= 8) throw mine('You have sent a lot of posts. Please try again later.');
  const { db } = await init();
  await writePost(db, name, input, 'pending', false);
  try { localStorage.setItem('lam-posts', JSON.stringify([...log, now])); } catch { /* ignore */ }
});

/* ---------------- admin ---------------- */
export const onAuth = async (cb) => { const { auth } = await init(); return onAuthStateChanged(auth, cb); };
export const signIn = guard(async () => {
  const { auth } = await init();
  const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
  await signInWithPopup(auth, p);
});
export const signOut = guard(async () => { const { auth } = await init(); await fbSignOut(auth); });

// Everything for the admin panel. Fails with code "permission-denied" for non-admin accounts.
export const adminOverview = guard(async () => {
  const { db } = await init();
  const [lists, contacts, alert] = await TO(Promise.all([
    Promise.all(NAMES.map((n) => getDocs(collection(db, n)))),
    getDocs(collection(db, 'contacts')),
    getDoc(doc(db, 'settings', 'alert')),
  ]), 20000);
  const phone = {}; contacts.forEach((d) => { phone[d.id] = d.data().contact || ''; });
  const collections = {};
  NAMES.forEach((n, i) => {
    collections[n] = lists[i].docs.map((d) => ({ ...d.data(), id: d.id, ...(PRIVATE[n] ? { [PRIVATE[n]]: phone[d.id] || '' } : {}) }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  });
  return { collections, settings: { alert: alert.exists() ? alert.data() : { text: '', level: 'info' } } };
});

const ACTIONS = { approve: { status: 'approved' }, reject: { status: 'rejected' }, pending: { status: 'pending' }, feature: { featured: true }, unfeature: { featured: false } };
export const adminAct = guard(async (name, id, action) => {
  const { db } = await init();
  if (action === 'delete') {
    const b = writeBatch(db); b.delete(doc(db, name, id)); b.delete(doc(db, 'contacts', id));
    return TO(b.commit());
  }
  if (!ACTIONS[action]) throw mine('Unknown action.');
  const b = writeBatch(db); b.update(doc(db, name, id), ACTIONS[action]); await TO(b.commit());
});
export const adminEdit = guard(async (name, id, input) => {
  const { db } = await init();
  const all = fieldsOf(name, input), priv = PRIVATE[name], contact = priv ? all[priv] : '';
  if (priv) delete all[priv];
  const b = writeBatch(db);
  b.update(doc(db, name, id), all);
  if (priv) b.set(doc(db, 'contacts', id), { col: name, contact });
  await TO(b.commit());
});
export const adminCreate = guard(async (name, input) => {
  const { db } = await init();
  await writePost(db, name, input, 'approved', name === 'news' && input.featured);
});
export const saveAlert = guard(async (text, level) => {
  const { db } = await init();
  const lv = ['info', 'warning', 'danger'].includes(level) ? level : 'info';
  await TO(setDoc(doc(db, 'settings', 'alert'), { text: clean(text, 240), level: lv, updatedAt: new Date().toISOString() }));
});
