'use strict';
/**
 * Lamnian — community website server.
 * Zero dependencies: only Node.js built-ins (Node 18+).
 *
 * Run:   node server.js
 * Admin: http://localhost:3000/admin
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(ROOT, 'uploads');
const PORT = Number(process.env.PORT) || 3000;
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const DEFAULTS = {
  siteName: 'Lamnian',
  tagline: 'Weather, news and neighbours of the valley',
  location: { name: 'Lamnian', region: 'Azad Kashmir, Pakistan', lat: 34.2404, lon: 73.7768, timezone: 'Asia/Karachi' },
  prayer: { method: 1, school: 1 },
  emergency: [],
  ai: { provider: 'none', model: 'claude-sonnet-5-5', apiKeyEnv: 'LAMNIAN_AI_KEY', baseUrl: '', webhookUrl: '', assistantName: 'Lamnian AI' },
};
const userCfg = readJSON(path.join(ROOT, 'config.json'), {});
const config = {
  ...DEFAULTS, ...userCfg,
  location: { ...DEFAULTS.location, ...(userCfg.location || {}) },
  prayer: { ...DEFAULTS.prayer, ...(userCfg.prayer || {}) },
  ai: { ...DEFAULTS.ai, ...(userCfg.ai || {}) },
};

/* ------------------------------------------------------------------ */
/* Admin sign-in: Firebase (Google) and/or password                    */
/* ------------------------------------------------------------------ */
const FB = config.firebase || {};
const FB_PROJECT = (FB.config && FB.config.projectId) || '';
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || (FB.adminEmails || []).join(','))
  .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const FIREBASE_ON = !!FB_PROJECT && ADMIN_EMAILS.length > 0;
// Once Google sign-in is configured, the password login is switched off (unless you ask for it).
const PASSWORD_ON = !FIREBASE_ON || process.env.ALLOW_PASSWORD_LOGIN === '1';

/* ------------------------------------------------------------------ */
/* Admin password + signing secret                                     */
/* ------------------------------------------------------------------ */
function resolveAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const f = path.join(DATA, 'admin-password.txt');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const pw = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(f, pw + '\n', { mode: 0o600 });
  console.log('\n  First run: an admin password was generated for you.');
  console.log('  Password: ' + pw);
  console.log('  (saved in data/admin-password.txt — or set ADMIN_PASSWORD env var)\n');
  return pw;
}
const ADMIN_PASSWORD = PASSWORD_ON ? resolveAdminPassword() : null;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function loadSecret() {
  const f = path.join(DATA, 'secret.key');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();
const sign = (p) => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');

function makeToken() {
  const p = String(Date.now() + 7 * 864e5);
  return p + '.' + sign(p);
}
function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const CERTS_URL = process.env.FIREBASE_CERTS_URL || 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certCache = { t: 0, certs: null };
async function getCerts() {
  if (certCache.certs && Date.now() - certCache.t < 3600e3) return certCache.certs;
  const r = await fetch(CERTS_URL, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('certs ' + r.status);
  certCache = { t: Date.now(), certs: await r.json() };
  return certCache.certs;
}
/** Verifies a Firebase ID token and returns the signed-in admin's email. */
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

function isAdmin(req) {
  const t = parseCookies(req.headers.cookie).lam_admin;
  if (!t) return false;
  const [p, s] = t.split('.');
  if (!p || !s || Number(p) < Date.now()) return false;
  const good = sign(p);
  return s.length === good.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good));
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

const store = {};
for (const n of NAMES) store[n] = readJSON(path.join(DATA, n + '.json'), []);
let settings = readJSON(path.join(DATA, 'settings.json'), { alert: { text: '', level: 'info' } });

function persist(name) {
  const f = path.join(DATA, name + '.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(store[name], null, 1));
  fs.renameSync(f + '.tmp', f);
}
function persistSettings() {
  const f = path.join(DATA, 'settings.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(settings, null, 1));
  fs.renameSync(f + '.tmp', f);
}

// One welcome post so the news page is never completely blank on day one.
if (!fs.existsSync(path.join(DATA, 'news.json'))) {
  store.news.push({
    id: crypto.randomBytes(6).toString('hex'), status: 'approved', featured: true,
    createdAt: new Date().toISOString(), title: 'Welcome to Lamnian online',
    body: 'This is our community website. Check the weather, read local news, share photos of our valley, post events and notices, and find useful numbers. Anything you send is reviewed by the site admin before it appears here.',
    author: 'Lamnian Admin', contact: '',
  });
  persist('news');
}

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function clean(v, max, multiline) {
  let s = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = multiline ? s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return s.trim().slice(0, max);
}

function validate(spec, input, label = '') {
  const out = {};
  for (const [k, r] of Object.entries(spec.fields)) {
    const val = clean(input[k], r.max || 200, r.multiline);
    if (r.req && !val) throw bad(`Please fill in "${k}".`);
    if (val && r.min && val.length < r.min) throw bad(`"${k}" is too short.`);
    if (val && r.enum && !r.enum.includes(val)) throw bad(`Invalid ${k}.`);
    if (val && r.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(val) || Number.isNaN(Date.parse(val))) throw bad('Invalid date.');
    }
    out[k] = val;
  }
  return out;
}

function saveImage(dataUrl) {
  if (typeof dataUrl !== 'string') throw bad('Invalid image.');
  const comma = dataUrl.indexOf(',');
  const head = dataUrl.slice(0, comma);
  if (comma < 0 || !/^data:image\/(jpeg|png|webp);base64$/.test(head)) throw bad('Only JPG, PNG or WebP images are allowed.');
  const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  if (buf.length > 5 * 1024 * 1024) throw bad('Image is too large (max 5 MB).');
  let ext = null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = '.jpg';
  else if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = '.png';
  else if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') ext = '.webp';
  if (!ext) throw bad('That file is not a valid image.');
  const name = crypto.randomBytes(12).toString('hex') + ext;
  fs.writeFileSync(path.join(UPLOADS, name), buf);
  return name;
}
function removeImage(name) {
  if (name && /^[a-f0-9]{24}\.(jpg|png|webp)$/.test(name)) fs.rm(path.join(UPLOADS, name), () => {});
}

function publicView(name, it) {
  const spec = SPECS[name];
  const o = { id: it.id, createdAt: it.createdAt, featured: !!it.featured, image: it.image ? '/uploads/' + it.image : null };
  for (const [k, r] of Object.entries(spec.fields)) if (!r.priv) o[k] = it[k] || '';
  return o;
}
function adminView(name, it) {
  const spec = SPECS[name];
  const o = { id: it.id, status: it.status, createdAt: it.createdAt, featured: !!it.featured, image: it.image ? '/uploads/' + it.image : null };
  for (const k of Object.keys(spec.fields)) o[k] = it[k] || '';
  return o;
}

function createItem(name, body, status) {
  const spec = SPECS[name];
  const fields = validate(spec, body);
  let image = null;
  if (body.image) image = saveImage(body.image);
  else if (spec.image === 'required') throw bad('Please add a photo.');
  const item = { id: crypto.randomBytes(6).toString('hex'), status, createdAt: new Date().toISOString(), featured: false, image, ...fields };
  store[name].push(item);
  persist(name);
  return item;
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) if (!arr.some((t) => now - t < 3600e3)) hits.delete(k);
}, 600e3).unref();

function ipOf(req) {
  if (process.env.TRUST_PROXY) {
    const x = req.headers['x-forwarded-for'];
    if (x) return String(x).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '?';
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
      hourly.push({
        time: w.hourly.time[i], temp: w.hourly.temperature_2m[i], pop: w.hourly.precipitation_probability[i],
        code: w.hourly.weather_code[i], wind: w.hourly.wind_speed_10m[i], snow: w.hourly.snowfall[i], day: w.hourly.is_day[i],
      });
    }
    const d = w.daily;
    const daily = d.time.map((t, i) => ({
      date: t, code: d.weather_code[i], max: d.temperature_2m_max[i], min: d.temperature_2m_min[i],
      sunrise: d.sunrise[i], sunset: d.sunset[i], rain: d.precipitation_sum[i], pop: d.precipitation_probability_max[i],
      uv: d.uv_index_max[i], gust: d.wind_gusts_10m_max[i], snow: d.snowfall_sum[i],
    }));
    const data = {
      updated: new Date().toISOString(), elevation: w.elevation, stale: false,
      current: {
        time: c.time, temp: c.temperature_2m, feels: c.apparent_temperature, humidity: c.relative_humidity_2m,
        isDay: c.is_day, precip: c.precipitation, code: c.weather_code, clouds: c.cloud_cover, pressure: c.pressure_msl,
        wind: c.wind_speed_10m, windDir: c.wind_direction_10m, gust: c.wind_gusts_10m,
      },
      hourly, daily,
      aqi: aq && aq.current ? { us: aq.current.us_aqi, pm25: aq.current.pm2_5, pm10: aq.current.pm10 } : null,
    };
    wCache.t = Date.now(); wCache.data = data;
    fs.writeFile(path.join(DATA, 'weather-cache.json'), JSON.stringify(data), () => {});
    return data;
  } catch (e) {
    const old = wCache.data || readJSON(path.join(DATA, 'weather-cache.json'), null);
    if (old) { if (!wCache.data) wCache.data = old; return { ...old, stale: true }; }
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
    fs.writeFile(path.join(DATA, 'prayer-cache.json'), JSON.stringify(out), () => {});
    return out;
  } catch {
    // Offline fallback: yesterday's times are only a minute or two off.
    const old = readJSON(path.join(DATA, 'prayer-cache.json'), null);
    if (old && old.timings) return { ...old, approx: true };
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

function aiContext() {
  const L = config.location;
  const lines = [`Place: ${L.name}, ${L.region} (lat ${L.lat}, lon ${L.lon}). Local date: ${todayIn(L.timezone)}.`];
  const w = wCache.data;
  if (w) {
    const c = w.current;
    lines.push(`Current weather: ${Math.round(c.temp)}°C (feels ${Math.round(c.feels)}°C), ${WMO[c.code] || 'unknown'}, humidity ${c.humidity}%, wind ${Math.round(c.wind)} km/h.`);
    lines.push('Forecast: ' + w.daily.slice(0, 5).map((d) => `${d.date}: ${Math.round(d.min)}–${Math.round(d.max)}°C, ${WMO[d.code] || ''}, rain chance ${d.pop ?? 0}%`).join(' | '));
  }
  const news = store.news.filter((n) => n.status === 'approved').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  if (news.length) lines.push('Latest local news: ' + news.map((n) => n.title).join(' | '));
  const today = todayIn(L.timezone);
  const ev = store.events.filter((e) => e.status === 'approved' && e.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5);
  if (ev.length) lines.push('Upcoming events: ' + ev.map((e) => `${e.title} (${e.date}, ${e.place})`).join(' | '));
  return lines.join('\n');
}

const SYSTEM_PROMPT = (ctx) => `You are ${config.ai.assistantName}, the friendly assistant of the community website for ${config.location.name}, a village area in ${config.location.region}.
Help local people with weather questions, travel planning, local news, events and everyday questions. Keep answers short, clear and practical. If the user writes in Urdu or Roman Urdu, answer in the same language.
Use the local data below when it is relevant. Do not invent local facts, phone numbers or road conditions you do not have; say you are not sure and suggest asking the site admin or official sources (PMD for weather warnings, Rescue 1122 for emergencies).

LOCAL DATA
${ctx}`;

async function callAI(messages) {
  const s = aiSettings();
  const ctx = aiContext();
  const ctl = AbortSignal.timeout(30000);
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
    const r = await fetch(s.webhook, {
      method: 'POST', signal: ctl, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages, context: ctx, system: SYSTEM_PROMPT(ctx) }),
    });
    const j = await r.json();
    if (!r.ok || typeof j.reply !== 'string') throw new Error('AI webhook error');
    return j.reply.trim();
  }
  throw bad('AI is not connected yet.', 503);
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const ADMIN_CSP = "default-src 'self'; script-src 'self' https://www.gstatic.com https://apis.google.com; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https://*.googleusercontent.com; connect-src 'self' https://*.googleapis.com; frame-src https://*.firebaseapp.com https://accounts.google.com https://apis.google.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SEC_HEADERS, ...headers });
  res.end(body);
}
function json(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}
function readBody(req, limit) {
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
function serveFile(req, res, file, cache, extra = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { ...SEC_HEADERS, ...extra, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
async function handleApi(req, res, url) {
  const p = url.pathname;
  const parts = p.split('/').filter(Boolean); // ['api', ...]
  const ip = ipOf(req);

  // CSRF defence for anything that changes state.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!req.headers['x-requested-with']) throw bad('Bad request.', 403);
    const origin = req.headers.origin;
    if (origin) { try { if (new URL(origin).host !== req.headers.host) throw 0; } catch { throw bad('Bad origin.', 403); } }
  }

  // ---------- public ----------
  if (req.method === 'GET' && p === '/api/config') {
    const a = aiSettings();
    return json(res, 200, {
      siteName: config.siteName, tagline: config.tagline, location: config.location, emergency: config.emergency,
      today: todayIn(config.location.timezone), alert: settings.alert && settings.alert.text ? settings.alert : null,
      ai: { connected: a.connected, name: a.name },
      noticeCats: NOTICE_CATS, dirCats: DIR_CATS,
    });
  }
  if (req.method === 'GET' && p === '/api/weather') return json(res, 200, await getWeather(), { 'Cache-Control': 'public, max-age=120' });
  if (req.method === 'GET' && p === '/api/prayer') return json(res, 200, await getPrayer(), { 'Cache-Control': 'public, max-age=600' });

  if (req.method === 'GET' && parts.length === 2 && NAMES.includes(parts[1])) {
    const name = parts[1];
    let items = store[name].filter((i) => i.status === 'approved');
    if (name === 'events') items.sort((a, b) => a.date.localeCompare(b.date));
    else items.sort((a, b) => (b.featured - a.featured) || b.createdAt.localeCompare(a.createdAt));
    if (name === 'directory') items.sort((a, b) => a.name.localeCompare(b.name));
    return json(res, 200, { items: items.map((i) => publicView(name, i)) });
  }

  if (req.method === 'POST' && parts[1] === 'submit' && NAMES.includes(parts[2])) {
    if (limited('sub:' + ip, 8, 3600e3)) throw bad('You have sent a lot of posts. Please try again later.', 429);
    const body = await readBody(req, 8 * 1024 * 1024);
    if (body.website) return json(res, 200, { ok: true }); // honeypot: bots fill this
    createItem(parts[2], body, 'pending');
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

  if (req.method === 'GET' && p === '/api/auth-config') {
    return json(res, 200, { firebase: FIREBASE_ON ? FB.config : null, passwordLogin: PASSWORD_ON });
  }

  // ---------- admin ----------
  const sessionCookie = () => {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
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
    const ok = crypto.timingSafeEqual(sha(body.password || ''), sha(ADMIN_PASSWORD));
    if (!ok) throw bad('Wrong password.', 401);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie() });
  }
  if (req.method === 'POST' && p === '/api/admin/logout') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'lam_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  if (parts[1] === 'admin') {
    if (!isAdmin(req)) throw bad('Please log in.', 401);

    if (req.method === 'GET' && p === '/api/admin/overview') {
      const out = {};
      for (const n of NAMES) out[n] = store[n].slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((i) => adminView(n, i));
      const a = aiSettings();
      return json(res, 200, { collections: out, settings, ai: { provider: a.provider, connected: a.connected, model: a.model }, noticeCats: NOTICE_CATS, dirCats: DIR_CATS });
    }
    if (req.method === 'GET' && p === '/api/admin/backup') {
      return json(res, 200, { exportedAt: new Date().toISOString(), settings, ...store }, { 'Content-Disposition': 'attachment; filename="lamnian-backup.json"' });
    }
    if (req.method === 'POST' && p === '/api/admin/settings') {
      const body = await readBody(req, 8192);
      const level = ['info', 'warning', 'danger'].includes(body.level) ? body.level : 'info';
      settings = { ...settings, alert: { text: clean(body.text, 240), level, updatedAt: new Date().toISOString() } };
      persistSettings();
      return json(res, 200, { ok: true, settings });
    }
    if (req.method === 'POST' && parts[2] === 'create' && NAMES.includes(parts[3])) {
      const body = await readBody(req, 8 * 1024 * 1024);
      const it = createItem(parts[3], body, 'approved');
      if (parts[3] === 'news' && body.featured) { it.featured = true; persist('news'); }
      return json(res, 200, { ok: true, item: adminView(parts[3], it) });
    }
    if (req.method === 'POST' && parts[2] === 'edit' && NAMES.includes(parts[3])) {
      const it = store[parts[3]].find((i) => i.id === parts[4]);
      if (!it) throw bad('Not found.', 404);
      Object.assign(it, validate(SPECS[parts[3]], await readBody(req, 64 * 1024)));
      persist(parts[3]);
      return json(res, 200, { ok: true, item: adminView(parts[3], it) });
    }
    if (req.method === 'POST' && parts[2] === 'item' && NAMES.includes(parts[3])) {
      const name = parts[3];
      const idx = store[name].findIndex((i) => i.id === parts[4]);
      if (idx < 0) throw bad('Not found.', 404);
      const it = store[name][idx];
      const action = parts[5];
      if (action === 'approve') it.status = 'approved';
      else if (action === 'reject') it.status = 'rejected';
      else if (action === 'pending') it.status = 'pending';
      else if (action === 'feature') it.featured = true;
      else if (action === 'unfeature') it.featured = false;
      else if (action === 'delete') { removeImage(it.image); store[name].splice(idx, 1); }
      else throw bad('Unknown action.');
      persist(name);
      return json(res, 200, { ok: true });
    }
  }

  throw bad('Not found.', 404);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(req, res, url); }
      catch (e) {
        const status = e.status || 500;
        if (status >= 500 && status !== 502 && status !== 503) console.error(e);
        return json(res, status, { error: status === 500 ? 'Something went wrong.' : e.message });
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });

    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' }); }

    if (pathname.startsWith('/uploads/')) {
      const f = pathname.slice(9);
      if (!/^[a-f0-9]{24}\.(jpg|png|webp)$/.test(f)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      return serveFile(req, res, path.join(UPLOADS, f), 'public, max-age=31536000, immutable');
    }
    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/admin' || pathname === '/admin/') pathname = '/admin.html';
    const file = path.normalize(path.join(PUBLIC, pathname));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
    return serveFile(req, res, file, 'no-cache', pathname === '/admin.html' && FIREBASE_ON ? { 'Content-Security-Policy': ADMIN_CSP } : {});
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, 'Server error', { 'Content-Type': 'text/plain' });
  }
});

server.listen(PORT, () => {
  const a = aiSettings();
  console.log(`Lamnian is running → http://localhost:${PORT}`);
  console.log(`Admin panel        → http://localhost:${PORT}/admin`);
  console.log(`AI assistant       → ${a.connected ? 'connected (' + a.provider + ')' : 'not connected yet'}`);
  console.log(`Admin sign-in      → ${FIREBASE_ON ? 'Google (' + ADMIN_EMAILS.join(', ') + ')' + (PASSWORD_ON ? ' + password' : '') : 'password' + (FB_PROJECT ? '  (add your email to config.json → firebase.adminEmails to enable Google sign-in)' : '')}`);
});
