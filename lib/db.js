'use strict';
/**
 * Tiny database layer with two interchangeable backends:
 *  - Firebase Realtime Database over its REST API (used on Vercel). Logs in with a
 *    service account, so Realtime Database security rules can stay "deny all".
 *  - A local JSON file (only for running on your own computer).
 * API: get(path) · set(path, value) · patch(path, obj) · del(path)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Reads the service account from env: FIREBASE_SERVICE_ACCOUNT (JSON) or CLIENT_EMAIL + PRIVATE_KEY. */
function loadServiceAccount() {
  let sa = null;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    try { sa = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')); }
    catch { console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.'); }
  } else if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    sa = { client_email: process.env.FIREBASE_CLIENT_EMAIL, private_key: process.env.FIREBASE_PRIVATE_KEY };
  }
  if (!sa || !sa.client_email || !sa.private_key) return null;
  return { client_email: sa.client_email, private_key: String(sa.private_key).replace(/\\n/g, '\n') };
}

function createRtdb(baseUrl, sa) {
  const base = baseUrl.replace(/\/+$/, '');
  let tok = { v: null, exp: 0 };

  async function token() {
    if (tok.v && Date.now() < tok.exp - 60e3) return tok.v;
    const now = Math.floor(Date.now() / 1000);
    const head = b64u({ alg: 'RS256', typ: 'JWT' });
    const claims = b64u({
      iss: sa.client_email, aud: TOKEN_URL, iat: now, exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(head + '.' + claims), sa.private_key).toString('base64url');
    const r = await fetch(TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000),
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claims + '.' + sig }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error('Google service-account login failed: ' + (j.error_description || j.error || r.status));
    tok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return tok.v;
  }

  async function call(method, p, body) {
    const t = await token();
    const url = `${base}/${p}.json?access_token=${encodeURIComponent(t)}${method === 'GET' ? '' : '&print=silent'}`;
    const r = await fetch(url, {
      method, signal: AbortSignal.timeout(15000),
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      if (r.status === 401) tok = { v: null, exp: 0 };
      throw new Error(`Database ${method} /${p} failed (${r.status}) ${txt.slice(0, 140)}`);
    }
    return method === 'GET' ? r.json() : null;
  }

  return {
    kind: 'firebase',
    get: (p) => call('GET', p),
    set: (p, v) => call('PUT', p, v),
    patch: (p, v) => call('PATCH', p, v),
    del: (p) => call('DELETE', p),
  };
}

function createFileDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let tree = {};
  try { tree = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new database */ }
  const parts = (p) => String(p).split('/').filter(Boolean);
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(tree)); fs.renameSync(file + '.tmp', file); };
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  function walk(p, create) {
    let node = tree;
    for (const k of parts(p)) {
      if (node == null || typeof node !== 'object') return undefined;
      if (node[k] == null || typeof node[k] !== 'object') { if (!create) return node[k]; node[k] = {}; }
      node = node[k];
    }
    return node;
  }
  return {
    kind: 'file',
    async get(p) { const ks = parts(p); if (!ks.length) return clone(tree); const parent = walk(ks.slice(0, -1).join('/'), false); return parent && typeof parent === 'object' ? clone(parent[ks[ks.length - 1]]) : null; },
    async set(p, v) {
      const ks = parts(p), parent = walk(ks.slice(0, -1).join('/'), true), k = ks[ks.length - 1];
      if (v === null || v === undefined) delete parent[k]; else parent[k] = clone(v);
      save();
    },
    async patch(p, obj) {
      const node = walk(p, true);
      for (const [k, v] of Object.entries(obj)) { if (v === null) delete node[k]; else node[k] = clone(v); }
      save();
    },
    async del(p) { return this.set(p, null); },
  };
}

module.exports = { createRtdb, createFileDb, loadServiceAccount };
