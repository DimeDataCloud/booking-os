// index.js — zero-dependency HTTP server: static files, signed-cookie sessions, JSON API, SSE.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db, seed, checkPw, logEvent } from './db.js';
import { routes, HttpError, csvVenues } from './api.js';
import { runAutomations } from './automation.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PORT = parseInt(process.env.PORT || '3007', 10);
const SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const COOKIE = 'djsid';

seed();

// ─── sessions (signed cookie, no store) ────────────────────────────────────────
function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return data + '.' + createHmac('sha256', SECRET).update(data).digest('base64url');
}
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expect = createHmac('sha256', SECRET).update(data).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (p.exp && p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
  const i = c.indexOf('='); return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
}).filter(p => p[0]));

// ─── SSE clients ───────────────────────────────────────────────────────────────
const sseClients = new Set();
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch { sseClients.delete(res); } }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

async function serveStatic(res, urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  let file = join(PUBLIC, rel);
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = join(file, 'index.html');
  } catch { return false; }
  try {
    const buf = await readFile(file);
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    const cache = /\.(js|css|png|svg|jpg)$/.test(file) ? 'public, max-age=300' : 'no-cache';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
    res.end(buf);
    return true;
  } catch { return false; }
}

function matchRoute(method, path) {
  const exact = routes[`${method} ${path}`];
  if (exact) return { handler: exact, params: {} };
  const segs = path.split('/');
  for (const key of Object.keys(routes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method || !pattern.includes(':')) continue;
    const pSegs = pattern.split('/');
    if (pSegs.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pSegs.length; i++) {
      if (pSegs[i].startsWith(':')) params[pSegs[i].slice(1)] = decodeURIComponent(segs[i]);
      else if (pSegs[i] !== segs[i]) { ok = false; break; }
    }
    if (ok) return { handler: routes[key], params };
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 4e6) { reject(new HttpError(413, 'body too large')); req.destroy(); } chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const query = Object.fromEntries(url.searchParams);

  try {
    if (path === '/health') return json(res, 200, { ok: true, venues: db.prepare('SELECT COUNT(*) c FROM venues').get().c, ts: new Date().toISOString() });

    // ── auth ──
    if (path === '/api/login' && req.method === 'POST') {
      const body = await readBody(req) || {};
      const u = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(String(body.email || '').trim());
      if (!u || !checkPw(String(body.password || ''), u.pw)) return json(res, 401, { error: 'Wrong email or password' });
      const token = sign({ id: u.id, email: u.email, name: u.name, role: u.role, exp: Date.now() + 30 * 86400000 });
      res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${process.env.INSECURE_COOKIE ? '' : '; Secure'}`);
      logEvent('auth', `${u.name} signed in`);
      return json(res, 200, { user: { id: u.id, email: u.email, name: u.name, role: u.role } });
    }
    if (path === '/api/logout') {
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
      return json(res, 200, { ok: true });
    }

    const session = verify(cookies(req)[COOKIE]);

    if (path === '/api/me') {
      if (!session) return json(res, 401, { error: 'not signed in' });
      return json(res, 200, { user: session });
    }

    // ── API ──
    if (path.startsWith('/api/')) {
      if (!session) return json(res, 401, { error: 'not signed in' });

      if (path === '/api/events') {                       // SSE — live feed
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 5000\n\n');
        sseClients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
        req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
        return;
      }
      if (path === '/api/export/venues.csv') {
        const csv = csvVenues(query);
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="venues.csv"' });
        return res.end(csv);
      }

      const match = matchRoute(req.method, path);
      if (!match) return json(res, 404, { error: 'no such endpoint' });
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : null;
      const out = await match.handler({ params: match.params, query, body, user: session, req });
      if (req.method !== 'GET') broadcast('changed', { path, method: req.method, at: new Date().toISOString() });
      return json(res, 200, out ?? { ok: true });
    }

    // ── static / SPA ──
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    if (path === '/' || path === '/index.html') {
      if (!session) { res.writeHead(302, { Location: '/login.html' }); return res.end(); }
    }
    if (await serveStatic(res, path === '/' ? '/index.html' : path)) return;
    // Unknown path inside the app shell → let the client router handle it.
    if (!path.includes('.') && session && await serveStatic(res, '/index.html')) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message });
    console.error('500', req.method, path, e);
    return json(res, 500, { error: e.message || 'server error' });
  }
});

// The workflow engine ticks on its own — automations that only run when someone
// opens the app are not automations.
const TICK = parseInt(process.env.AUTOMATION_INTERVAL_MIN || '15', 10) * 60000;
setTimeout(() => {
  const tick = () => {
    try {
      const r = runAutomations();
      if (r.created) broadcast('automation', r);
    } catch (e) { console.error('automation tick', e.message); }
  };
  tick();
  setInterval(tick, TICK);
}, 10000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Booking OS on :${PORT}  ·  ${db.prepare('SELECT COUNT(*) c FROM venues').get().c} venues loaded`);
});
