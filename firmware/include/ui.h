#pragma once
// Person 1: OLED, status LEDs, buzzer and button.
//
// BUTTON_1: start / stop a focus session.   BUTTON_2: log a distraction.
// Any press while the break alert is showing just silences it.
// Any press while the screen is off just wakes it.
// LEDs: green = focused, yellow = restless, red = away, flashing red = break alert.
#include <Arduino.h>
#include "telemetry.h"

enum class ButtonEvent { None, SessionToggle, Distraction };
enum class Sound { SessionStart, SessionStop, Distraction };

struct UiView {
  FocusState state;
  bool       sessionActive;
  uint32_t   sessionS;
  uint32_t   secondsToBreak;
  int        distractions;
  int        lightPct;
  float      tempC;       // NAN = unknown
  bool       motionOk;
  float      motionRmsG;
  int        motionSpikes;
};

void        uiBegin();
void        uiLoop(uint32_t nowMs);          // call every loop: buttons, buzzer, LEDs, screen timeout
ButtonEvent uiTakeButton();                  // next queued press, or None
void        uiSetState(FocusState s, uint32_t nowMs);
void        uiDraw(const UiView& v);         // redraw the OLED (~4 Hz)
void        uiPlay(Sound s, uint32_t nowMs); // short non-blocking chirp
void        uiStartBreakAlert(uint32_t nowMs);
bool        uiAlertActive();
