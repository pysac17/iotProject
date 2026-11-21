// Person 3: dashboard logic.
// Polls /api/latest for the live temperature and online status,
// and /api/history for the last 30 minutes, drawn with Chart.js.

const DEVICE = "g20-desk-01";
const LATEST_EVERY_MS = 5000;     // live status refresh
const HISTORY_EVERY_MS = 30000;   // full history refresh (device sends every 30 s)
const HISTORY_MINUTES = 30;

// Page elements
const tempEl = document.getElementById("temp-value");
const badgeEl = document.getElementById("status-badge");
const lastSeenEl = document.getElementById("last-seen");
const errorEl = document.getElementById("error-msg");
const historyEmptyEl = document.getElementById("history-empty");

let lastSeq = null;        // seq of the newest reading we have shown
let lastAgeS = null;       // age_s from the last /api/latest response
let lastFetchAt = null;    // when we got that response (so the "ago" text can tick)
let chart = null;

// ---------- helpers ----------

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = !msg;
}

function setBadge(kind, text) {
  badgeEl.className = "badge badge-" + kind;   // online | offline | unknown
  badgeEl.textContent = text;
}

function formatAgo(seconds) {
  if (seconds < 60) return seconds + " s ago";
  const m = Math.floor(seconds / 60);
  if (m < 60) return m + " min " + (seconds % 60) + " s ago";
  const h = Math.floor(m / 60);
  return h + " h " + (m % 60) + " min ago";
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ---------- live status ----------

async function refreshLatest() {
  try {
    const res = await fetch("/api/latest?device=" + encodeURIComponent(DEVICE));

    if (res.status === 404) {
      // Server is up but no reading has arrived yet
      tempEl.textContent = "--";
      setBadge("unknown", "No data yet");
      lastSeenEl.textContent = "Waiting for the first reading…";
      lastAgeS = null;
      showError("");
      return;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);

    const data = await res.json();
    const r = data.latest;

    tempEl.textContent = (typeof r.temp_c === "number") ? r.temp_c.toFixed(1) : "--";
    setBadge(data.online ? "online" : "offline", data.online ? "Online" : "Offline");

    lastAgeS = data.age_s;
    lastFetchAt = Date.now();
    updateLastSeen();
    showError("");

    // A new reading arrived: refresh the chart right away
    if (r.seq !== lastSeq) {
      lastSeq = r.seq;
      refreshHistory();
    }
  } catch (err) {
    setBadge("unknown", "Server unreachable");
    showError("Can't reach the server (" + err.message + "). Is npm start running?");
  }
}

// Make "how long ago" count up every second between polls
function updateLastSeen() {
  if (lastAgeS === null) return;
  const extra = Math.floor((Date.now() - lastFetchAt) / 1000);
  lastSeenEl.textContent = "Last reading " + formatAgo(lastAgeS + extra);
}

// ---------- history chart ----------

async function refreshHistory() {
  try {
    const url = "/api/history?device=" + encodeURIComponent(DEVICE) + "&minutes=" + HISTORY_MINUTES;
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    const rows = (data.telemetry || []).filter(t => typeof t.temp_c === "number");
    const labels = rows.map(t => formatTime(t.received_at));
    const temps = rows.map(t => t.temp_c);

    historyEmptyEl.hidden = rows.length > 0;
    drawChart(labels, temps);
  } catch (err) {
    console.error("history failed:", err);
  }
}

function drawChart(labels, temps) {
  if (chart) {
    // Update the existing chart instead of making a new one
    chart.data.labels = labels;
    chart.data.datasets[0].data = temps;
    chart.update();
    return;
  }

  const ctx = document.getElementById("temp-chart");
  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [{
        label: "Temperature (°C)",
        data: temps,
        borderColor: "#d1495b",
        backgroundColor: "rgba(209, 73, 91, 0.1)",
        fill: true,
        tension: 0.3,
        pointRadius: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: "Time" }, ticks: { maxTicksLimit: 8 } },
        y: { title: { display: true, text: "°C" } }
      }
    }
  });
}

// ---------- start ----------

refreshLatest();
refreshHistory();
setInterval(refreshLatest, LATEST_EVERY_MS);
setInterval(refreshHistory, HISTORY_EVERY_MS);
setInterval(updateLastSeen, 1000);
