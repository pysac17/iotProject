// Person 2: turns the logs into the numbers the 72-hour reliability write-up needs:
// uptime, messages expected vs received, every gap with its likely cause, reboots,
// server downtime and device health. Used by GET /api/reliability and by
// `npm run report` (reliability_report.js).
//
// All times are judged by the DEVICE's timestamp (ts): a reading that waited in
// the offline queue and arrived late still counts, in its proper place.

const REBOOT_CAUSES = {
  power_on: 'power was lost or the USB cable was unplugged, then the device restarted',
  brownout: 'supply voltage dipped (brownout), the chip reset itself',
  panic: 'firmware crashed (panic) and restarted',
  app_watchdog: 'firmware hung for 30 s, our watchdog restarted it',
  task_watchdog: 'firmware hung, the system task watchdog restarted it',
  int_watchdog: 'firmware hung with interrupts off, the interrupt watchdog restarted it',
  other_watchdog: 'a hardware watchdog restarted the chip',
  software: 'software restart (e.g. after a new upload)',
  external_pin: 'the EN/RST button was pressed',
  deep_sleep: 'woke from deep sleep',
  unknown: 'restart with unknown reason',
};

const ms = s => Date.parse(s);
const iso = t => new Date(t).toISOString().replace('.000Z', 'Z');
const dur = s => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${sec} s` : `${sec} s`;
};
const median = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

// Server downtime = stretches with no "start"/"alive" line for more than 3 minutes
// (the server writes "alive" every 60 s).
function serverDowntime(serverLog, fromMs, toMs) {
  const beats = serverLog.filter(r => r.type === 'start' || r.type === 'alive').map(r => ms(r.at)).sort((a, b) => a - b);
  const down = [];
  if (!beats.length) return down;
  let prev = beats[0];
  for (const t of beats.slice(1)) {
    if (t - prev > 180000 && t >= fromMs && prev <= toMs) down.push({ start: prev, end: t });
    prev = t;
  }
  return down;
}

/**
 * @param {object} o
 * @param {object[]} o.telemetry  telemetry rows (any order)
 * @param {object[]} o.events     event rows (any order)
 * @param {object[]} o.serverLog  rows from data/server.jsonl
 * @param {string}   o.device
 * @param {number}   [o.from]     window start, ms (default: first reading)
 * @param {number}   [o.to]       window end, ms (default: last reading)
 * @param {number}   [o.intervalS=10] how often the device sends telemetry
 */
function analyze({ telemetry, events, serverLog = [], device, from, to, intervalS = 10 }) {
  const I = intervalS * 1000;
  const gapLimit = 3 * I; // more than 3 intervals between readings = a gap

  // Unique readings for this device (drop exact duplicates by ts + seq).
  const seen = new Set();
  const rows = telemetry
    .filter(r => r.device === device && !Number.isNaN(ms(r.ts)))
    .filter(r => { const k = `${r.ts}|${r.seq}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => ms(a.ts) - ms(b.ts));
  const evs = events.filter(e => e.device === device).sort((a, b) => ms(a.ts) - ms(b.ts));

  if (!rows.length) return { device, error: 'no telemetry for this device' };
  const fromMs = from ?? ms(rows[0].ts);
  const toMs = to ?? ms(rows[rows.length - 1].ts);
  const inWin = rows.filter(r => ms(r.ts) >= fromMs && ms(r.ts) <= toMs);
  const spanS = (toMs - fromMs) / 1000;

  const expected = Math.floor(spanS / intervalS) + 1;
  const received = inWin.length;

  const boots = evs.filter(e => e.event === 'boot' && ms(e.ts) >= fromMs - gapLimit && ms(e.ts) <= toMs);
  const srvDown = serverDowntime(serverLog, fromMs, toMs);

  // ---------- gaps ----------
  const gaps = [];
  const points = [{ ts: iso(fromMs), _edge: true }, ...inWin, { ts: iso(toMs), _edge: true }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const diff = ms(b.ts) - ms(a.ts);
    if (diff <= gapLimit) continue;
    const g = {
      start: a.ts, end: b.ts, duration_s: diff / 1000,
      missing_messages: Math.max(0, Math.round(diff / I) - 1),
      cause: '', evidence: '',
    };
    const boot = boots.find(e => ms(e.ts) > ms(a.ts) - I && ms(e.ts) <= ms(b.ts));
    const down = srvDown.find(d => d.start < ms(b.ts) && d.end > ms(a.ts));
    const dropsBefore = a.dropped ?? 0, dropsAfter = b.dropped ?? dropsBefore;
    if (boot) {
      const reason = boot.reason || 'unknown';
      g.cause = `Device rebooted: ${REBOOT_CAUSES[reason] || reason}`;
      g.evidence = `boot event at ${boot.ts}, reset reason "${reason}"`
        + (a.uptime_s != null ? `; uptime before was ${dur(a.uptime_s)}` : '');
    } else if (down) {
      g.cause = 'Server (laptop) was not running, and the gap was longer than the device could buffer, or the device was also down';
      g.evidence = `no server heartbeat from ${iso(down.start)} to ${iso(down.end)}`;
    } else if (dropsAfter > dropsBefore) {
      g.cause = `Device was offline longer than its 66-minute queue; ${dropsAfter - dropsBefore} oldest messages were dropped`;
      g.evidence = `"dropped" counter went from ${dropsBefore} to ${dropsAfter}`;
    } else if (a._edge || b._edge) {
      g.cause = a._edge ? 'No data at the start of the window (device not yet running?)' : 'No data at the end of the window (device stopped or unplugged?)';
      g.evidence = 'edge of the test window';
    } else {
      const upA = a.uptime_s, upB = b.uptime_s;
      const continuous = upA != null && upB != null && Math.abs((upB - upA) - diff / 1000) < 3 * intervalS;
      g.cause = continuous
        ? 'Device stayed up (uptime continuous) but these messages never arrived; check Wi-Fi notes'
        : 'Unknown: no reboot event, no server outage, no drops recorded; check the test notes';
      g.evidence = continuous ? `uptime ${upA} s -> ${upB} s` : 'none in the logs';
    }
    gaps.push(g);
  }
  const gapLossS = gaps.reduce((s, g) => s + Math.max(0, g.duration_s - intervalS), 0);

  // ---------- outages the queue recovered (data complete, but delivered late) ----------
  const recovered = [];
  let cur = null;
  for (const r of inWin) {
    const delay = (ms(r.received_at) - ms(r.ts)) / 1000;
    if (delay > 3 * intervalS) {
      if (!cur) cur = { start: r.ts, end: r.ts, messages: 0, max_delay_s: 0 };
      cur.end = r.ts; cur.messages++; cur.max_delay_s = Math.max(cur.max_delay_s, delay);
    } else if (cur) { recovered.push(cur); cur = null; }
  }
  if (cur) recovered.push(cur);

  // ---------- health ----------
  const rssi = inWin.map(r => r.rssi_dbm).filter(v => typeof v === 'number');
  const heap = inWin.map(r => r.free_heap).filter(v => typeof v === 'number');
  const temps = inWin.map(r => r.temp_c).filter(v => typeof v === 'number');
  const lastRow = inWin[inWin.length - 1] || {};

  return {
    device,
    window: { from: iso(fromMs), to: iso(toMs), duration_s: spanS, duration: dur(spanS), interval_s: intervalS },
    uptime_pct: spanS > 0 ? +(100 * (1 - gapLossS / spanS)).toFixed(2) : 100,
    messages: {
      expected, received,
      delivery_pct: +(100 * received / expected).toFixed(2),
      missing: Math.max(0, expected - received),
      delivered_late: recovered.reduce((s, r) => s + r.messages, 0),
      dropped_by_device: lastRow.dropped ?? 0,
    },
    gaps,
    recovered_outages: recovered,
    reboots: boots.map(b => ({ at: b.ts, reason: b.reason || 'unknown', meaning: REBOOT_CAUSES[b.reason] || '' })),
    server_downtime: srvDown.map(d => ({ start: iso(d.start), end: iso(d.end), duration: dur((d.end - d.start) / 1000) })),
    server_restarts: serverLog.filter(r => r.type === 'start' && ms(r.at) >= fromMs && ms(r.at) <= toMs).length,
    health: {
      rssi_dbm: rssi.length ? { min: Math.min(...rssi), median: median(rssi), max: Math.max(...rssi) } : null,
      free_heap: heap.length ? { first: heap[0], min: Math.min(...heap), last: heap[heap.length - 1], change: heap[heap.length - 1] - heap[0] } : null,
      temp_c: temps.length ? { min: Math.min(...temps), max: Math.max(...temps) } : null,
      max_queue: Math.max(0, ...inWin.map(r => r.queued ?? 0)),
    },
  };
}

// Markdown for the Final Report.
function toMarkdown(r) {
  if (r.error) return `# Reliability report\n\n${r.error}\n`;
  const L = [];
  L.push(`# Reliability report: ${r.device}`, '');
  L.push(`Window: ${r.window.from} to ${r.window.to} (${r.window.duration}), one message every ${r.window.interval_s} s.`, '');
  L.push('| Measure | Value |', '| --- | --- |');
  L.push(`| Uptime | ${r.uptime_pct}% |`);
  L.push(`| Messages expected | ${r.messages.expected} |`);
  L.push(`| Messages received | ${r.messages.received} (${r.messages.delivery_pct}%) |`);
  L.push(`| Missing | ${r.messages.missing} |`);
  L.push(`| Delivered late from the offline queue | ${r.messages.delivered_late} |`);
  L.push(`| Dropped by the device (queue full) | ${r.messages.dropped_by_device} |`);
  L.push(`| Device reboots | ${r.reboots.length} |`);
  L.push(`| Server restarts | ${r.server_restarts} |`, '');

  L.push('## Gaps', '');
  if (!r.gaps.length) L.push('No gaps longer than 3 intervals.', '');
  else {
    L.push('| Start (UTC) | End (UTC) | Length | Missing msgs | Cause | Evidence |', '| --- | --- | --- | --- | --- | --- |');
    for (const g of r.gaps) L.push(`| ${g.start} | ${g.end} | ${dur(g.duration_s)} | ${g.missing_messages} | ${g.cause} | ${g.evidence} |`);
    L.push('');
  }
  L.push('## Outages recovered by the offline queue', '');
  if (!r.recovered_outages.length) L.push('None.', '');
  else {
    L.push('| Readings from | to | Messages | Longest delay |', '| --- | --- | --- | --- |');
    for (const o of r.recovered_outages) L.push(`| ${o.start} | ${o.end} | ${o.messages} | ${dur(o.max_delay_s)} |`);
    L.push('');
  }
  L.push('## Reboots', '');
  if (!r.reboots.length) L.push('None.', '');
  else { L.push('| At (UTC) | Reset reason | Meaning |', '| --- | --- | --- |'); for (const b of r.reboots) L.push(`| ${b.at} | ${b.reason} | ${b.meaning} |`); L.push(''); }
  L.push('## Server downtime', '');
  if (!r.server_downtime.length) L.push('None.', '');
  else { L.push('| From | To | Length |', '| --- | --- | --- |'); for (const d of r.server_downtime) L.push(`| ${d.start} | ${d.end} | ${d.duration} |`); L.push(''); }
  const h = r.health;
  L.push('## Device health', '');
  if (h.rssi_dbm) L.push(`- Wi-Fi signal: min ${h.rssi_dbm.min} dBm, median ${h.rssi_dbm.median} dBm, max ${h.rssi_dbm.max} dBm`);
  if (h.free_heap) L.push(`- Free RAM: ${h.free_heap.first} bytes at the start, ${h.free_heap.last} at the end (change ${h.free_heap.change}), lowest ${h.free_heap.min}`);
  if (h.temp_c) L.push(`- Temperature range: ${h.temp_c.min} to ${h.temp_c.max} °C`);
  L.push(`- Largest offline queue: ${h.max_queue} messages`, '');
  return L.join('\n');
}

function gapsCsv(r) {
  const q = s => `"${String(s).replace(/"/g, '""')}"`;
  return ['start,end,duration_s,missing_messages,cause,evidence',
    ...(r.gaps || []).map(g => [g.start, g.end, g.duration_s, g.missing_messages, q(g.cause), q(g.evidence)].join(','))].join('\n') + '\n';
}

module.exports = { analyze, toMarkdown, gapsCsv, REBOOT_CAUSES };
