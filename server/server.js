// Person 2: ingestion API for the desk device.
//   POST /api/telemetry  telemetry or button event (needs X-Device-Key header)
//   GET  /api/latest     latest reading + online/offline   ?device=g20-desk-01
//   GET  /api/history    readings + events for charts       ?device=g20-desk-01&minutes=60
//   GET  /api/reliability uptime, expected vs received, gaps  ?device=g20-desk-01&hours=72&interval=10
//   GET  /health         server check
//   GET  /               the dashboard (files in ../dashboard)
// No npm packages needed: run with `node server.js` (Node 18+).
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { analyze } = require('./reliability');

// ---------- config from server/.env (simple KEY=value lines) ----------
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
const PORT = Number(process.env.PORT || 8080);
const DEVICE_KEYS = new Set((process.env.DEVICE_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean));
const RATE_LIMIT_PER_MIN = 240;  // normal: 6/min; after an outage the device catches up at ~3/s
const MAX_BODY_BYTES = 2048;     // a telemetry message is ~250 bytes
const ONLINE_WINDOW_MS = 60 * 1000; // 6 missed 10 s messages = offline
const HEARTBEAT_MS = 60 * 1000;     // server writes "alive" to data/server.jsonl this often

if (DEVICE_KEYS.size === 0) {
  console.warn('WARNING: DEVICE_API_KEYS is empty in server/.env, so every POST will be rejected.');
}

// ---------- validation (matches the progress report's Data schema) ----------
const STATES = ['focused', 'restless', 'away'];
const EVENTS = ['session_start', 'session_stop', 'distraction', 'boot'];

function validate(msg) {
  const errors = [];
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const isInt = v => Number.isInteger(v);
  const range = (name, lo, hi, int = false) => {
    const v = msg[name];
    if (!(int ? isInt(v) : isNum(v)) || v < lo || v > hi) errors.push(`${name} must be ${int ? 'an integer' : 'a number'} from ${lo} to ${hi}`);
  };

  if (typeof msg.device !== 'string' || !/^[a-z0-9-]{1,32}$/.test(msg.device)) errors.push('device must be 1-32 lowercase letters, digits or -');
  if (typeof msg.ts !== 'string' || Number.isNaN(Date.parse(msg.ts))) errors.push('ts must be an ISO 8601 time');
  range('seq', 0, 4294967295, true);

  if ('uptime_s' in msg) range('uptime_s', 0, 4294967295, true);

  if ('event' in msg) {
    if (!EVENTS.includes(msg.event)) errors.push(`event must be one of ${EVENTS.join(', ')}`);
    if ('reason' in msg && (typeof msg.reason !== 'string' || !/^[a-z_]{1,24}$/.test(msg.reason))) errors.push('reason must be 1-24 lowercase letters or _');
    return { kind: 'event', errors };
  }
  range('light_pct', 0, 100, true);
  if (msg.temp_c !== null) range('temp_c', -40, 85);   // BMP280 range; null = sensor missing
  range('motion_rms_g', 0, 16);
  range('motion_spikes', 0, 10000, true);
  if (!STATES.includes(msg.state)) errors.push(`state must be one of ${STATES.join(', ')}`);
  range('session_s', 0, 7 * 24 * 3600, true);
  // health fields are optional but checked when present
  if ('rssi_dbm' in msg && msg.rssi_dbm !== null) range('rssi_dbm', -120, 0, true);  // null = created while offline
  if ('free_heap' in msg) range('free_heap', 0, 600000, true);
  if ('queued' in msg) range('queued', 0, 100000, true);
  if ('dropped' in msg) range('dropped', 0, 4294967295, true);
  return { kind: 'telemetry', errors };
}

// ---------- rate limit: fixed one-minute window per device key ----------
const windows = new Map(); // key -> { start, count }
function allow(key) {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now - w.start >= 60000) { windows.set(key, { start: now, count: 1 }); return true; }
  w.count++;
  return w.count <= RATE_LIMIT_PER_MIN;
}

// ---------- helpers ----------
function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*', // dashboard dev server; tighten before deploying
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- routes ----------
async function handleTelemetry(req, res) {
  const key = req.headers['x-device-key'];
  if (!key || !DEVICE_KEYS.has(key)) return send(res, 401, { ok: false, error: 'missing or unknown X-Device-Key' });
  if (!allow(key)) return send(res, 429, { ok: false, error: `rate limit: max ${RATE_LIMIT_PER_MIN} messages per minute` });

  let raw;
  try { raw = await readBody(req); } catch (e) { return send(res, e.status || 400, { ok: false, error: 'body too large' }); }

  let msg;
  try { msg = JSON.parse(raw); } catch { return send(res, 400, { ok: false, error: 'body is not valid JSON' }); }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return send(res, 400, { ok: false, error: 'body must be a JSON object' });

  const { kind, errors } = validate(msg);
  if (errors.length) return send(res, 400, { ok: false, errors });

  const isBoot = msg.event === 'boot';
  const { missed, duplicate } = db.checkSeq(msg.device, msg.seq, isBoot);
  // A duplicate is a retry whose first reply was lost: answer 200 so the device
  // stops retrying, but do not store it twice.
  if (duplicate) return send(res, 200, { ok: true, kind, seq: msg.seq, duplicate: true });
  if (isBoot) console.log(`${msg.device}: boot, reset reason ${msg.reason || 'unknown'}`);
  if (missed > 0) console.warn(`${msg.device}: ${missed} message(s) missing before seq ${msg.seq}`);

  const now = new Date();
  const delay_s = Math.max(0, Math.round((now - Date.parse(msg.ts)) / 1000));
  const row = { ...msg, received_at: now.toISOString(), delay_s };
  if (kind === 'event') db.saveEvent(row); else db.saveTelemetry(row);
  return send(res, 200, { ok: true, kind, seq: msg.seq, missed });
}

function handleLatest(res, url) {
  const device = url.searchParams.get('device') || db.devices()[0];
  const row = device && db.latest(device);
  if (!row) return send(res, 404, { ok: false, error: 'no data for that device yet' });
  const ageMs = Date.now() - Date.parse(row.ts);
  return send(res, 200, { ok: true, device, online: ageMs <= ONLINE_WINDOW_MS, age_s: Math.round(ageMs / 1000), latest: row });
}

function handleHistory(res, url) {
  const device = url.searchParams.get('device') || db.devices()[0];
  const minutes = Math.min(Math.max(Number(url.searchParams.get('minutes')) || 60, 1), 7 * 24 * 60);
  if (!device) return send(res, 404, { ok: false, error: 'no devices yet' });
  const since = Date.now() - minutes * 60000;
  return send(res, 200, { ok: true, device, minutes, telemetry: db.history(device, since), events: db.eventsSince(device, since) });
}

function handleReliability(res, url) {
  const device = url.searchParams.get('device') || db.devices()[0];
  if (!device) return send(res, 404, { ok: false, error: 'no devices yet' });
  const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 72, 1), 24 * 14);
  const intervalS = Math.min(Math.max(Number(url.searchParams.get('interval')) || 10, 1), 3600);
  const to = Date.now();
  const firstTs = Math.min(...db.allTelemetry(device).map(r => Date.parse(r.ts)).filter(Number.isFinite));
  const from = Math.max(to - hours * 3600000, Number.isFinite(firstTs) ? firstTs : to);
  const result = analyze({ telemetry: db.allTelemetry(device), events: db.allEvents(device), serverLog: db.serverLog(), device, from, to, intervalS });
  return send(res, 200, { ok: true, ...result });
}

// ---------- dashboard files (dashboard/ folder), served at / ----------
const DASHBOARD_DIR = path.join(__dirname, '..', 'dashboard');
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
function serveStatic(res, file) {
  fs.readFile(path.join(DASHBOARD_DIR, file), (err, data) => {
    if (err) return send(res, 404, { ok: false, error: 'dashboard file missing' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) return serveStatic(res, STATIC[url.pathname]);
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Device-Key' }); return res.end(); }
    if (req.method === 'POST' && url.pathname === '/api/telemetry') return await handleTelemetry(req, res);
    if (req.method === 'GET' && url.pathname === '/api/latest') return handleLatest(res, url);
    if (req.method === 'GET' && url.pathname === '/api/history') return handleHistory(res, url);
    if (req.method === 'GET' && url.pathname === '/api/reliability') return handleReliability(res, url);
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, uptime_s: Math.round(process.uptime()) });
    return send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { ok: false, error: 'server error' });
  }
});

db.init();
server.listen(PORT, () => {
  console.log(`desk-focus server listening on http://localhost:${PORT}  (dashboard at /)`);
  db.logServer('start', { pid: process.pid, port: PORT });
});

// Heartbeat: lets the reliability report tell "server down" apart from "device down".
setInterval(() => db.logServer('alive'), HEARTBEAT_MS).unref();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { db.logServer('stop', { signal: sig }); process.exit(0); });
}
