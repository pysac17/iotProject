// Person 2: storage for telemetry and button events.
// For now: append-only JSON Lines files in server/data/ plus an in-memory index.
// Swap for a real database later without changing server.js (same functions).
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TELEMETRY_FILE = path.join(DATA_DIR, 'telemetry.jsonl');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const MAX_IN_MEMORY = 20000; // ~1 week of 30 s readings per device

const telemetry = new Map(); // device -> array of rows (oldest first)
const events = new Map();    // device -> array of rows (oldest first)
const lastSeq = new Map();   // device -> last sequence number seen

function push(map, row) {
  if (!map.has(row.device)) map.set(row.device, []);
  const list = map.get(row.device);
  list.push(row);
  if (list.length > MAX_IN_MEMORY) list.shift();
}

function loadFile(file, map) {
  if (!fs.existsSync(file)) return 0;
  let n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      push(map, row);
      lastSeq.set(row.device, Math.max(lastSeq.get(row.device) ?? -1, row.seq));
      n++;
    } catch { /* skip a damaged line */ }
  }
  return n;
}

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const t = loadFile(TELEMETRY_FILE, telemetry);
  const e = loadFile(EVENTS_FILE, events);
  console.log(`db: loaded ${t} telemetry rows and ${e} events from ${DATA_DIR}`);
}

// Returns how many messages were missed before this one (0 = no gap).
function checkSeq(device, seq) {
  const prev = lastSeq.get(device);
  lastSeq.set(device, Math.max(prev ?? -1, seq));
  if (prev === undefined || seq <= prev) return 0; // first message, or device rebooted
  return seq - prev - 1;
}

function saveTelemetry(row) {
  fs.appendFileSync(TELEMETRY_FILE, JSON.stringify(row) + '\n');
  push(telemetry, row);
}

function saveEvent(row) {
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(row) + '\n');
  push(events, row);
}

function latest(device) {
  const list = telemetry.get(device);
  return list && list.length ? list[list.length - 1] : null;
}

function history(device, sinceMs) {
  return (telemetry.get(device) || []).filter(r => Date.parse(r.received_at) >= sinceMs);
}

function eventsSince(device, sinceMs) {
  return (events.get(device) || []).filter(r => Date.parse(r.received_at) >= sinceMs);
}

function devices() {
  return [...telemetry.keys()];
}

module.exports = { init, checkSeq, saveTelemetry, saveEvent, latest, history, eventsSince, devices };
