#pragma once
// Person 1: focused / restless / away state machine and session timer.
#include <Arduino.h>
#include "telemetry.h"

namespace FocusCfg {
  // Starting values; calibrate them from the serial log on the real desk.
  constexpr int      DARK_LIGHT_PCT      = 8;       // below this the lights are off -> away
  constexpr float    STILL_RMS_G         = 0.006f;  // a second quieter than this counts as "still"
  constexpr float    RESTLESS_RMS_G      = 0.050f;  // 30 s RMS above this -> restless
  constexpr int      RESTLESS_SPIKES     = 8;       // or this many spikes in 30 s -> restless
  constexpr int      WINDOW_S            = 30;      // rolling window for the restless check
  constexpr uint32_t HOLD_S              = 5;       // a new state must hold this long before switching
  constexpr uint32_t AWAY_AFTER_STILL_S  = 180;     // this long with no motion -> away
  constexpr uint32_t BREAK_AFTER_S       = 25 * 60; // focus time before the first break alert
  constexpr uint32_t BREAK_REMIND_S      = 5 * 60;  // repeat the alert this often until a break
  constexpr uint32_t BREAK_RESET_AWAY_S  = 120;     // away this long = a break was taken
  constexpr uint32_t AUTO_STOP_AWAY_S    = 10 * 60; // away this long ends the session
}

struct FocusInputs {
  int   lightPct;
  bool  motionOk;   // false if the MPU-6050 is missing; falls back to light + session
  float rmsG;       // last second
  int   spikes;     // last second
};

// Event bits returned by focusUpdate()
constexpr uint8_t FOCUS_EV_STATE_CHANGED   = 0x01;
constexpr uint8_t FOCUS_EV_BREAK_DUE       = 0x02;
constexpr uint8_t FOCUS_EV_SESSION_STOPPED = 0x04;  // auto-stopped because the user left

void       focusBegin();
uint8_t    focusUpdate(const FocusInputs& in, uint32_t nowMs);  // call once per second

FocusState focusState();
const char* focusStateName(FocusState s);  // "focused" / "restless" / "away" (JSON values)

void       focusStartSession();
void       focusStopSession();
bool       focusSessionActive();
uint32_t   focusSessionS();       // time present (not away) in the current session; 0 if none
uint32_t   focusSecondsToBreak(); // until the next break alert; 0 if no session
