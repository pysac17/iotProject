// Person 1: see include/motion.h
#include "motion.h"

namespace {

struct Accumulator {
  double   sumSq;
  uint32_t n;
  int      spikes;

  void reset() { sumSq = 0; n = 0; spikes = 0; }
  void add(float d) { sumSq += (double)d * d; n++; }
  MotionStats take() {
    MotionStats s;
    s.rmsG    = n ? (float)sqrt(sumSq / n) : 0.0f;
    s.spikes  = spikes;
    s.samples = n;
    reset();
    return s;
  }
};

Accumulator secondAcc;
Accumulator windowAcc;
float baseline     = 1.0f;
bool  haveBaseline = false;
bool  spikeArmed   = true;

}  // namespace

void motionBegin() {
  secondAcc.reset();
  windowAcc.reset();
  haveBaseline = false;
  spikeArmed   = true;
}

void motionAddSample(const AccelSample& s) {
  float mag = sqrtf(s.x * s.x + s.y * s.y + s.z * s.z);  // orientation-independent
  if (!haveBaseline) {
    baseline     = mag;
    haveBaseline = true;
  }
  float d = mag - baseline;                 // dynamic part (gravity removed)
  baseline += MotionCfg::BASELINE_ALPHA * d;

  secondAcc.add(d);
  windowAcc.add(d);

  float ad = fabsf(d);
  if (spikeArmed && ad > MotionCfg::SPIKE_G) {
    spikeArmed = false;
    secondAcc.spikes++;
    windowAcc.spikes++;
  } else if (!spikeArmed && ad < MotionCfg::SPIKE_REARM_G) {
    spikeArmed = true;
  }
}

MotionStats motionTakeSecond() { return secondAcc.take(); }
MotionStats motionTakeWindow() { return windowAcc.take(); }
