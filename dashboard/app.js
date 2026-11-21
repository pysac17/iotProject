// Person 3: dashboard logic.
//   /api/latest       live temperature, online status, Wi-Fi and RAM   (every 5 s)
//   /api/history      temperature, Wi-Fi and RAM charts for 1 h / 24 h / 72 h
//   /api/reliability  uptime, delivery, gaps, reboots, server downtime (every 60 s)
// All chart times use the device timestamp `ts` (when the reading was taken), so
// readings that arrive late after an outage land in their correct place.
// Open with ?device=<id> to look at another device (e.g. the test_api.sh device).

const DEVICE = new URLSearchParams(location.search).get("device") || "g20-desk-01";
const SEND_INTERVAL_S = 10;          // the device sends one reading every 10 s
const LATEST_EVERY_MS = 5000;        // live status refresh
const RELIABILITY_EVERY_MS = 60000;  // reliability panel refresh
const FRESH_LIMIT_S = 60;            // service level: data no older than 60 s
const UPTIME_TARGET = 99;            // service level: uptime >= 99 %

// Time ranges. `every` asks the server for one point per N seconds; the page
// also averages into buckets of that size itself, so long ranges stay fast either way.
const RANGES = {
  "1h":  { minutes: 60,   every: null, refreshMs: 30000,  label: "last hour" },
  "24h": { minutes: 1440, every: 60,   refreshMs: 180000, label: "last 24 hours, one point per minute" },
  "72h": { minutes: 4320, every: 300,  refreshMs: 300000, label: "last 72 hours, one point per 5 minutes" },
};

const $ = id => document.getElementById(id);

let range = "1h";
let lastSeq = null;
let lastAgeS = null;
let lastFetchAt = null;
let historyTimer = null;
let historyBusy = false;
const charts = {};
let rebootMarkers = [];   // [{ x: ms, reason }] drawn on the temperature chart

$("device-id").textContent = DEVICE;

// ---------- helpers ----------

const q = s => encodeURIComponent(s);
const tsMs = r => Date.parse(r.ts);
const num = v => (typeof v === "number" && Number.isFinite(v)) ? v : null;

function showError(msg) {
  $("error-msg").textContent = msg;
  $("error-msg").hidden = !msg;
}

function setBadge(kind, text) {
  $("status-badge").className = "badge badge-" + kind;   // online | offline | unknown
  $("status-badge").textContent = text;
}

function formatDuration(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  if (seconds < 60) return seconds + " s";
  const m = Math.floor(seconds / 60);
  if (m < 60) return m + " min " + (seconds % 60) + " s";
  const h = Math.floor(m / 60);
  if (h < 48) return h + " h " + (m % 60) + " min";
  return Math.floor(h / 24) + " d " + (h % 24) + " h";
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatTick(ms) {
  const d = new Date(ms);
  if (range === "1h") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
  return res.json();
}

// ---------- live status ----------

async function refreshLatest() {
  try {
    const data = await getJson("/api/latest?device=" + q(DEVICE));
    const r = data.latest;

    const t = num(r.temp_c);
    $("temp-value").textContent = t === null ? "--" : t.toFixed(1);
    setBadge(data.online ? "online" : "offline", data.online ? "Online" : "Offline");

    const parts = [];
    if (num(r.rssi_dbm) !== null) parts.push("Wi-Fi " + r.rssi_dbm + " dBm");
    if (num(r.free_heap) !== null) parts.push("RAM free " + (r.free_heap / 1024).toFixed(1) + " KB");
    if (num(r.queued)) parts.push(r.queued + " queued");
    if (t === null) parts.push("temperature sensor not reporting");
    $("live-health").textContent = parts.join(" · ");

    lastAgeS = data.age_s;
    lastFetchAt = Date.now();
    updateLastSeen();
    showError("");

    // A new reading arrived: refresh the short chart right away
    if (r.seq !== lastSeq) {
      lastSeq = r.seq;
      if (range === "1h") refreshHistory();
    }
  } catch (err) {
    if (err.status === 404) {
      $("temp-value").textContent = "--";
      setBadge("unknown", "No data yet");
      $("last-seen").textContent = "Waiting for the first reading…";
      $("live-health").textContent = "";
      lastAgeS = null;
      showError("");
    } else {
      setBadge("unknown", "Server unreachable");
      showError("Can't reach the server (" + err.message + "). Is npm start running?");
    }
    updateFreshnessSlo();
  }
}

// "How long ago" counts up every second between polls
function updateLastSeen() {
  if (lastAgeS === null) return;
  const age = currentAgeS();
  $("last-seen").textContent = "Last reading " + formatDuration(age) + " ago";
  updateFreshnessSlo();
}

function currentAgeS() {
  if (lastAgeS === null) return null;
  return lastAgeS + Math.floor((Date.now() - lastFetchAt) / 1000);
}

// ---------- reliability panel ----------

function setSlo(id, pass, text) {
  const el = $(id);
  el.classList.toggle("pass", pass === true);
  el.classList.toggle("fail", pass === false);
  el.querySelector(".slo-mark").textContent = pass === true ? "✓" : pass === false ? "✗" : "–";
  $(id + "-text").textContent = text;
}

function updateFreshnessSlo() {
  const age = currentAgeS();
  if (age === null) setSlo("slo-fresh", null, "No reading yet");
  else setSlo("slo-fresh", age <= FRESH_LIMIT_S, "Newest reading is " + formatDuration(age) + " old");
}

const isUnexplained = g => /^unknown/i.test(g.cause || "");

async function refreshReliability() {
  let r;
  try {
    r = await getJson("/api/reliability?device=" + q(DEVICE) + "&hours=72&interval=" + SEND_INTERVAL_S);
  } catch (err) {
    $("rel-window").textContent = err.status === 404 ? "No data yet" : "Could not load (" + err.message + ")";
    return;
  }
  if (r.error) { $("rel-window").textContent = r.error; return; }

  const w = r.window;
  $("rel-window").textContent = "Over " + w.duration + " (" + formatDateTime(w.from) + " to " + formatDateTime(w.to) +
    "), updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  // Big numbers
  const m = r.messages;
  $("rel-uptime").textContent = r.uptime_pct + "%";
  $("rel-delivery").textContent = m.delivery_pct + "%";
  $("rel-delivery-count").textContent = m.received.toLocaleString() + " of " + m.expected.toLocaleString() +
    " messages (" + m.missing.toLocaleString() + " missing)";

  // Small numbers
  $("rel-late").textContent = m.delivered_late.toLocaleString();
  $("rel-dropped").textContent = m.dropped_by_device.toLocaleString();
  $("rel-reboots").textContent = r.reboots.length;
  $("rel-restarts").textContent = r.server_restarts;

  // Service levels
  setSlo("slo-uptime", r.uptime_pct >= UPTIME_TARGET, "Now " + r.uptime_pct + "% over " + w.duration);
  const unexplained = r.gaps.filter(isUnexplained).length;
  setSlo("slo-gaps", unexplained === 0,
    r.gaps.length === 0 ? "No gaps" :
    unexplained === 0 ? "All " + r.gaps.length + " gaps have a cause" :
    unexplained + " of " + r.gaps.length + " gaps have no known cause");

  // Gaps table
  $("gaps-body").innerHTML = r.gaps.length === 0
    ? '<tr><td colspan="5" class="empty">No gaps longer than 3 intervals (' + 3 * SEND_INTERVAL_S + ' s).</td></tr>'
    : r.gaps.map(g => '<tr class="' + (isUnexplained(g) ? "unexplained" : "") + '">' +
        '<td class="nowrap">' + formatDateTime(g.start) + "</td>" +
        '<td class="nowrap">' + formatDateTime(g.end) + "</td>" +
        '<td class="nowrap">' + formatDuration(g.duration_s) + "</td>" +
        "<td>" + g.missing_messages + "</td>" +
        "<td>" + escapeHtml(g.cause) + '<span class="evidence">' + escapeHtml(g.evidence) + "</span></td></tr>").join("");

  // Reboots table
  $("reboots-body").innerHTML = r.reboots.length === 0
    ? '<tr><td colspan="3" class="empty">None.</td></tr>'
    : r.reboots.map(b => '<tr><td class="nowrap">' + formatDateTime(b.at) + "</td><td>" + escapeHtml(b.reason) +
        "</td><td>" + escapeHtml(b.meaning) + "</td></tr>").join("");

  // Server downtime table
  $("downtime-body").innerHTML = r.server_downtime.length === 0
    ? '<tr><td colspan="3" class="empty">None.</td></tr>'
    : r.server_downtime.map(d => '<tr><td class="nowrap">' + formatDateTime(d.start) + '</td><td class="nowrap">' +
        formatDateTime(d.end) + "</td><td>" + escapeHtml(d.duration) + "</td></tr>").join("");

  // Free RAM over the whole window (a steady fall would mean a memory leak)
  const h = r.health && r.health.free_heap;
  $("heap-summary").textContent = h
    ? "Over " + w.duration + ": " + (h.first / 1024).toFixed(1) + " KB at the start, lowest " + (h.min / 1024).toFixed(1) +
      " KB, now " + (h.last / 1024).toFixed(1) + " KB (change " + (h.change >= 0 ? "+" : "") + (h.change / 1024).toFixed(1) + " KB)."
    : "";
}

// ---------- history charts ----------

// Average readings into buckets of `stepS` seconds. A bucket whose values are all
// null stays null, so a missing sensor shows as a gap, not a zero.
function toPoints(rows, field, stepS) {
  const pts = [];
  if (!stepS) {
    for (const r of rows) pts.push({ x: tsMs(r), y: num(r[field]) });
  } else {
    const buckets = new Map();
    for (const r of rows) {
      const key = Math.floor(tsMs(r) / (stepS * 1000));
      if (!buckets.has(key)) buckets.set(key, { sum: 0, n: 0 });
      const v = num(r[field]);
      if (v !== null) { const b = buckets.get(key); b.sum += v; b.n++; }
    }
    for (const [key, b] of [...buckets].sort((a, c) => a[0] - c[0])) {
      pts.push({ x: (key + 0.5) * stepS * 1000, y: b.n ? b.sum / b.n : null });
    }
  }
  // Break the line where readings are missing (more than 3 send intervals apart)
  const gapMs = Math.max(3 * SEND_INTERVAL_S, 2 * (stepS || 0)) * 1000;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    if (i > 0 && pts[i].x - pts[i - 1].x > gapMs) out.push({ x: (pts[i].x + pts[i - 1].x) / 2, y: null });
    out.push(pts[i]);
  }
  return out;
}

// Draws a dashed vertical line for each device reboot on the temperature chart
const rebootPlugin = {
  id: "rebootMarkers",
  afterDatasetsDraw(chart, args, opts) {
    if (!opts.show) return;
    const { ctx, chartArea: a, scales: { x } } = chart;
    ctx.save();
    ctx.strokeStyle = "#8250df";
    ctx.fillStyle = "#8250df";
    ctx.setLineDash([4, 4]);
    ctx.font = "11px system-ui, sans-serif";
    for (const m of rebootMarkers) {
      if (m.x < x.min || m.x > x.max) continue;
      const px = x.getPixelForValue(m.x);
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
      ctx.fillText("reboot: " + m.reason, Math.min(px + 4, a.right - 90), a.top + 12);
    }
    ctx.restore();
  },
};
Chart.register(rebootPlugin);

// Put time labels on round local times: every 10 min (1 h), 4 h (24 h) or 12 h (72 h)
const TICK_STEP_MS = { "1h": 10 * 60000, "24h": 4 * 3600000, "72h": 12 * 3600000 };
function roundTicks(axis) {
  const step = TICK_STEP_MS[range];
  const tz = -new Date().getTimezoneOffset() * 60000;   // so ticks land on local hours
  const ticks = [];
  for (let v = Math.ceil((axis.min + tz) / step) * step - tz; v <= axis.max; v += step) ticks.push({ value: v });
  axis.ticks = ticks;
}

function makeChart(canvasId, label, color, unit, showReboots) {
  return new Chart($(canvasId), {
    type: "line",
    data: { datasets: [{ label, data: [], borderColor: color, backgroundColor: color + "1a",
      fill: showReboots, tension: 0.25, pointRadius: 0, borderWidth: 2, spanGaps: false }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      plugins: {
        legend: { display: false },
        rebootMarkers: { show: showReboots },
        tooltip: { callbacks: {
          title: items => items.length ? formatDateTime(items[0].parsed.x) : "",
          label: item => item.parsed.y === null ? "no reading" : item.parsed.y.toFixed(1) + " " + unit,
        } },
      },
      scales: {
        x: { type: "linear", afterBuildTicks: roundTicks,
             ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 12, callback: v => formatTick(v) } },
        y: { title: { display: true, text: unit } },
      },
    },
  });
}

function setChart(chart, points, fromMs, toMs) {
  chart.data.datasets[0].data = points;
  chart.options.scales.x.min = fromMs;
  chart.options.scales.x.max = toMs;
  chart.update();
}

async function refreshHistory() {
  if (historyBusy) return;
  historyBusy = true;
  const cfg = RANGES[range];
  const rangeAtStart = range;
  try {
    let url = "/api/history?device=" + q(DEVICE) + "&minutes=" + cfg.minutes;
    if (cfg.every) url += "&every=" + cfg.every;
    const data = await getJson(url);
    if (range !== rangeAtStart) return;   // user switched range while loading

    const rows = (data.telemetry || []).filter(r => Number.isFinite(tsMs(r))).sort((a, b) => tsMs(a) - tsMs(b));
    const toMs = Date.now();
    const fromMs = toMs - cfg.minutes * 60000;

    rebootMarkers = (data.events || []).filter(e => e.event === "boot").map(e => ({ x: tsMs(e), reason: e.reason || "unknown" }));

    setChart(charts.temp, toPoints(rows, "temp_c", cfg.every), fromMs, toMs);
    setChart(charts.rssi, toPoints(rows, "rssi_dbm", cfg.every), fromMs, toMs);
    setChart(charts.heap, toPoints(rows, "free_heap", cfg.every).map(p => ({ x: p.x, y: p.y === null ? null : p.y / 1024 })), fromMs, toMs);

    const temps = rows.map(r => num(r.temp_c)).filter(v => v !== null);
    $("history-note").textContent = rows.length === 0
      ? "No readings in the " + cfg.label + "."
      : rows.length.toLocaleString() + " readings, " + cfg.label +
        (temps.length ? ". Range " + Math.min(...temps).toFixed(1) + " to " + Math.max(...temps).toFixed(1) + " °C" : "") +
        (rebootMarkers.length ? ". Dashed purple lines are device reboots." : ".") +
        " Breaks in the line are missing readings.";
    $("health-range").textContent = "Same range as the temperature chart (" + cfg.label + ")";
  } catch (err) {
    $("history-note").textContent = err.status === 404 ? "No data yet." : "Could not load history (" + err.message + ").";
  } finally {
    historyBusy = false;
  }
}

function setRange(newRange) {
  range = newRange;
  document.querySelectorAll(".range button").forEach(b => b.classList.toggle("active", b.dataset.range === range));
  clearInterval(historyTimer);
  historyTimer = setInterval(refreshHistory, RANGES[range].refreshMs);
  refreshHistory();
}

document.querySelectorAll(".range button").forEach(b => b.addEventListener("click", () => setRange(b.dataset.range)));

// ---------- start ----------

charts.temp = makeChart("temp-chart", "Temperature", "#d1495b", "°C", true);
charts.rssi = makeChart("rssi-chart", "Wi-Fi signal", "#0969da", "dBm", false);
charts.heap = makeChart("heap-chart", "Free RAM", "#1a7f37", "KB", false);

refreshLatest();
refreshReliability();
setRange("1h");
setInterval(refreshLatest, LATEST_EVERY_MS);
setInterval(refreshReliability, RELIABILITY_EVERY_MS);
setInterval(updateLastSeen, 1000);
