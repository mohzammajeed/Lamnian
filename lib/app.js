'use strict';
/**
 * Lamnian API — one handler used by:
 *   • Vercel  → api/[...path].js
 *   • locally → server.js (also serves the static files)
 * No npm dependencies.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRtdb, createFileDb, loadServiceAccount } = require('./db');

const ROOT = path.join(__dirname, '..');
const ON_VERCEL = !!process.env.VERCEL;

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
let userCfg = {};
try { userCfg = require('../config.json'); } catch { /* use defaults */ }
const DEFAULTS = {
  siteName: 'Lamnian',
  tagline: 'Weather, news and neighbours of the valley',
  location: { name: 'Lamnian', region: 'Azad Kashmir, Pakistan', lat: 34.2404, lon: 73.7768, timezone: 'Asia/Karachi' },
  prayer: { method: 1, school: 1 },
  emergency: [],
  ai: { provider: 'none', model: 'claude-sonnet-5-5', apiKeyEnv: 'LAMNIAN_AI_KEY', baseUrl: '', webhookUrl: '', assistantName: 'Lamnian AI' },
};
const config = {
  ...DEFAULTS, ...userCfg,
  location: { ...DEFAULTS.location, ...(userCfg.location || {}) },
  prayer: { ...DEFAULTS.prayer, ...(userCfg.prayer || {}) },
  ai: { ...DEFAULTS.ai, ...(userCfg.ai || {}) },
};

/* ------------------------------------------------------------------ */
/* Admin sign-in settings                                              */
/* ------------------------------------------------------------------ */
const FB = config.firebase || {};
const FB_PROJECT = (FB.config && FB.config.projectId) || '';
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || (FB.adminEmails || []).join(','))
  .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const FIREBASE_ON = !!FB_PROJECT && ADMIN_EMAILS.length > 0;

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */
const SA = loadServiceAccount();
const DB_URL = process.env.FIREBASE_DATABASE_URL || (FB.config && FB.config.databaseURL) || '';
let db = null;
if (SA && DB_URL) db = createRtdb(DB_URL, SA);
else if (!ON_VERCEL) db = createFileDb(path.join(ROOT, 'data', 'db.json'));

const SETUP_HINT = 'The database is not connected yet. In Vercel add the environment variable FIREBASE_SERVICE_ACCOUNT (see README), then redeploy.';
function needDb() { if (!db) throw bad(SETUP_HINT, 503); return db; }

/* ------------------------------------------------------------------ */
/* Admin password (local development only, or if you ask for it)       */
/* ------------------------------------------------------------------ */
function resolveAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (ON_VERCEL) return null;
  const f = path.join(ROOT, 'data', 'admin-password.txt');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const pw = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(f, pw + '\n', { mode: 0o600 });
  console.log('\n  First run: admin password generated: ' + pw + '  (saved in data/admin-password.txt)\n');
  return pw;
}
const WANT_PASSWORD = !FIREBASE_ON || process.env.ALLOW_PASSWORD_LOGIN === '1';
const ADMIN_PASSWORD = WANT_PASSWORD ? resolveAdminPassword() : null;
const PASSWORD_ON = !!ADMIN_PASSWORD;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

/* ------------------------------------------------------------------ */
/* Session cookie (stateless, signed)                                  */
/* ------------------------------------------------------------------ */
let _secret = null;
function secret() {
  if (_secret) return _secret;
  if (process.env.SESSION_SECRET) _secret = process.env.SESSION_SECRET;
  else if (SA) _secret = crypto.createHash('sha256').update('lamnian-session:' + SA.private_key).digest('hex');
  else if (!ON_VERCEL) {
    const f = path.join(ROOT, 'data', 'secret.key');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (fs.existsSync(f)) _secret = fs.readFileSync(f, 'utf8').trim();
    else { _secret = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, _secret, { mode: 0o600 }); }
  } else throw bad(SETUP_HINT, 503);
  return _secret;
}
const sign = (p) => crypto.createHmac('sha256', secret()).update(p).digest('base64url');
function makeToken() { const p = String(Date.now() + 7 * 864e5); return p + '.' + sign(p); }
function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip */ } }
  }
  return out;
}
function isAdmin(req) {
  const t = parseCookies(req.headers.cookie).lam_admin;
  if (!t) return false;
  const [p, s] = t.split('.');
  if (!p || !s || Number(p) < Date.now()) return false;
  let good; try { good = sign(p); } catch { return false; }
  return s.length === good.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good));
}

/* ---- Firebase (Google) sign-in: verify ID token without any SDK ---- */
const CERTS_URL = process.env.FIREBASE_CERTS_URL || 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certCache = { t: 0, certs: null };
async function getCerts() {
  if (certCache.certs && Date.now() - certCache.t < 3600e3) return certCache.certs;
  const r = await fetch(CERTS_URL, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('certs ' + r.status);
  certCache = { t: Date.now(), certs: await r.json() };
  return certCache.certs;
}
async function verifyFirebaseToken(idToken) {
  const fail = (m = 'Sign-in could not be verified.', s = 401) => Object.assign(new Error(m), { status: s });
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw fail();
  let header, payload;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); payload = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw fail(); }
  if (header.alg !== 'RS256' || !header.kid) throw fail();
  let certs;
  try { certs = await getCerts(); } catch { throw fail('Could not reach Google to verify sign-in. Try again.', 502); }
  const pem = certs[header.kid];
  if (!pem) throw fail();
  let valid = false;
  try { valid = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), new crypto.X509Certificate(pem).publicKey, Buffer.from(parts[2], 'base64url')); } catch { /* invalid */ }
  if (!valid) throw fail();
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== FB_PROJECT || payload.iss !== 'https://securetoken.google.com/' + FB_PROJECT) throw fail();
  if (!payload.sub || !(payload.exp > now) || !(payload.iat <= now + 60)) throw fail();
  if (now - payload.iat > 900) throw fail('Sign-in expired. Please sign in again.');
  const email = String(payload.email || '').toLowerCase();
  if (!payload.email_verified || !ADMIN_EMAILS.includes(email)) throw fail('This Google account is not allowed to manage Lamnian.', 403);
  return email;
}

/* ------------------------------------------------------------------ */
/* Collections                                                         */
/* ------------------------------------------------------------------ */
const NOTICE_CATS = ['Lost & Found', 'For Sale', 'Jobs', 'Help Needed', 'Rides & Transport', 'Announcement'];
const DIR_CATS = ['Shop', 'Food', 'Health', 'Education', 'Transport', 'Repairs & Services', 'Stay', 'Government', 'Other'];

// priv: never shown publicly (admin only).
const SPECS = {
  news: { image: 'optional', fields: {
    title: { min: 4, max: 120, req: true }, body: { min: 20, max: 5000, req: true, multiline: true },
    author: { max: 60 }, contact: { max: 80, priv: true } } },
  gallery: { image: 'required', fields: {
    caption: { max: 160 }, place: { max: 80 }, author: { max: 60 }, contact: { max: 80, priv: true } } },
  events: { image: 'optional', fields: {
    title: { min: 4, max: 120, req: true }, date: { type: 'date', req: true }, time: { max: 20 },
    place: { min: 2, max: 100, req: true }, description: { max: 1500, multiline: true },
    author: { max: 60 }, contact: { max: 80 } } },
  notices: { image: 'optional', fields: {
    category: { enum: NOTICE_CATS, req: true }, title: { min: 4, max: 120, req: true },
    body: { min: 10, max: 1500, req: true, multiline: true }, phone: { max: 30 }, author: { max: 60 } } },
  directory: { image: 'optional', fields: {
    name: { min: 2, max: 100, req: true }, category: { enum: DIR_CATS, req: true },
    phone: { max: 40 }, address: { max: 140 }, hours: { max: 80 }, description: { max: 300, multiline: true } } },
};
const NAMES = Object.keys(SPECS);

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const rid = (n) => crypto.randomBytes(n).toString('hex');

function clean(v, max, multiline) {
  let s = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = multiline ? s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return s.trim().slice(0, max);
}
function validate(spec, input) {
  const out = {};
  for (const [k, r] of Object.entries(spec.fields)) {
    const val = clean(input[k], r.max || 200, r.multiline);
    if (r.req && !val) throw bad(`Please fill in "${k}".`);
    if (val && r.min && val.length < r.min) throw bad(`"${k}" is too short.`);
    if (val && r.enum && !r.enum.includes(val)) throw bad(`Invalid ${k}.`);
    if (val && r.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(val) || Number.isNaN(Date.parse(val)))) throw bad('Invalid date.');
    out[k] = val;
  }
  return out;
}

const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024; // Vercel limits a request to 4.5 MB; the browser shrinks photos far below this.
function parseImage(dataUrl) {
  if (typeof dataUrl !== 'string') throw bad('Invalid image.');
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !/^data:image\/(jpeg|png|webp);base64$/.test(dataUrl.slice(0, comma))) throw bad('Only JPG, PNG or WebP images are allowed.');
  const b64 = dataUrl.slice(comma + 1);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw bad('Invalid image data.');
  if (b64.length * 0.75 > MAX_IMAGE_BYTES) throw bad('Image is too large. Please choose a smaller photo.', 413);
  const head = Buffer.from(b64.slice(0, 44), 'base64');
  let type = null;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) type = 'jpg';
  else if (head.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) type = 'png';
  else if (head.slice(0, 4).toString() === 'RIFF' && head.slice(8, 12).toString() === 'WEBP') type = 'webp';
  if (!type) throw bad('That file is not a valid image.');
  return { type, b64 };
}
const IMG_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function publicView(name, it) {
  const o = { id: it.id, createdAt: it.createdAt, featured: !!it.featured, image: it.img ? '/api/img/' + it.img : null };
  for (const [k, r] of Object.entries(SPECS[name].fields)) if (!r.priv) o[k] = it[k] || '';
  return o;
}
function adminView(name, it) {
  const o = { id: it.id, status: it.status, createdAt: it.createdAt, featured: !!it.featured, image: it.img ? '/api/img/' + it.img : null };
  for (const k of Object.keys(SPECS[name].fields)) o[k] = it[k] || '';
  return o;
}

async function readAll(name) {
  const o = await needDb().get('items/' + name);
  return o ? Object.entries(o).map(([id, v]) => ({ ...v, id })) : [];
}
const listCache = new Map(); // tiny per-instance cache; the CDN caches too
async function approvedList(name) {
  const c = listCache.get(name);
  if (c && Date.now() - c.t < 15e3) return c.items;
  let items = (await readAll(name)).filter((i) => i.status === 'approved');
  if (name === 'events') items.sort((a, b) => a.date.localeCompare(b.date));
  else if (name === 'directory') items.sort((a, b) => a.name.localeCompare(b.name));
  else items.sort((a, b) => (b.featured - a.featured) || b.createdAt.localeCompare(a.createdAt));
  listCache.set(name, { t: Date.now(), items });
  return items;
}

async function createItem(name, body, status) {
  const d = needDb(), spec = SPECS[name];
  const fields = validate(spec, body);
  let img = null;
  if (body.image) img = parseImage(body.image);
  else if (spec.image === 'required') throw bad('Please add a photo.');
  const id = rid(6);
  const item = { status, createdAt: new Date().toISOString(), featured: false, ...fields };
  let imgId = null;
  try {
    if (img) { imgId = rid(16); await d.set('images/' + imgId, { t: img.type, d: img.b64 }); item.img = imgId; item.imgType = img.type; }
    await d.set(`items/${name}/${id}`, item);
  } catch (e) {
    if (imgId) d.del('images/' + imgId).catch(() => {});
    throw e;
  }
  listCache.delete(name);
  return { ...item, id };
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */
const hits = new Map(); // best effort, per server instance
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}
// Shared across all Vercel instances (stored in the database).
async function sharedLimited(key, max, windowSec) {
  const d = needDb();
  const p = 'rate/' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 20) + '_' + Math.floor(Date.now() / (windowSec * 1000));
  const n = Number(await d.get(p)) || 0;
  if (n >= max) return true;
  await d.set(p, n + 1);
  return false;
}
function ipOf(req) {
  if (ON_VERCEL || process.env.TRUST_PROXY) {
    const x = req.headers['x-forwarded-for'];
    if (x) return String(x).split(',')[0].trim();
  }
  return req.socket && req.socket.remoteAddress || '?';
}

/* ------------------------------------------------------------------ */
/* Weather, air quality, prayer times                                  */
/* ------------------------------------------------------------------ */
async function getJSON(url, ms = 9000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'LamnianSite/1.0' } });
  if (!r.ok) throw new Error('Upstream ' + r.status);
  return r.json();
}
const wCache = { t: 0, data: null };
async function getWeather() {
  if (wCache.data && Date.now() - wCache.t < 10 * 60e3) return wCache.data;
  const { lat, lon } = config.location;
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
    '&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m,snowfall,is_day' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum,precipitation_probability_max,uv_index_max,wind_gusts_10m_max,snowfall_sum' +
    '&timezone=auto&forecast_days=7&wind_speed_unit=kmh';
  const aqUrl = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + lat + '&longitude=' + lon + '&current=us_aqi,pm2_5,pm10&timezone=auto';
  try {
    const [w, aq] = await Promise.all([getJSON(url), getJSON(aqUrl).catch(() => null)]);
    const c = w.current;
    const startKey = c.time.slice(0, 13) + ':00';
    let i0 = w.hourly.time.findIndex((t) => t >= startKey);
    if (i0 < 0) i0 = 0;
    const hourly = [];
    for (let i = i0; i < Math.min(i0 + 24, w.hourly.time.length); i++) {
      hourly.push({ time: w.hourly.time[i], temp: w.hourly.temperature_2m[i], pop: w.hourly.precipitation_probability[i], code: w.hourly.weather_code[i], wind: w.hourly.wind_speed_10m[i], snow: w.hourly.snowfall[i], day: w.hourly.is_day[i] });
    }
    const d = w.daily;
    const daily = d.time.map((t, i) => ({ date: t, code: d.weather_code[i], max: d.temperature_2m_max[i], min: d.temperature_2m_min[i], sunrise: d.sunrise[i], sunset: d.sunset[i], rain: d.precipitation_sum[i], pop: d.precipitation_probability_max[i], uv: d.uv_index_max[i], gust: d.wind_gusts_10m_max[i], snow: d.snowfall_sum[i] }));
    const data = {
      updated: new Date().toISOString(), elevation: w.elevation, stale: false,
      current: { time: c.time, temp: c.temperature_2m, feels: c.apparent_temperature, humidity: c.relative_humidity_2m, isDay: c.is_day, precip: c.precipitation, code: c.weather_code, clouds: c.cloud_cover, pressure: c.pressure_msl, wind: c.wind_speed_10m, windDir: c.wind_direction_10m, gust: c.wind_gusts_10m },
      hourly, daily,
      aqi: aq && aq.current ? { us: aq.current.us_aqi, pm25: aq.current.pm2_5, pm10: aq.current.pm10 } : null,
    };
    wCache.t = Date.now(); wCache.data = data;
    return data;
  } catch (e) {
    console.error('Weather fetch failed:', e.message);
    if (wCache.data) return { ...wCache.data, stale: true };
    throw bad('Weather service is not reachable right now.', 502);
  }
}

const pCache = new Map();
function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
async function getPrayer() {
  const today = todayIn(config.location.timezone);
  if (pCache.has(today)) return pCache.get(today);
  const [y, m, d] = today.split('-');
  const { lat, lon, timezone } = config.location;
  const url = `https://api.aladhan.com/v1/timings/${d}-${m}-${y}?latitude=${lat}&longitude=${lon}&method=${config.prayer.method}&school=${config.prayer.school}&timezonestring=${encodeURIComponent(timezone)}`;
  try {
    const j = await getJSON(url);
    const t = j.data.timings;
    const out = { date: today, timings: { Fajr: t.Fajr, Sunrise: t.Sunrise, Dhuhr: t.Dhuhr, Asr: t.Asr, Maghrib: t.Maghrib, Isha: t.Isha }, hijri: j.data.date && j.data.date.hijri ? `${j.data.date.hijri.day} ${j.data.date.hijri.month.en} ${j.data.date.hijri.year}` : '' };
    pCache.clear(); pCache.set(today, out);
    return out;
  } catch (e) {
    console.error('Prayer fetch failed:', e.message);
    throw bad('Prayer times are not reachable right now.', 502);
  }
}

const WMO = { 0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers',
  85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail' };

/* ------------------------------------------------------------------ */
/* AI assistant (pluggable)                                            */
/* ------------------------------------------------------------------ */
function aiSettings() {
  const a = config.ai;
  const provider = (process.env.LAMNIAN_AI_PROVIDER || a.provider || 'none').toLowerCase();
  const key = process.env[a.apiKeyEnv || 'LAMNIAN_AI_KEY'] || '';
  const webhook = process.env.LAMNIAN_AI_WEBHOOK || a.webhookUrl || '';
  const connected = provider === 'webhook' ? !!webhook : (provider === 'anthropic' || provider === 'openai') && !!key;
  return { provider, key, webhook, model: process.env.LAMNIAN_AI_MODEL || a.model, baseUrl: a.baseUrl, name: a.assistantName, connected };
}
async function aiContext() {
  const L = config.location;
  const lines = [`Place: ${L.name}, ${L.region} (lat ${L.lat}, lon ${L.lon}). Local date: ${todayIn(L.timezone)}.`];
  const w = wCache.data;
  if (w) {
    const c = w.current;
    lines.push(`Current weather: ${Math.round(c.temp)}°C (feels ${Math.round(c.feels)}°C), ${WMO[c.code] || 'unknown'}, humidity ${c.humidity}%, wind ${Math.round(c.wind)} km/h.`);
    lines.push('Forecast: ' + w.daily.slice(0, 5).map((d) => `${d.date}: ${Math.round(d.min)}–${Math.round(d.max)}°C, ${WMO[d.code] || ''}, rain chance ${d.pop ?? 0}%`).join(' | '));
  }
  try {
    const news = (await approvedList('news')).slice(0, 5);
    if (news.length) lines.push('Latest local news: ' + news.map((n) => n.title).join(' | '));
    const today = todayIn(L.timezone);
    const ev = (await approvedList('events')).filter((e) => e.date >= today).slice(0, 5);
    if (ev.length) lines.push('Upcoming events: ' + ev.map((e) => `${e.title} (${e.date}, ${e.place})`).join(' | '));
  } catch { /* context is optional */ }
  return lines.join('\n');
}
const SYSTEM_PROMPT = (ctx) => `You are ${config.ai.assistantName}, the friendly assistant of the community website for ${config.location.name}, a village area in ${config.location.region}.
Help local people with weather questions, travel planning, local news, events and everyday questions. Keep answers short, clear and practical. If the user writes in Urdu or Roman Urdu, answer in the same language.
Use the local data below when it is relevant. Do not invent local facts, phone numbers or road conditions you do not have; say you are not sure and suggest asking the site admin or official sources (PMD for weather warnings, Rescue 1122 for emergencies).

LOCAL DATA
${ctx}`;

async function callAI(messages) {
  const s = aiSettings();
  const ctx = await aiContext();
  const ctl = AbortSignal.timeout(28000);
  if (s.provider === 'anthropic') {
    const r = await fetch((s.baseUrl || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST', signal: ctl,
      headers: { 'content-type': 'application/json', 'x-api-key': s.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: s.model, max_tokens: 700, system: SYSTEM_PROMPT(ctx), messages }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error && j.error.message || 'AI error');
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  }
  if (s.provider === 'openai') {
    const r = await fetch((s.baseUrl || 'https://api.openai.com/v1') + '/chat/completions', {
      method: 'POST', signal: ctl,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.key },
      body: JSON.stringify({ model: s.model, max_tokens: 700, messages: [{ role: 'system', content: SYSTEM_PROMPT(ctx) }, ...messages] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error && j.error.message || 'AI error');
    return String(j.choices[0].message.content || '').trim();
  }
  if (s.provider === 'webhook') {
    // Your own AI server: receives {messages, context, system}, must reply {reply: "..."}
    const r = await fetch(s.webhook, { method: 'POST', signal: ctl, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages, context: ctx, system: SYSTEM_PROMPT(ctx) }) });
    const j = await r.json();
    if (!r.ok || typeof j.reply !== 'string') throw new Error('AI webhook error');
    return j.reply.trim();
  }
  throw bad('AI is not connected yet.', 503);
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */
// NOTE: keep in sync with vercel.json "headers" (Vercel serves the static pages itself).
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const ADMIN_CSP = "default-src 'self'; script-src 'self' https://www.gstatic.com https://apis.google.com; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https://*.googleusercontent.com; connect-src 'self' https://*.googleapis.com; frame-src https://*.firebaseapp.com https://accounts.google.com https://apis.google.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function send(res, status, body, headers = {}) { res.writeHead(status, { ...SEC_HEADERS, ...headers }); res.end(body); }
function json(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}
const CDN = (s, swr) => `public, max-age=0, s-maxage=${s}` + (swr ? `, stale-while-revalidate=${swr}` : '');

function readBody(req, limit) {
  // Vercel may already have read and parsed the body for us.
  if (req.body !== undefined && req.body !== null && typeof req.body !== 'function') {
    const b = req.body;
    if (Buffer.isBuffer(b)) { try { return Promise.resolve(b.length ? JSON.parse(b.toString('utf8')) : {}); } catch { return Promise.reject(bad('Invalid request.')); } }
    if (typeof b === 'string') { try { return Promise.resolve(b ? JSON.parse(b) : {}); } catch { return Promise.reject(bad('Invalid request.')); } }
    if (typeof b === 'object') return Promise.resolve(b);
  }
  return new Promise((resolve, reject) => {
    let size = 0, tooBig = false; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) tooBig = true; else chunks.push(c); });
    req.on('end', () => {
      if (tooBig) return reject(bad('That upload is too large.', 413));
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(bad('Invalid request.')); }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let p = url.pathname.replace(/\/+$/, '') || '/';
  if (!p.startsWith('/api/') && req.query && req.query.path) p = '/api/' + [].concat(req.query.path).join('/');
  const parts = p.split('/').filter(Boolean); // ['api', ...]
  const ip = ipOf(req);

  // CSRF defence for anything that changes state.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!req.headers['x-requested-with']) throw bad('Bad request.', 403);
    const origin = req.headers.origin;
    if (origin) { try { if (new URL(origin).host !== req.headers.host) throw 0; } catch { throw bad('Bad origin.', 403); } }
  }

  /* ---------- public ---------- */
  if (req.method === 'GET' && p === '/api/config') {
    let alert = null;
    try { const s = await needDb().get('settings'); alert = s && s.alert && s.alert.text ? s.alert : null; } catch { /* banner is optional */ }
    const a = aiSettings();
    return json(res, 200, {
      siteName: config.siteName, tagline: config.tagline, location: config.location, emergency: config.emergency,
      today: todayIn(config.location.timezone), alert, ai: { connected: a.connected, name: a.name },
      noticeCats: NOTICE_CATS, dirCats: DIR_CATS,
    }, { 'Cache-Control': CDN(30, 120) });
  }
  if (req.method === 'GET' && p === '/api/weather') return json(res, 200, await getWeather(), { 'Cache-Control': CDN(600, 1800) });
  if (req.method === 'GET' && p === '/api/prayer') return json(res, 200, await getPrayer(), { 'Cache-Control': CDN(3600, 3600) });
  if (req.method === 'GET' && p === '/api/auth-config') return json(res, 200, { firebase: FIREBASE_ON ? FB.config : null, passwordLogin: PASSWORD_ON });

  if (req.method === 'GET' && parts[1] === 'img' && parts.length === 3) {
    if (!/^[a-f0-9]{32}$/.test(parts[2])) throw bad('Not found.', 404);
    const o = await needDb().get('images/' + parts[2]);
    if (!o || !o.d || !IMG_MIME[o.t]) throw bad('Not found.', 404);
    const buf = Buffer.from(o.d, 'base64');
    return send(res, 200, buf, { 'Content-Type': IMG_MIME[o.t], 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400, s-maxage=86400' });
  }

  if (req.method === 'GET' && parts.length === 2 && NAMES.includes(parts[1])) {
    const items = await approvedList(parts[1]);
    return json(res, 200, { items: items.map((i) => publicView(parts[1], i)) }, { 'Cache-Control': CDN(20, 60) });
  }

  if (req.method === 'POST' && parts[1] === 'submit' && parts.length === 3 && NAMES.includes(parts[2])) {
    needDb();
    if (limited('sub:' + ip, 8, 3600e3) || await sharedLimited('sub:' + ip, 8, 3600)) throw bad('You have sent a lot of posts. Please try again later.', 429);
    const body = await readBody(req, 4 * 1024 * 1024);
    if (body.website) return json(res, 200, { ok: true }); // honeypot: bots fill this
    await createItem(parts[2], body, 'pending');
    return json(res, 200, { ok: true, message: 'Thank you! Your post will appear after the admin approves it.' });
  }

  if (req.method === 'POST' && p === '/api/ai') {
    const a = aiSettings();
    if (!a.connected) throw bad('The AI assistant is not connected yet.', 503);
    if (limited('ai:' + ip, 20, 3600e3)) throw bad('Please wait a little before asking more questions.', 429);
    const body = await readBody(req, 64 * 1024);
    const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-10)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: clean(m.content, 1000, true) })).filter((m) => m.content);
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw bad('Please type a question.');
    await getWeather().catch(() => {});
    try { return json(res, 200, { reply: await callAI(msgs) }); }
    catch (e) { console.error('AI error:', e.message); throw bad('The assistant could not answer right now. Please try again.', 502); }
  }

  /* ---------- admin ---------- */
  const sessionCookie = () => {
    const secure = ON_VERCEL || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return `lam_admin=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}${secure}`;
  };
  if (req.method === 'POST' && p === '/api/admin/firebase-login') {
    if (!FIREBASE_ON) throw bad('Google sign-in is not set up on this server.', 404);
    if (limited('login:' + ip, 10, 10 * 60e3)) throw bad('Too many attempts. Try again in a few minutes.', 429);
    const body = await readBody(req, 16 * 1024);
    const email = await verifyFirebaseToken(body.idToken);
    console.log('Admin signed in with Google:', email);
    return json(res, 200, { ok: true, email }, { 'Set-Cookie': sessionCookie() });
  }
  if (req.method === 'POST' && p === '/api/admin/login') {
    if (!PASSWORD_ON) throw bad('Password login is turned off. Use “Sign in with Google”.', 403);
    if (limited('login:' + ip, 6, 10 * 60e3)) throw bad('Too many attempts. Try again in a few minutes.', 429);
    const body = await readBody(req, 4096);
    if (!crypto.timingSafeEqual(sha(body.password || ''), sha(ADMIN_PASSWORD))) throw bad('Wrong password.', 401);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie() });
  }
  if (req.method === 'POST' && p === '/api/admin/logout') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': `lam_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${ON_VERCEL ? '; Secure' : ''}` });
  }

  if (parts[1] === 'admin') {
    if (!isAdmin(req)) throw bad('Please log in.', 401);
    const d = needDb();

    if (req.method === 'GET' && p === '/api/admin/overview') {
      const [lists, settings] = await Promise.all([Promise.all(NAMES.map(readAll)), d.get('settings')]);
      const out = {};
      NAMES.forEach((n, i) => { out[n] = lists[i].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((it) => adminView(n, it)); });
      const a = aiSettings();
      return json(res, 200, { collections: out, settings: settings && settings.alert ? settings : { alert: { text: '', level: 'info' } }, ai: { provider: a.provider, connected: a.connected, model: a.model }, noticeCats: NOTICE_CATS, dirCats: DIR_CATS });
    }
    if (req.method === 'GET' && p === '/api/admin/backup') {
      const [settings, ...lists] = await Promise.all([d.get('settings'), ...NAMES.map(readAll)]);
      const out = { exportedAt: new Date().toISOString(), note: 'Photos are not included in this file.', settings };
      NAMES.forEach((n, i) => { out[n] = lists[i]; });
      return json(res, 200, out, { 'Content-Disposition': 'attachment; filename="lamnian-backup.json"' });
    }
    if (req.method === 'POST' && p === '/api/admin/settings') {
      const body = await readBody(req, 8192);
      const level = ['info', 'warning', 'danger'].includes(body.level) ? body.level : 'info';
      const settings = { alert: { text: clean(body.text, 240), level, updatedAt: new Date().toISOString() } };
      await d.set('settings', settings);
      return json(res, 200, { ok: true, settings });
    }
    if (req.method === 'POST' && parts[2] === 'create' && NAMES.includes(parts[3])) {
      const body = await readBody(req, 4 * 1024 * 1024);
      const it = await createItem(parts[3], body, 'approved');
      if (parts[3] === 'news' && body.featured) { await d.patch(`items/news/${it.id}`, { featured: true }); it.featured = true; listCache.clear(); }
      return json(res, 200, { ok: true, item: adminView(parts[3], it) });
    }
    if (req.method === 'POST' && parts[2] === 'edit' && NAMES.includes(parts[3])) {
      const name = parts[3];
      if (!/^[a-f0-9]{12}$/.test(parts[4] || '')) throw bad('Not found.', 404);
      const cur = await d.get(`items/${name}/${parts[4]}`);
      if (!cur) throw bad('Not found.', 404);
      const fields = validate(SPECS[name], await readBody(req, 64 * 1024));
      await d.patch(`items/${name}/${parts[4]}`, fields);
      listCache.delete(name);
      return json(res, 200, { ok: true, item: adminView(name, { ...cur, ...fields, id: parts[4] }) });
    }
    if (req.method === 'POST' && parts[2] === 'item' && NAMES.includes(parts[3])) {
      const name = parts[3], id = parts[4], action = parts[5];
      if (!/^[a-f0-9]{12}$/.test(id || '')) throw bad('Not found.', 404);
      const cur = await d.get(`items/${name}/${id}`);
      if (!cur) throw bad('Not found.', 404);
      const patch = { approve: { status: 'approved' }, reject: { status: 'rejected' }, pending: { status: 'pending' }, feature: { featured: true }, unfeature: { featured: false } }[action];
      if (patch) await d.patch(`items/${name}/${id}`, patch);
      else if (action === 'delete') {
        if (cur.img) await d.del('images/' + cur.img);
        await d.del(`items/${name}/${id}`);
      } else throw bad('Unknown action.');
      listCache.delete(name);
      return json(res, 200, { ok: true });
    }
  }

  throw bad('Not found.', 404);
}

async function handle(req, res) {
  try { return await route(req, res); }
  catch (e) {
    let status = e.status || 500, msg = e.message;
    if (!e.status) {
      console.error(e);
      // Database / Google errors: show a helpful but safe message.
      status = 503; msg = /^Database |Google service-account/.test(String(e.message)) ? 'The database could not be reached. Check the Firebase setup in Vercel (see README).' : 'Something went wrong.';
      if (!/^Database |Google service-account/.test(String(e.message))) status = 500;
    }
    if (!res.headersSent) return json(res, status, { error: msg });
  }
}

module.exports = { handle, SEC_HEADERS, ADMIN_CSP, FIREBASE_ON, PASSWORD_ON, ADMIN_EMAILS, db: () => db };
