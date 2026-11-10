#pragma once
#include <Arduino.h>
// Shared between Person 1 (fills it in) and Person 2 (sends it as JSON).
// Fields match the progress report's Data schema.

enum class FocusState { Focused, Restless, Away };

struct Telemetry {
  int        lightPct;      // 0..100
  float      tempC;
  float      motionRmsG;
  int        motionSpikes;
  FocusState state;
  uint32_t   sessionS;
};
