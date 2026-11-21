// Person 2: Wi-Fi link, offline queue and watchdog. See include/net.h.
#include "net.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <esp_system.h>
#include <esp_attr.h>
#include <math.h>
#include <time.h>
#include "secrets.h"   // copy secrets.example.h to secrets.h first

namespace {

// ---------- tuning ----------
constexpr uint32_t BACKOFF_MIN_MS  = 2000;   // first Wi-Fi retry after 2 s ...
constexpr uint32_t BACKOFF_MAX_MS  = 60000;  // ... doubling up to 60 s
constexpr uint16_t HTTP_TIMEOUT_MS = 5000;   // a slow server must not freeze the device
constexpr uint32_t SEND_GAP_MS     = 300;    // between sends while catching up on a backlog
constexpr uint32_t RETRY_MS        = 5000;   // after a failed send, wait before trying again
constexpr uint32_t WDT_TIMEOUT_S   = 30;     // > worst case of one netLoop() (two 5 s timeouts)
constexpr uint8_t  WDT_TIMER       = 3;      // hardware timer used for the watchdog
constexpr uint32_t WDT_MAGIC       = 0x57D06D06u;

// ---------- one queued message ----------
// Stored as numbers, not JSON text, so 400 of them fit in ~34 KB of RAM.
// The JSON is built when the message is sent, with the timestamp worked out
// from when it was created (createdMs), so messages created before the clock
// was set (right after boot) still get the correct time.
enum class Kind : uint8_t { Telemetry, Event };

struct Item {
  Kind      kind;
  uint32_t  seq;
  uint32_t  createdMs;   // millis() when created
  int8_t    rssi;        // Wi-Fi signal when created (0 = not connected)
  uint32_t  freeHeap;    // free RAM when created
  Telemetry t;           // for Kind::Telemetry
  char      event[16];   // for Kind::Event
  char      reason[16];  // boot reason, for the "boot" event
};

Item     queue[NET_QUEUE_SLOTS];
size_t   qHead  = 0;     // index of the oldest message
size_t   qCount = 0;
uint32_t seq       = 0;  // +1 per message; resets at boot (the server spots that)
uint32_t dropped   = 0;  // lost because the queue was full
uint32_t rejected  = 0;  // refused by the server (4xx): never retried

// ---------- Wi-Fi state ----------
uint32_t backoffMs     = BACKOFF_MIN_MS;
uint32_t lastAttemptMs = 0;
bool     wasConnected  = false;
bool     clockSynced   = false;
bool     started       = false;

// ---------- sending state ----------
uint32_t nextSendMs = 0;

WiFiClient       plainClient;
WiFiClientSecure tlsClient;

// ---------- watchdog ----------
// A hardware timer counts up; netLoop() resets it to 0 on every pass. If loop()
// gets stuck for WDT_TIMEOUT_S, the timer interrupt fires and restarts the chip.
// (Same approach as Espressif's ESP32 Arduino watchdog example.) The marker lives
// in RTC memory, which survives a software restart, so after the reboot we can
// report "app_watchdog" instead of a plain "software" reset.
RTC_NOINIT_ATTR uint32_t wdtMarker;
hw_timer_t* wdtTimer = nullptr;

void IRAM_ATTR onWatchdog() {
  wdtMarker = WDT_MAGIC;
  ets_printf("[net] watchdog: loop() stuck for %u s, rebooting\n", (unsigned)WDT_TIMEOUT_S);
  esp_restart();
}

// ---------- helpers ----------

const char* resetReasonName(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON:   return "power_on";
    case ESP_RST_EXT:       return "external_pin";
    case ESP_RST_SW:        return "software";
    case ESP_RST_PANIC:     return "panic";
    case ESP_RST_INT_WDT:   return "int_watchdog";
    case ESP_RST_TASK_WDT:  return "task_watchdog";
    case ESP_RST_WDT:       return "other_watchdog";
    case ESP_RST_DEEPSLEEP: return "deep_sleep";
    case ESP_RST_BROWNOUT:  return "brownout";
    case ESP_RST_SDIO:      return "sdio";
    default:                return "unknown";
  }
}

const char* stateName(FocusState s) {
  switch (s) {
    case FocusState::Focused:  return "focused";
    case FocusState::Restless: return "restless";
    case FocusState::Away:     return "away";
  }
  return "away";
}

bool clockIsSet() { return time(nullptr) > 1700000000; }   // after Nov 2023

// ISO 8601 UTC time of a moment `ageMs` ago.
void isoAgo(uint32_t ageMs, char* out, size_t len) {
  time_t when = time(nullptr) - (time_t)(ageMs / 1000);
  struct tm utc;
  gmtime_r(&when, &utc);
  strftime(out, len, "%Y-%m-%dT%H:%M:%SZ", &utc);
}

Item& newItem(Kind kind) {
  if (qCount == NET_QUEUE_SLOTS) {           // full: drop the oldest, keep the newest
    qHead = (qHead + 1) % NET_QUEUE_SLOTS;
    qCount--;
    dropped++;
  }
  Item& it = queue[(qHead + qCount) % NET_QUEUE_SLOTS];
  qCount++;
  it = Item{};
  it.kind      = kind;
  it.seq       = ++seq;
  it.createdMs = millis();
  it.rssi      = (WiFi.status() == WL_CONNECTED) ? (int8_t)WiFi.RSSI() : 0;
  it.freeHeap  = ESP.getFreeHeap();
  return it;
}

// Builds the JSON for the oldest queued message. Returns its length (0 = too small).
size_t buildJson(const Item& it, char* buf, size_t len) {
  char ts[25];
  isoAgo(millis() - it.createdMs, ts, sizeof ts);
  const unsigned long uptimeS = it.createdMs / 1000;

  int n;
  if (it.kind == Kind::Event) {
    if (it.reason[0]) {
      n = snprintf(buf, len,
        "{\"device\":\"%s\",\"ts\":\"%s\",\"seq\":%lu,\"event\":\"%s\",\"reason\":\"%s\",\"uptime_s\":%lu}",
        DEVICE_ID, ts, (unsigned long)it.seq, it.event, it.reason, uptimeS);
    } else {
      n = snprintf(buf, len,
        "{\"device\":\"%s\",\"ts\":\"%s\",\"seq\":%lu,\"event\":\"%s\",\"uptime_s\":%lu}",
        DEVICE_ID, ts, (unsigned long)it.seq, it.event, uptimeS);
    }
  } else {
    char temp[12];
    if (isnan(it.t.tempC)) strcpy(temp, "null");              // BMP280 missing
    else snprintf(temp, sizeof temp, "%.1f", it.t.tempC);
    char rssi[8];
    if (it.rssi == 0) strcpy(rssi, "null");                   // created while offline
    else snprintf(rssi, sizeof rssi, "%d", it.rssi);

    n = snprintf(buf, len,
      "{\"device\":\"%s\",\"ts\":\"%s\",\"seq\":%lu,"
      "\"light_pct\":%d,\"temp_c\":%s,\"motion_rms_g\":%.4f,\"motion_spikes\":%d,"
      "\"state\":\"%s\",\"session_s\":%lu,"
      "\"rssi_dbm\":%s,\"uptime_s\":%lu,\"free_heap\":%lu,\"queued\":%u,\"dropped\":%lu}",
      DEVICE_ID, ts, (unsigned long)it.seq,
      constrain(it.t.lightPct, 0, 100), temp, it.t.motionRmsG, it.t.motionSpikes,
      stateName(it.t.state), (unsigned long)it.t.sessionS,
      rssi, uptimeS, (unsigned long)it.freeHeap, (unsigned)qCount, (unsigned long)dropped);
  }
  return (n > 0 && (size_t)n < len) ? (size_t)n : 0;
}

// POST one JSON body. Returns the HTTP status (negative = never reached the server).
int post(const char* body) {
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  const String url = String(SERVER_URL) + "/api/telemetry";

  bool ok;
  if (url.startsWith("https://")) {
#ifdef SERVER_ROOT_CA
    tlsClient.setCACert(SERVER_ROOT_CA);
    ok = http.begin(tlsClient, url);
#else
    Serial.println("[net] https:// needs SERVER_ROOT_CA in secrets.h");
    return -200;
#endif
  } else {
    ok = http.begin(plainClient, url);
  }
  if (!ok) return -100;

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_API_KEY);
  const int code = http.POST((uint8_t*)body, strlen(body));
  if (code != 200) {
    Serial.printf("[net] POST failed: %d %s\n", code,
                  code > 0 ? http.getString().c_str() : http.errorToString(code).c_str());
  }
  http.end();
  return code;
}

void startConnect() {
  Serial.printf("[net] connecting to %s\n", WIFI_SSID);
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastAttemptMs = millis();
}

void wifiService() {
  const bool connected = WiFi.status() == WL_CONNECTED;

  if (connected && !wasConnected) {
    Serial.printf("[net] online, IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    backoffMs = BACKOFF_MIN_MS;
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");   // UTC; syncs in the background
  }
  if (!connected && wasConnected) {
    Serial.println("[net] Wi-Fi lost, queueing messages until it is back");
    lastAttemptMs = millis();
  }
  wasConnected = connected;

  if (!connected && millis() - lastAttemptMs >= backoffMs) {
    startConnect();
    backoffMs = min(backoffMs * 2, BACKOFF_MAX_MS);
  }

  if (connected && !clockSynced && clockIsSet()) {
    clockSynced = true;
    char ts[25];
    isoAgo(0, ts, sizeof ts);
    Serial.printf("[net] clock set: %s\n", ts);
  }
}

// Sends the oldest queued message if it is time to. One send per netLoop() at most,
// so loop() is never held for more than one HTTP timeout.
void sendService() {
  if (qCount == 0 || WiFi.status() != WL_CONNECTED || !clockIsSet()) return;
  if ((int32_t)(millis() - nextSendMs) < 0) return;

  char body[360];
  const Item& it = queue[qHead];
  if (!buildJson(it, body, sizeof body)) {     // cannot happen with these sizes; drop it
    qHead = (qHead + 1) % NET_QUEUE_SLOTS; qCount--; rejected++;
    return;
  }

  const int code = post(body);
  if (code == 200 || (code >= 400 && code < 500 && code != 408 && code != 429)) {
    if (code != 200) {
      rejected++;                              // server will never accept it: do not retry
      Serial.printf("[net] seq %lu rejected by server (%d), dropped\n", (unsigned long)it.seq, code);
    }
    qHead = (qHead + 1) % NET_QUEUE_SLOTS;
    qCount--;
    nextSendMs = millis() + SEND_GAP_MS;
  } else {
    // No connection, timeout, rate limit or server error: keep it and retry later.
    nextSendMs = millis() + RETRY_MS;
  }
}

}  // namespace

// ---------- public ----------

void netBegin() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);   // we reconnect ourselves, with backoff
  WiFi.setSleep(true);            // modem sleep between packets saves power

  // Tell the server why we (re)started.
  const esp_reset_reason_t rr = esp_reset_reason();
  const char* reason = (rr == ESP_RST_SW && wdtMarker == WDT_MAGIC) ? "app_watchdog" : resetReasonName(rr);
  wdtMarker = 0;

  // Watchdog: reboot if loop() stops calling netLoop() for WDT_TIMEOUT_S.
  wdtTimer = timerBegin(WDT_TIMER, 80, true);                 // 80 MHz / 80 = 1 tick per microsecond
  timerAttachInterrupt(wdtTimer, &onWatchdog, true);
  timerAlarmWrite(wdtTimer, (uint64_t)WDT_TIMEOUT_S * 1000000ULL, false);
  timerAlarmEnable(wdtTimer);

  Serial.printf("[net] boot, reset reason: %s\n", reason);
  Item& it = newItem(Kind::Event);
  strncpy(it.event, "boot", sizeof it.event - 1);
  strncpy(it.reason, reason, sizeof it.reason - 1);

  startConnect();
  started = true;
}

void netLoop() {
  if (!started) return;
  timerWrite(wdtTimer, 0);        // feed the watchdog: "still alive"
  wifiService();
  sendService();
}

bool netIsConnected() { return WiFi.status() == WL_CONNECTED; }

bool sendTelemetry(const Telemetry& t) {
  if (!started) return false;
  Item& it = newItem(Kind::Telemetry);
  it.t = t;
  return true;
}

bool sendEvent(const char* event) {
  if (!started) return false;
  Item& it = newItem(Kind::Event);
  strncpy(it.event, event, sizeof it.event - 1);
  return true;
}

size_t   netQueued()   { return qCount; }
uint32_t netDropped()  { return dropped; }
uint32_t netRejected() { return rejected; }
