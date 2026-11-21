// Person 2: storage for telemetry, button events and the server's own log.
// Append-only JSON Lines files in server/data/ plus an in-memory index.
// Swap for a real database later without changing server.js (same functions).
//
//   data/telemetry.jsonl  one line per reading   (never edited or deleted)
//   data/events.jsonl     one line per event      (boot, session_start, ...)
//   data/server.jsonl     server start / alive / stop lines, to explain server downtime
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TELEMETRY_FILE = path.join(DATA_DIR, 'telemetry.jsonl');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const SERVER_FILE = path.join(DATA_DIR, 'server.jsonl');
const MAX_IN_MEMORY = 50000; // ~5.8 days of 10 s readings per device

const telemetry = new Map(); // device -> rows, in arrival order
const events = new Map();    // device -> rows, in arrival order

// Sequence tracking per device, reset at every boot (the device restarts seq at 1).
//   last: highest seq seen since the last boot
//   seen: seqs seen since the last boot, to drop duplicates (a retry after a lost reply)
const seqState = new Map();  // device -> { last, seen:Set }

function push(map, row) {
  if (!map.has(row.device)) map.set(row.device, []);
  const list = map.get(row.device);
  list.push(row);
  if (list.length > MAX_IN_MEMORY) list.shift();
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip a damaged line (e.g. power cut mid-write) */ }
  }
  return rows;
}

// Records a message's seq. Returns { missed, duplicate }.
//   missed    = messages skipped since the previous one in this boot (a gap)
//   duplicate = this exact message was already stored (do not store it again)
function checkSeq(device, seq, isBoot = false) {
  let st = seqState.get(device);
  if (!st || isBoot) {
    st = { last: seq, seen: new Set([seq]) };
    seqState.set(device, st);
    return { missed: 0, duplicate: false };
  }
  if (st.seen.has(seq)) return { missed: 0, duplicate: true };
  st.seen.add(seq);
  if (st.seen.size > 20000) st.seen = new Set([...st.seen].slice(-10000));
  if (seq < st.last) {
    // Older than what we have: a late message from the offline queue, or a reboot
    // whose boot event was lost. Not a gap by itself.
    return { missed: 0, duplicate: false };
  }
  const missed = seq - st.last - 1;
  st.last = seq;
  return { missed: Math.max(0, missed), duplicate: false };
}

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const t = readLines(TELEMETRY_FILE);
  const e = readLines(EVENTS_FILE);
  t.forEach(r => push(telemetry, r));
  e.forEach(r => push(events, r));
  // Rebuild seq tracking by replaying everything in arrival order.
  const all = [...t, ...e].sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
  for (const r of all) checkSeq(r.device, r.seq, r.event === 'boot');
  console.log(`db: loaded ${t.length} telemetry rows and ${e.length} events from ${DATA_DIR}`);
}

function saveTelemetry(row) {
  fs.appendFileSync(TELEMETRY_FILE, JSON.stringify(row) + '\n');
  push(telemetry, row);
}

function saveEvent(row) {
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(row) + '\n');
  push(events, row);
}

function logServer(type, extra = {}) {
  fs.appendFileSync(SERVER_FILE, JSON.stringify({ type, at: new Date().toISOString(), ...extra }) + '\n');
}

const tsOf = r => Date.parse(r.ts);

// Newest reading by the device's own clock (late queued messages do not count as "latest").
function latest(device) {
  const list = telemetry.get(device);
  if (!list || !list.length) return null;
  let best = list[list.length - 1];
  for (let i = list.length - 1; i >= Math.max(0, list.length - 500); i--) {
    if (tsOf(list[i]) > tsOf(best)) best = list[i];
  }
  return best;
}

// Readings taken since sinceMs (device time), oldest first. Late arrivals land in their place.
function history(device, sinceMs) {
  return (telemetry.get(device) || []).filter(r => tsOf(r) >= sinceMs).sort((a, b) => tsOf(a) - tsOf(b));
}

function eventsSince(device, sinceMs) {
  return (events.get(device) || []).filter(r => tsOf(r) >= sinceMs).sort((a, b) => tsOf(a) - tsOf(b));
}

function allTelemetry(device) { return telemetry.get(device) || []; }
function allEvents(device) { return events.get(device) || []; }
function serverLog() { return readLines(SERVER_FILE); }

function devices() {
  return [...telemetry.keys()];
}

module.exports = {
  DATA_DIR, init, checkSeq, saveTelemetry, saveEvent, logServer,
  latest, history, eventsSince, allTelemetry, allEvents, serverLog, devices, readLines,
  TELEMETRY_FILE, EVENTS_FILE, SERVER_FILE,
};
