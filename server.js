'use strict';
const path = require('node:path');
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env yet: defaults apply */ }

const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { db, UPLOAD_DIR } = require('./lib/db');
const auth = require('./lib/auth');
const notify = require('./lib/notify');
const rem = require('./lib/reminders');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SECRET = auth.getSecret();

// ---------------------------------------------------------------- helpers
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (m) => new HttpError(400, m);

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(req, limit = 12 * 1024 * 1024) {
  const chunks = []; let size = 0, tooBig = false;
  for await (const c of req) { size += c.length; if (size > limit) tooBig = true; else chunks.push(c); }
  if (tooBig) throw new HttpError(413, 'File or request is too large.');
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw bad('Invalid JSON body.'); }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function normMobile(s) {
  let d = String(s || '').replace(/[\s\-().]/g, '');
  if (d.startsWith('+63')) d = '0' + d.slice(3);
  else if (/^63\d{10}$/.test(d)) d = '0' + d.slice(2);
  else if (/^9\d{9}$/.test(d)) d = '0' + d;
  return /^09\d{9}$/.test(d) ? d : null;
}
function normPlate(s) {
  const p = String(s || '').toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9-]{4,10}$/.test(p) && /\d/.test(p) ? p : null;
}
function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

// Simple in-memory rate limiter for login/register.
const hits = new Map();
function rateLimit(req, max = 15, windowMs = 10 * 60 * 1000) {
  const ip = req.socket.remoteAddress || 'x', now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(ip, arr);
  if (arr.length > max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes.');
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, mobile: u.mobile, role: u.role });

function serializeVehicle(row, docs = []) {
  const d = rem.daysUntil(row.insurance_expiry);
  return {
    id: row.id, owner_name: row.owner_name, owner_mobile: row.owner_mobile || '', owner_email: row.owner_email || '',
    plate_number: row.plate_number, insurance_expiry: row.insurance_expiry,
    notify_sms: !!row.notify_sms, notify_email: !!row.notify_email,
    days_left: d, status: rem.statusOf(d), lto_month: rem.ltoMonth(row.plate_number), docs
  };
}

function parseVehicleBody(b) {
  const owner_name = String(b.owner_name || '').trim().slice(0, 100);
  if (!owner_name) throw bad('Owner name is required.');
  const plate = normPlate(b.plate_number);
  if (!plate) throw bad('Enter a valid plate number (letters and numbers, e.g. ABC1234).');
  if (!validDate(String(b.insurance_expiry || ''))) throw bad('Enter a valid insurance expiry date.');
  const mobileRaw = String(b.owner_mobile || '').trim();
  const mobile = mobileRaw ? normMobile(mobileRaw) : '';
  if (mobileRaw && !mobile) throw bad('Mobile number must be a Philippine number like 09171234567.');
  const emailRaw = String(b.owner_email || '').trim().toLowerCase();
  if (emailRaw && !EMAIL_RE.test(emailRaw)) throw bad('Enter a valid email address.');
  if (!mobile && !emailRaw) throw bad('Provide a mobile number or an email so reminders can be delivered.');
  return {
    owner_name, plate_number: plate, insurance_expiry: b.insurance_expiry,
    owner_mobile: mobile || null, owner_email: emailRaw || null,
    notify_sms: b.notify_sms === false ? 0 : 1, notify_email: b.notify_email === false ? 0 : 1
  };
}

function ownedVehicle(id, user) {
  const v = db.prepare('SELECT * FROM vehicles WHERE id = ? AND user_id = ?').get(Number(id), user.id);
  if (!v) throw new HttpError(404, 'Vehicle not found.');
  return v;
}

// ---------------------------------------------------------------- files (document vault)
const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' };
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  return null;
}

// ---------------------------------------------------------------- routes
const routes = [];
function add(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, opts, handler });
}

add('GET', '/api/health', { auth: false }, () => ({ ok: true }));

add('GET', '/api/config', { auth: false }, () => ({
  ...notify.providerStatus(),
  reminderDays: [...rem.REMINDER_DAYS].reverse(),
  sendWindow: [rem.WIN_START, rem.WIN_END],
  agentCodeRequired: !!process.env.AGENT_SIGNUP_CODE
}));

add('POST', '/api/auth/register', { auth: false }, async ({ req }) => {
  rateLimit(req);
  const b = await readJson(req);
  const name = String(b.name || '').trim().slice(0, 100);
  const email = String(b.email || '').trim().toLowerCase();
  const role = b.role === 'agent' ? 'agent' : 'owner';
  const mobileRaw = String(b.mobile || '').trim();
  const mobile = mobileRaw ? normMobile(mobileRaw) : null;
  if (!name) throw bad('Name is required.');
  if (!EMAIL_RE.test(email)) throw bad('Enter a valid email address.');
  if (String(b.password || '').length < 8) throw bad('Password must be at least 8 characters.');
  if (mobileRaw && !mobile) throw bad('Mobile number must be a Philippine number like 09171234567.');
  if (role === 'owner' && !mobile) throw bad('A mobile number is required so we can text you.');
  if (role === 'agent' && process.env.AGENT_SIGNUP_CODE && b.agentCode !== process.env.AGENT_SIGNUP_CODE)
    throw new HttpError(403, 'Invalid agent signup code.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'That email is already registered.');
  const info = db.prepare('INSERT INTO users (name, email, mobile, role, password_hash) VALUES (?,?,?,?,?)')
    .run(name, email, mobile, role, auth.hashPassword(b.password));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
  return { token: auth.signToken({ sub: user.id }, SECRET), user: publicUser(user) };
});

add('POST', '/api/auth/login', { auth: false }, async ({ req }) => {
  rateLimit(req);
  const b = await readJson(req);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(b.email || '').trim().toLowerCase());
  if (!user || !auth.verifyPassword(String(b.password || ''), user.password_hash)) throw new HttpError(401, 'Incorrect email or password.');
  return { token: auth.signToken({ sub: user.id }, SECRET), user: publicUser(user) };
});

add('GET', '/api/me', ({ user }) => ({ user: publicUser(user) }));

// ----- vehicles
add('GET', '/api/vehicles', ({ user }) => {
  const rows = db.prepare('SELECT * FROM vehicles WHERE user_id = ? ORDER BY insurance_expiry ASC, id ASC').all(user.id);
  const docs = db.prepare(`SELECT id, vehicle_id, kind, filename, mime, size FROM documents
                           WHERE vehicle_id IN (SELECT id FROM vehicles WHERE user_id = ?) ORDER BY id`).all(user.id);
  const byVehicle = {};
  for (const d of docs) (byVehicle[d.vehicle_id] ||= []).push({ id: d.id, kind: d.kind, filename: d.filename, mime: d.mime, size: d.size });
  return { vehicles: rows.map((r) => serializeVehicle(r, byVehicle[r.id] || [])) };
});

add('POST', '/api/vehicles', async ({ req, user }) => {
  const v = parseVehicleBody(await readJson(req));
  const info = db.prepare(`INSERT INTO vehicles (user_id, owner_name, owner_mobile, owner_email, plate_number, insurance_expiry, notify_sms, notify_email)
                           VALUES (?,?,?,?,?,?,?,?)`)
    .run(user.id, v.owner_name, v.owner_mobile, v.owner_email, v.plate_number, v.insurance_expiry, v.notify_sms, v.notify_email);
  return { vehicle: serializeVehicle(db.prepare('SELECT * FROM vehicles WHERE id = ?').get(Number(info.lastInsertRowid))) };
});

add('PUT', '/api/vehicles/:id', async ({ req, user, params }) => {
  const existing = ownedVehicle(params.id, user);
  const v = parseVehicleBody(await readJson(req));
  db.prepare(`UPDATE vehicles SET owner_name=?, owner_mobile=?, owner_email=?, plate_number=?, insurance_expiry=?,
              notify_sms=?, notify_email=?, updated_at=datetime('now') WHERE id=?`)
    .run(v.owner_name, v.owner_mobile, v.owner_email, v.plate_number, v.insurance_expiry, v.notify_sms, v.notify_email, existing.id);
  return { vehicle: serializeVehicle(db.prepare('SELECT * FROM vehicles WHERE id = ?').get(existing.id)) };
});

add('DELETE', '/api/vehicles/:id', ({ user, params }) => {
  const v = ownedVehicle(params.id, user);
  const files = db.prepare('SELECT stored_name FROM documents WHERE vehicle_id = ?').all(v.id);
  db.prepare('DELETE FROM vehicles WHERE id = ?').run(v.id);
  for (const f of files) fs.rm(path.join(UPLOAD_DIR, f.stored_name), { force: true }, () => {});
  return { ok: true };
});

add('POST', '/api/vehicles/:id/remind', async ({ user, params }) => {
  const v = ownedVehicle(params.id, user);
  return { results: await rem.remindVehicle(v, { trigger: 'manual' }) };
});

// ----- documents (vault)
add('POST', '/api/vehicles/:id/documents', async ({ req, user, params }) => {
  const v = ownedVehicle(params.id, user);
  const b = await readJson(req);
  const kind = ['COC', 'ORCR', 'OTHER'].includes(b.kind) ? b.kind : 'OTHER';
  const dataUrl = String(b.dataUrl || '');
  const comma = dataUrl.indexOf(',');
  const m = /^data:([^;]+);base64$/.exec(dataUrl.slice(0, comma));
  if (!m || !MIME_EXT[m[1]]) throw bad('Upload a JPG, PNG, WEBP, GIF or PDF file.');
  const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  if (buf.length > 6 * 1024 * 1024) throw new HttpError(413, 'File is larger than 6 MB.');
  if (sniff(buf) !== m[1]) throw bad('The file contents do not match its type.');
  if (db.prepare('SELECT COUNT(*) AS n FROM documents WHERE vehicle_id = ?').get(v.id).n >= 12) throw bad('Document limit reached for this vehicle (12).');
  const stored = crypto.randomBytes(16).toString('hex') + MIME_EXT[m[1]];
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
  const filename = String(b.filename || 'document').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  const info = db.prepare('INSERT INTO documents (vehicle_id, kind, filename, mime, stored_name, size) VALUES (?,?,?,?,?,?)')
    .run(v.id, kind, filename, m[1], stored, buf.length);
  return { document: { id: Number(info.lastInsertRowid), kind, filename, mime: m[1], size: buf.length } };
});

function ownedDocument(id, user) {
  const d = db.prepare(`SELECT d.* FROM documents d JOIN vehicles v ON v.id = d.vehicle_id WHERE d.id = ? AND v.user_id = ?`).get(Number(id), user.id);
  if (!d) throw new HttpError(404, 'Document not found.');
  return d;
}
add('GET', '/api/documents/:id/file', ({ res, user, params }) => {
  const d = ownedDocument(params.id, user);
  const file = path.join(UPLOAD_DIR, d.stored_name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'File is missing on the server.');
  res.writeHead(200, {
    'Content-Type': d.mime, 'Content-Length': d.size, 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${d.filename.replace(/"/g, '')}"`, 'Cache-Control': 'private, max-age=3600'
  });
  fs.createReadStream(file).pipe(res);
});
add('DELETE', '/api/documents/:id', ({ user, params }) => {
  const d = ownedDocument(params.id, user);
  db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
  fs.rm(path.join(UPLOAD_DIR, d.stored_name), { force: true }, () => {});
  return { ok: true };
});

// ----- notifications + reminder triggers
add('GET', '/api/notifications', ({ user }) => ({
  notifications: db.prepare('SELECT id, vehicle_id, plate_number, owner_name, channel, recipient, subject, message, days_left, trigger_type, status, error, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(user.id)
}));
add('DELETE', '/api/notifications', ({ user }) => { db.prepare('DELETE FROM notifications WHERE user_id = ?').run(user.id); return { ok: true }; });

add('POST', '/api/reminders/run', async ({ user }) =>
  ({ summary: await rem.scan(db.prepare('SELECT * FROM vehicles WHERE user_id = ?').all(user.id), { trigger: 'auto' }) }));

add('POST', '/api/reminders/bulk', { role: 'agent' }, async ({ user }) =>
  ({ summary: await rem.scan(db.prepare('SELECT * FROM vehicles WHERE user_id = ?').all(user.id), { trigger: 'bulk' }) }));

// ---------------------------------------------------------------- static files
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- server
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
            "img-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src blob:; object-src 'none'; base-uri 'self'";

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    }
    const route = routes.map((r) => ({ r, m: r.re.exec(url.pathname) })).find((x) => x.m && x.r.method === req.method);
    if (!route) throw new HttpError(404, 'Unknown API endpoint.');
    const params = {}; route.r.keys.forEach((k, i) => { params[k] = decodeURIComponent(route.m[i + 1]); });

    let user = null;
    if (route.r.opts.auth !== false) {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const payload = m && auth.verifyToken(m[1], SECRET);
      user = payload && db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
      if (!user) throw new HttpError(401, 'Please sign in.');
      if (route.r.opts.role && user.role !== route.r.opts.role) throw new HttpError(403, 'This action is for CTPL agents only.');
    }
    const result = await route.r.handler({ req, res, params, user });
    if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'Something went wrong on the server.' });
  }
});

server.listen(PORT, () => {
  const s = notify.providerStatus();
  console.log(`\n  InsuraTrack running at http://localhost:${PORT}`);
  console.log(`  Email: ${s.email.provider}${s.email.live ? '' : ' (simulated)'}   SMS: ${s.sms.provider}${s.sms.live ? '' : ' (simulated)'}`);
  console.log(`  Reminders at ${[...rem.REMINDER_DAYS].reverse().join('/')} days before expiry, sent ${rem.WIN_START}:00-${rem.WIN_END}:00 Manila time\n`);
  rem.startScheduler();
});
