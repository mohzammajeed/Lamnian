'use strict';
/**
 * Local development server:  node server.js  →  http://localhost:3000
 * (On Vercel this file is not used: static files come from /public and the API from /api.)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle, SEC_HEADERS, ADMIN_CSP, FIREBASE_ON, PASSWORD_ON, ADMIN_EMAILS, db } = require('./lib/app');

const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };

function serve(req, res, file, extra) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { ...SEC_HEADERS, ...extra, 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handle(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let p; try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (p === '/') p = '/index.html';
  if (p === '/admin' || p === '/admin/') p = '/admin.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  serve(req, res, file, p === '/admin.html' && FIREBASE_ON ? { 'Content-Security-Policy': ADMIN_CSP } : {});
}).listen(PORT, () => {
  console.log(`Lamnian (local) → http://localhost:${PORT}   admin → http://localhost:${PORT}/admin`);
  console.log(`Database        → ${db() ? db().kind === 'file' ? 'local file (data/db.json)' : 'Firebase Realtime Database' : 'NOT CONNECTED'}`);
  console.log(`Admin sign-in   → ${FIREBASE_ON ? 'Google (' + ADMIN_EMAILS.join(', ') + ')' : 'password'}${PASSWORD_ON && FIREBASE_ON ? ' + password' : ''}`);
});
