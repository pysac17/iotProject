// Person 2: Wi-Fi link and sending data to the server. See include/net.h.
#include "net.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <time.h>
#include "secrets.h"   // copy secrets.example.h to secrets.h first

namespace {

// ---------- Wi-Fi reconnect with backoff ----------
// Retry after 2 s, then 4, 8, 16, 32, 60, 60 ... so a dead router is not hammered.
constexpr uint32_t BACKOFF_MIN_MS = 2000;
constexpr uint32_t BACKOFF_MAX_MS = 60000;
constexpr uint16_t HTTP_TIMEOUT_MS = 5000;   // a slow server must not freeze the device

uint32_t backoffMs     = BACKOFF_MIN_MS;
uint32_t lastAttemptMs = 0;
bool     wasConnected  = false;
uint32_t seq           = 0;      // +1 for every message, sent or not, so the server can see gaps
bool     clockSynced   = false;

void startConnect() {
  Serial.printf("[net] connecting to %s (next retry in %lu s)\n", WIFI_SSID, (unsigned long)(backoffMs / 1000));
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastAttemptMs = millis();
}

// ---------- time ----------
// The server needs an ISO 8601 timestamp, so the clock is set from the internet (NTP) once online.
bool isoNow(char* out, size_t len) {
  time_t now = time(nullptr);
  if (now < 1700000000) return false;            // before Nov 2023 = clock not set yet
  struct tm utc;
  gmtime_r(&now, &utc);
  strftime(out, len, "%Y-%m-%dT%H:%M:%SZ", &utc);
  return true;
}

const char* stateName(FocusState s) {
  switch (s) {
    case FocusState::Focused:  return "focused";
    case FocusState::Restless: return "restless";
    case FocusState::Away:     return "away";
  }
  return "away";
}

// POST one JSON body. Returns the HTTP status code (negative = never reached the server).
int post(const char* body) {
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  String url = String(SERVER_URL) + "/api/telemetry";
  if (!http.begin(url)) return -100;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_API_KEY);
  int code = http.POST((uint8_t*)body, strlen(body));
  if (code != 200) {
    Serial.printf("[net] POST failed: %d %s\n", code, code > 0 ? http.getString().c_str() : http.errorToString(code).c_str());
  }
  http.end();
  return code;
}

}  // namespace

// ---------- public ----------

void netBegin() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);   // we handle reconnects ourselves (with backoff)
  WiFi.setSleep(true);            // modem sleep between packets saves power
  startConnect();
}

void netLoop() {
  const bool connected = WiFi.status() == WL_CONNECTED;

  if (connected && !wasConnected) {
    Serial.printf("[net] online, IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    backoffMs = BACKOFF_MIN_MS;
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");   // UTC; returns at once, syncs in the background
  }
  if (!connected && wasConnected) {
    Serial.println("[net] Wi-Fi lost");
    lastAttemptMs = millis();     // wait one backoff period before the first retry
  }
  wasConnected = connected;

  if (!connected && millis() - lastAttemptMs >= backoffMs) {
    backoffMs = min(backoffMs * 2, BACKOFF_MAX_MS);
    startConnect();
  }

  if (connected && !clockSynced) {
    char ts[25];
    if (isoNow(ts, sizeof ts)) { clockSynced = true; Serial.printf("[net] clock set: %s\n", ts); }
  }
}

bool netIsConnected() { return WiFi.status() == WL_CONNECTED; }

size_t telemetryToJson(const Telemetry& t, uint32_t seqNo, const char* ts, char* buf, size_t len) {
  int n = snprintf(buf, len,
    "{\"device\":\"%s\",\"ts\":\"%s\",\"seq\":%lu,"
    "\"light_pct\":%d,\"temp_c\":%.1f,\"motion_rms_g\":%.3f,\"motion_spikes\":%d,"
    "\"state\":\"%s\",\"session_s\":%lu,"
    "\"rssi_dbm\":%d,\"uptime_s\":%lu,\"free_heap\":%lu}",
    DEVICE_ID, ts, (unsigned long)seqNo,
    t.lightPct, t.tempC, t.motionRmsG, t.motionSpikes,
    stateName(t.state), (unsigned long)t.sessionS,
    (int)WiFi.RSSI(), (unsigned long)(millis() / 1000), (unsigned long)ESP.getFreeHeap());
  return (n > 0 && (size_t)n < len) ? (size_t)n : 0;
}

bool sendTelemetry(const Telemetry& t) {
  const uint32_t mySeq = ++seq;
  char ts[25];
  if (!netIsConnected() || !isoNow(ts, sizeof ts)) {
    Serial.printf("[net] seq %lu skipped (offline or clock not set)\n", (unsigned long)mySeq);
    return false;                 // TODO: put it in the offline buffer instead
  }
  char body[320];                 // fixed buffer, no String growth over a 72-hour run
  if (!telemetryToJson(t, mySeq, ts, body, sizeof body)) return false;
  return post(body) == 200;
}

bool sendEvent(const char* event) {
  const uint32_t mySeq = ++seq;
  char ts[25];
  if (!netIsConnected() || !isoNow(ts, sizeof ts)) {
    Serial.printf("[net] event %s skipped (offline or clock not set)\n", event);
    return false;
  }
  char body[160];
  snprintf(body, sizeof body, "{\"device\":\"%s\",\"ts\":\"%s\",\"seq\":%lu,\"event\":\"%s\"}",
           DEVICE_ID, ts, (unsigned long)mySeq, event);
  return post(body) == 200;
}
