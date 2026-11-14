// Person 1: non-blocking main loop that ties the modules together (no delay() in loop()).
#include <Arduino.h>

#include "sensors.h"
#include "motion.h"
#include "focus_state.h"
#include "ui.h"
#include "net.h"
#include "telemetry.h"

namespace {

// Fixed-rate timer that does not drift and does not burst after a long stall.
struct Every {
  uint32_t periodMs;
  uint32_t lastMs;
  bool due(uint32_t nowMs) {
    if (nowMs - lastMs < periodMs) return false;
    lastMs += periodMs;
    if (nowMs - lastMs >= periodMs) lastMs = nowMs;  // fell behind (e.g. slow HTTPS): resync
    return true;
  }
};

Every motionTick    {1000 / MOTION_SAMPLE_HZ, 0};  // 20 ms -> 50 Hz
Every secondTick    {1000, 0};
Every drawTick      {250, 0};
Every telemetryTick {30000, 0};

int         lightPct     = 0;
float       tempC        = NAN;  // last good reading
MotionStats lastSecond   = {0, 0, 0};
int         distractions = 0;

void everySecond(uint32_t nowMs) {
  lightPct = sensorsReadLightPct();
  float t = sensorsReadTempC();
  if (!isnan(t)) tempC = t;
  else if (!sensorsBmpOk()) tempC = NAN;

  lastSecond = motionTakeSecond();

  FocusInputs in;
  in.lightPct = lightPct;
  in.motionOk = sensorsMpuOk() && lastSecond.samples > 0;
  in.rmsG     = lastSecond.rmsG;
  in.spikes   = lastSecond.spikes;

  uint8_t ev = focusUpdate(in, nowMs);
  uiSetState(focusState(), nowMs);

  if (ev & FOCUS_EV_STATE_CHANGED) {
    Serial.printf("[focus] -> %s\n", focusStateName(focusState()));
  }
  if (ev & FOCUS_EV_BREAK_DUE) {
    Serial.println("[focus] break due");
    uiStartBreakAlert(nowMs);
  }
  if (ev & FOCUS_EV_SESSION_STOPPED) {
    Serial.println("[focus] session auto-stopped (away)");
    sendEvent("session_stop");
  }

  // One line per second for calibrating the thresholds in focus_state.h / motion.h
  Serial.printf("light=%d temp=%.1f rms=%.4f spikes=%d n=%lu state=%s session=%lu\n",
                lightPct, tempC, lastSecond.rmsG, lastSecond.spikes,
                (unsigned long)lastSecond.samples, focusStateName(focusState()),
                (unsigned long)focusSessionS());
}

void handleButtons(uint32_t nowMs) {
  for (ButtonEvent e = uiTakeButton(); e != ButtonEvent::None; e = uiTakeButton()) {
    if (e == ButtonEvent::SessionToggle) {
      if (focusSessionActive()) {
        focusStopSession();
        uiPlay(Sound::SessionStop, nowMs);
        sendEvent("session_stop");
      } else {
        focusStartSession();
        distractions = 0;
        uiSetState(focusState(), nowMs);
        uiPlay(Sound::SessionStart, nowMs);
        sendEvent("session_start");
      }
    } else if (e == ButtonEvent::Distraction) {
      distractions++;
      uiPlay(Sound::Distraction, nowMs);
      sendEvent("distraction");
    }
  }
}

void drawScreen() {
  UiView v;
  v.state          = focusState();
  v.sessionActive  = focusSessionActive();
  v.sessionS       = focusSessionS();
  v.secondsToBreak = focusSecondsToBreak();
  v.distractions   = distractions;
  v.lightPct       = lightPct;
  v.tempC          = tempC;
  v.motionOk       = sensorsMpuOk();
  v.motionRmsG     = lastSecond.rmsG;
  v.motionSpikes   = lastSecond.spikes;
  uiDraw(v);
}

void sendTelemetryNow() {
  MotionStats w = motionTakeWindow();  // everything since the last telemetry message
  Telemetry t;
  t.lightPct     = lightPct;
  t.tempC        = tempC;              // NAN if the BMP280 is missing; net.cpp should send null
  t.motionRmsG   = w.rmsG;
  t.motionSpikes = w.spikes;
  t.state        = focusState();
  t.sessionS     = focusSessionS();
  sendTelemetry(t);
}

}  // namespace

void setup() {
  Serial.begin(115200);
  Serial.println("\n[main] Desk focus timer starting");
  uiBegin();
  sensorsBegin();
  motionBegin();
  focusBegin();
  netBegin();

  uint32_t now = millis();
  motionTick.lastMs = secondTick.lastMs = drawTick.lastMs = telemetryTick.lastMs = now;
}

void loop() {
  uint32_t now = millis();

  if (motionTick.due(now)) {
    AccelSample a;
    if (sensorsReadAccel(a)) motionAddSample(a);
  }

  uiLoop(now);
  handleButtons(now);

  if (secondTick.due(now))    everySecond(now);
  if (drawTick.due(now))      drawScreen();
  if (telemetryTick.due(now)) sendTelemetryNow();

  sensorsService(now);
  netLoop();
}

// -----------------------------------------------------------------------------
// Placeholder networking until Person 2's net.cpp defines these. They are weak,
// so the real versions in net.cpp replace them with no change here.
// -----------------------------------------------------------------------------
__attribute__((weak)) void netBegin() {
  Serial.println("[net] placeholder: net.cpp not implemented yet");
}

__attribute__((weak)) void netLoop() {}

__attribute__((weak)) bool sendTelemetry(const Telemetry& t) {
  Serial.printf("[net] telemetry light=%d temp=%.1f rms=%.4f spikes=%d state=%s session=%lu\n",
                t.lightPct, t.tempC, t.motionRmsG, t.motionSpikes,
                focusStateName(t.state), (unsigned long)t.sessionS);
  return false;
}

__attribute__((weak)) bool sendEvent(const char* event) {
  Serial.printf("[net] event %s\n", event);
  return false;
}
