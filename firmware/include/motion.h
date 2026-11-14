#pragma once
// Person 1: motion level and spike count from the 50 Hz MPU-6050 readings.
#include <Arduino.h>
#include "sensors.h"

constexpr uint32_t MOTION_SAMPLE_HZ = 50;

namespace MotionCfg {
  // Gravity is removed by tracking the slow average of |a| (time constant ~1 s at 50 Hz).
  constexpr float BASELINE_ALPHA = 0.02f;
  // A spike is a jump in |a| above SPIKE_G; it re-arms once the signal falls below SPIKE_REARM_G.
  // Tune both by watching the serial log while bumping the desk.
  constexpr float SPIKE_G        = 0.10f;
  constexpr float SPIKE_REARM_G  = 0.05f;
}

struct MotionStats {
  float    rmsG;     // RMS of |a| minus gravity, in g
  int      spikes;   // movement spikes counted in the interval
  uint32_t samples;  // samples that went into it (0 = no IMU data)
};

void        motionBegin();
void        motionAddSample(const AccelSample& s);  // call at 50 Hz
MotionStats motionTakeSecond();  // stats since the last call, then reset (state machine, 1 Hz)
MotionStats motionTakeWindow();  // stats since the last call, then reset (telemetry, every 30 s)
