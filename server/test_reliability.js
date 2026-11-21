#!/usr/bin/env node
// Person 2: checks the reliability report against a simulated 6-hour run with
// known failures, so we know it explains real gaps correctly.
//   npm run test:reliability
const assert = require('assert');
const { analyze, toMarkdown } = require('./reliability');

const DEV = 'g20-desk-01';
const I = 10;                                   // one message every 10 s
const T0 = Date.parse('2026-11-20T18:00:00Z');
const iso = t => new Date(t).toISOString().replace('.000Z', 'Z');

const telemetry = [], events = [], serverLog = [];
let seq = 0, bootAt = T0, dropped = 0;
const boot = (t, reason) => { seq = 0; bootAt = t; events.push({ device: DEV, ts: iso(t), seq: ++seq, event: 'boot', reason, received_at: iso(t + 2000) }); };
const reading = (t, receivedAt) => telemetry.push({
  device: DEV, ts: iso(t), seq: ++seq, temp_c: 24.5, light_pct: 50, state: 'focused',
  rssi_dbm: -60, uptime_s: Math.round((t - bootAt) / 1000), free_heap: 230000, queued: 0, dropped,
  received_at: iso(receivedAt ?? t + 300),
});

// Server heartbeat every minute, except 03:00-03:30 after the start (server down).
for (let t = T0; t <= T0 + 6 * 3600e3; t += 60e3) {
  if (t > T0 + 3 * 3600e3 && t < T0 + 3.5 * 3600e3) continue;
  serverLog.push({ type: t === T0 ? 'start' : 'alive', at: iso(t) });
}

boot(T0, 'power_on');
for (let t = T0 + 5e3; t <= T0 + 6 * 3600e3; t += I * 1000) {
  const h = (t - T0) / 3600e3;
  // A) 00:30-00:50 Wi-Fi down: readings queued, delivered at 00:50 -> NOT a gap.
  if (h >= 0.5 && h < 0.8333) { reading(t, T0 + 0.8333 * 3600e3 + (seq % 50) * 300); continue; }
  // B) 01:30-01:45 unplugged: no readings, then a power_on boot.
  if (h >= 1.5 && h < 1.75) continue;
  if (h >= 1.75 && h < 1.75 + I / 3600) boot(t - 1000, 'power_on');
  // C) 02:20 firmware hang: 30 s silence, then app_watchdog reboot.
  if (h >= 2.3333 && h < 2.3333 + 35 / 3600) continue;
  if (h >= 2.3333 + 35 / 3600 && h < 2.3333 + 45 / 3600) boot(t - 1000, 'app_watchdog');
  // D) 03:00-03:30 server down: device queues and catches up at 03:30 -> recovered, not a gap.
  if (h >= 3 && h < 3.5) { reading(t, T0 + 3.5 * 3600e3 + 5000 + (seq % 50) * 300); continue; }
  // E) 04:00-05:20 Wi-Fi down for 80 min > 66 min queue: oldest ~14 min dropped.
  if (h >= 4 && h < 4 + 14 / 60) { dropped++; continue; }
  if (h >= 4 + 14 / 60 && h < 5.3333) { reading(t, T0 + 5.3333 * 3600e3 + (seq % 400) * 300); continue; }
  reading(t);
}

const r = analyze({ telemetry, events, serverLog, device: DEV, intervalS: I, from: T0, to: T0 + 6 * 3600e3 });
console.log(toMarkdown(r));

assert.strictEqual(r.gaps.length, 3, 'three real gaps: unplug, watchdog hang, queue overflow');
assert.match(r.gaps[0].cause, /power was lost/);
assert.match(r.gaps[1].cause, /watchdog/);
assert.match(r.gaps[2].cause, /66-minute queue/);
assert.ok(r.recovered_outages.length >= 2, 'Wi-Fi outage and server outage recovered by the queue');
assert.strictEqual(r.reboots.length, 3, 'start-up + unplug + watchdog');
assert.strictEqual(r.server_downtime.length, 1, 'one server outage');
assert.ok(r.uptime_pct > 90 && r.uptime_pct < 100, `uptime ${r.uptime_pct}% should reflect ~30 min of gaps`);
assert.ok(r.messages.received < r.messages.expected);
console.log('\nAll reliability checks passed.');
