'use strict';
// ONE server file for everything that cannot run in the browser: weather, prayer times, AI chat.
// (Posts, photos and the admin panel do not use it: they go straight to Firebase, see db.js.)
//   GET  /api/weather   GET /api/prayer   GET /api/ai   POST /api/ai
// AI is switched on from Vercel environment variables:
//   LAMNIAN_AI_PROVIDER = anthropic | openai | webhook
//   LAMNIAN_AI_KEY      = your API key           (anthropic / openai)
//   LAMNIAN_AI_MODEL    = optional model name
//   LAMNIAN_AI_WEBHOOK  = https://your-server/chat   (webhook)
//   LAMNIAN_AI_BASE_URL = optional, for OpenAI-compatible servers

/* ---------- helpers ---------- */
const config = require('../config.json');
// Small helpers shared by the three API files (weather, prayer, ai).
// Everything the website saves (posts, photos, banner) goes straight from the
// browser to Firestore — see public/db.js. This server part only talks to
// outside services (weather, prayer times, AI) that must not run in the browser.

const loc = config.location;

function send(res, status, obj, cache) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cache || 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function fail(res, e) {
  const status = e.status || 500;
  if (!e.status) console.error(e);
  send(res, status, { error: e.status ? e.message : 'Something went wrong.' });
}

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

async function getJSON(url, ms = 9000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'LamnianSite/1.0' } });
  if (!r.ok) throw new Error('Upstream ' + r.status);
  return r.json();
}

function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// Per-instance, best-effort limiter (used for the AI chat only).
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}
function ipOf(req) {
  const x = req.headers['x-forwarded-for'];
  return (x ? String(x).split(',')[0].trim() : req.socket && req.socket.remoteAddress) || '?';
}


/* ---------- weather ---------- */

let wxCache = { t: 0, data: null };

async function getWeather() {
  if (wxCache.data && Date.now() - wxCache.t < 10 * 60e3) return wxCache.data;
  const { lat, lon } = loc;
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
    wxCache = { t: Date.now(), data };
    return data;
  } catch (e) {
    console.error('Weather fetch failed:', e.message);
    if (wxCache.data) return { ...wxCache.data, stale: true };
    throw bad('Weather service is not reachable right now.', 502);
  }
}


/* ---------- prayer times ---------- */

const prayerCache = new Map();

async function getPrayer() {
  const today = todayIn(loc.timezone);
  if (prayerCache.has(today)) return prayerCache.get(today);
  const [y, m, d] = today.split('-');
  const url = `https://api.aladhan.com/v1/timings/${d}-${m}-${y}?latitude=${loc.lat}&longitude=${loc.lon}&method=${config.prayer.method}&school=${config.prayer.school}&timezonestring=${encodeURIComponent(loc.timezone)}`;
  try {
    const j = await getJSON(url);
    const t = j.data.timings, h = j.data.date && j.data.date.hijri;
    const out = {
      date: today,
      timings: { Fajr: t.Fajr, Sunrise: t.Sunrise, Dhuhr: t.Dhuhr, Asr: t.Asr, Maghrib: t.Maghrib, Isha: t.Isha },
      hijri: h ? `${h.day} ${h.month.en} ${h.year}` : '',
    };
    prayerCache.clear(); prayerCache.set(today, out);
    return out;
  } catch (e) {
    console.error('Prayer fetch failed:', e.message);
    throw bad('Prayer times are not reachable right now.', 502);
  }
}


/* ---------- AI chat ---------- */
// AI chat. Switched on from Vercel environment variables only (see README):
//   LAMNIAN_AI_PROVIDER = anthropic | openai | webhook
//   LAMNIAN_AI_KEY      = your API key           (anthropic / openai)
//   LAMNIAN_AI_MODEL    = optional model name
//   LAMNIAN_AI_WEBHOOK  = https://your-server/chat   (webhook)
//   LAMNIAN_AI_BASE_URL = optional, for OpenAI-compatible servers
// GET  /api/ai  → { connected, name }
// POST /api/ai  → { reply }   body: { messages: [{role, content}], facts: ["news headline", ...] }

const E = process.env;
const NAME = (config.ai && config.ai.assistantName) || 'Lamnian AI';
const settings = () => {
  const provider = String(E.LAMNIAN_AI_PROVIDER || 'none').toLowerCase();
  const key = E.LAMNIAN_AI_KEY || '', webhook = E.LAMNIAN_AI_WEBHOOK || '';
  const connected = provider === 'webhook' ? !!webhook : (provider === 'anthropic' || provider === 'openai') && !!key;
  return { provider, key, webhook, connected, model: E.LAMNIAN_AI_MODEL || (provider === 'openai' ? 'gpt-4o-mini' : 'claude-sonnet-5-5'), baseUrl: E.LAMNIAN_AI_BASE_URL || '' };
};

const WMO = { 0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers',
  85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail' };

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

async function context(facts) {
  const lines = [`Place: ${loc.name}, ${loc.region} (lat ${loc.lat}, lon ${loc.lon}). Local date: ${todayIn(loc.timezone)}.`];
  try {
    const w = await getWeather(), c = w.current;
    lines.push(`Current weather: ${Math.round(c.temp)}°C (feels ${Math.round(c.feels)}°C), ${WMO[c.code] || 'unknown'}, humidity ${c.humidity}%, wind ${Math.round(c.wind)} km/h.`);
    lines.push('Forecast: ' + w.daily.slice(0, 5).map((d) => `${d.date}: ${Math.round(d.min)}–${Math.round(d.max)}°C, ${WMO[d.code] || ''}, rain chance ${d.pop ?? 0}%`).join(' | '));
  } catch { /* weather is optional */ }
  // News headlines and events come from the page itself (it already loaded them from Firestore).
  if (facts.length) lines.push('Local news and events: ' + facts.join(' | '));
  return lines.join('\n');
}

const prompt = (ctx) => `You are ${NAME}, the friendly assistant of the community website for ${loc.name}, a village area in ${loc.region}.
Help local people with weather questions, travel planning, local news, events and everyday questions. Keep answers short, clear and practical. If the user writes in Urdu or Roman Urdu, answer in the same language.
Use the local data below when it is relevant. Do not invent local facts, phone numbers or road conditions you do not have; say you are not sure and suggest asking the site admin or official sources (PMD for weather warnings, Rescue 1122 for emergencies).

LOCAL DATA
${ctx}`;

async function ask(s, messages, ctx) {
  const signal = AbortSignal.timeout(28000);
  if (s.provider === 'anthropic') {
    const r = await fetch((s.baseUrl || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': s.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: s.model, max_tokens: 700, system: prompt(ctx), messages }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || 'AI error');
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  }
  if (s.provider === 'openai') {
    const r = await fetch((s.baseUrl || 'https://api.openai.com/v1') + '/chat/completions', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.key },
      body: JSON.stringify({ model: s.model, max_tokens: 700, messages: [{ role: 'system', content: prompt(ctx) }, ...messages] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || 'AI error');
    return String(j.choices[0].message.content || '').trim();
  }
  const r = await fetch(s.webhook, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages, context: ctx, system: prompt(ctx) }) });
  const j = await r.json();
  if (!r.ok || typeof j.reply !== 'string') throw new Error('AI webhook error');
  return j.reply.trim();
}


async function aiHandler(req, res) {
  try {
    const s = settings();
    if (req.method === 'GET') return send(res, 200, { connected: s.connected, name: NAME, provider: s.provider, model: s.model });
    if (req.method !== 'POST') throw bad('Not found.', 404);
    if (!s.connected) throw bad('The AI assistant is not connected yet.', 503);
    if (limited('ai:' + ipOf(req), 20, 3600e3)) throw bad('Please wait a little before asking more questions.', 429);

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-10)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: clean(m.content, 1000) })).filter((m) => m.content);
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw bad('Please type a question.');
    const facts = (Array.isArray(body.facts) ? body.facts : []).slice(0, 12).map((f) => clean(f, 160)).filter(Boolean);

    try { return send(res, 200, { reply: await ask(s, msgs, await context(facts)) }); }
    catch (e) { console.error('AI error:', e.message); throw bad('The assistant could not answer right now. Please try again.', 502); }
  } catch (e) { fail(res, e); }
}

/* ---------- router ---------- */
module.exports = async (req, res) => {
  const name = (req.query && req.query.action) || new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).pop();
  try {
    if (name === 'weather') return send(res, 200, await getWeather(), 'public, max-age=0, s-maxage=600, stale-while-revalidate=1800');
    if (name === 'prayer') return send(res, 200, await getPrayer(), 'public, max-age=0, s-maxage=3600, stale-while-revalidate=3600');
    if (name === 'ai') return await aiHandler(req, res);
    throw bad('Not found.', 404);
  } catch (e) { fail(res, e); }
};
