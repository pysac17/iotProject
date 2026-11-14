#pragma once
#include "telemetry.h"
// Person 2: Wi-Fi, HTTPS, offline buffer, watchdog.
// Person 1 calls sendTelemetry() every 30 s and sendEvent() on button presses.
//
// Interface agreed between Person 1 and Person 2. main.cpp has weak placeholder
// versions so the firmware builds before net.cpp is written; defining these in
// net.cpp replaces them automatically.

void netBegin();   // called once from setup()
void netLoop();    // called every loop(); keep it non-blocking (reconnects, buffer flush)

// Person 2 adds device, ts, seq, rssi_dbm, uptime_s, free_heap.
// Use focusStateName(t.state) from focus_state.h for the "state" string.
bool sendTelemetry(const Telemetry& t);

// event is "session_start", "session_stop" or "distraction".
bool sendEvent(const char* event);
