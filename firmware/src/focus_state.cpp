// Person 1: see include/focus_state.h
#include "focus_state.h"

using namespace FocusCfg;

namespace {

FocusState state    = FocusState::Away;
FocusState pending  = FocusState::Away;
uint32_t   pendingS = 0;

// Rolling window of per-second motion stats
float   ringSq[WINDOW_S];
uint8_t ringSpikes[WINDOW_S];
int     ringIdx   = 0;
int     ringCount = 0;

uint32_t stillS   = 0;   // consecutive still seconds
uint32_t awayMs   = 0;   // time continuously in Away
bool     haveLast = false;
uint32_t lastMs   = 0;

bool     sessionOn   = false;
uint32_t sessionMs   = 0;  // present time in the session
uint32_t blockMs     = 0;  // present time since the last break
uint32_t nextBreakS  = BREAK_AFTER_S;

void clearWindow() {
  ringIdx = ringCount = 0;
  stillS = 0;
}

FocusState candidate(const FocusInputs& in) {
  if (in.lightPct < DARK_LIGHT_PCT) return FocusState::Away;

  if (!in.motionOk) {
    // No IMU: assume present while a session runs.
    clearWindow();
    return sessionOn ? FocusState::Focused : FocusState::Away;
  }

  ringSq[ringIdx]     = in.rmsG * in.rmsG;
  ringSpikes[ringIdx] = (uint8_t)min(in.spikes, 255);
  ringIdx = (ringIdx + 1) % WINDOW_S;
  if (ringCount < WINDOW_S) ringCount++;

  float sumSq = 0;
  int   spikes = 0;
  for (int i = 0; i < ringCount; i++) {
    sumSq  += ringSq[i];
    spikes += ringSpikes[i];
  }
  float windowRms = sqrtf(sumSq / ringCount);

  bool stillSecond = in.rmsG < STILL_RMS_G && in.spikes == 0;
  stillS = stillSecond ? stillS + 1 : 0;

  if (windowRms >= RESTLESS_RMS_G || spikes >= RESTLESS_SPIKES) return FocusState::Restless;
  if (stillS >= AWAY_AFTER_STILL_S) return FocusState::Away;
  if (stillSecond && state == FocusState::Away) return FocusState::Away;  // still and already away
  return FocusState::Focused;
}

}  // namespace

void focusBegin() {
  state = pending = FocusState::Away;
  pendingS = 0;
  clearWindow();
  awayMs = 0;
  haveLast = false;
  sessionOn = false;
}

uint8_t focusUpdate(const FocusInputs& in, uint32_t nowMs) {
  uint32_t dt = haveLast ? nowMs - lastMs : 0;
  lastMs = nowMs;
  haveLast = true;
  uint8_t ev = 0;

  // ---- state with hysteresis ----
  FocusState cand = candidate(in);
  if (cand == state) {
    pendingS = 0;
  } else {
    if (cand != pending) {
      pending  = cand;
      pendingS = 0;
    }
    if (++pendingS >= HOLD_S) {
      state    = cand;
      pendingS = 0;
      ev |= FOCUS_EV_STATE_CHANGED;
    }
  }

  // ---- timers ----
  awayMs = (state == FocusState::Away) ? awayMs + dt : 0;

  if (sessionOn) {
    if (state != FocusState::Away) {
      sessionMs += dt;
      blockMs   += dt;
    }
    if (awayMs >= BREAK_RESET_AWAY_S * 1000UL && blockMs > 0) {
      blockMs    = 0;  // they stepped away long enough: that was a break
      nextBreakS = BREAK_AFTER_S;
    }
    if (blockMs / 1000 >= nextBreakS) {
      ev |= FOCUS_EV_BREAK_DUE;
      nextBreakS += BREAK_REMIND_S;
    }
    if (awayMs >= AUTO_STOP_AWAY_S * 1000UL) {
      focusStopSession();
      ev |= FOCUS_EV_SESSION_STOPPED;
    }
  }
  return ev;
}

FocusState focusState() { return state; }

const char* focusStateName(FocusState s) {
  switch (s) {
    case FocusState::Focused:  return "focused";
    case FocusState::Restless: return "restless";
    default:                   return "away";
  }
}

void focusStartSession() {
  sessionOn  = true;
  sessionMs  = 0;
  blockMs    = 0;
  nextBreakS = BREAK_AFTER_S;
  awayMs     = 0;
  // Pressing the button proves someone is at the desk.
  if (state == FocusState::Away) {
    state = pending = FocusState::Focused;
    pendingS = 0;
    stillS   = 0;
  }
}

void focusStopSession() { sessionOn = false; }

bool focusSessionActive() { return sessionOn; }

uint32_t focusSessionS() { return sessionOn ? sessionMs / 1000 : 0; }

uint32_t focusSecondsToBreak() {
  if (!sessionOn) return 0;
  uint32_t blockS = blockMs / 1000;
  return nextBreakS > blockS ? nextBreakS - blockS : 0;
}
