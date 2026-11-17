#pragma once
#include "telemetry.h"
#include <Arduino.h>

// Person 2: Wi-Fi link and sending data to the server.
//
// Interface agreed between Person 1 and Person 2. main.cpp has weak placeholder
// versions so the firmware builds without net.cpp; the real ones in net.cpp
// replace them automatically.
//
// How Person 1 uses it from main.cpp:
//   setup():  netBegin();
//   loop():   netLoop();                       // every pass, never blocks
//             every 30 s:  sendTelemetry(t);    // t = the filled-in Telemetry
//             struct on a button: sendEvent("distraction");  // or
//             "session_start" / "session_stop"
//
// sendTelemetry() adds device, ts, seq, rssi_dbm, uptime_s and free_heap
// itself.
//
// Done so far: Wi-Fi connect + automatic reconnect with backoff, clock sync
// (NTP),
//              JSON in the Data schema format, HTTP POST with the device key.
// Still to do:  HTTPS (WiFiClientSecure + root cert), offline buffer, watchdog.

void netBegin(); // called once from setup()
void netLoop();  // called every loop(); non-blocking
bool netIsConnected();

bool sendTelemetry(const Telemetry &t); // true when the server answered 200
bool sendEvent(
    const char *event); // "session_start", "session_stop" or "distraction"

// Builds the telemetry JSON into buf. Returns its length (0 if buf was too
// small).
size_t telemetryToJson(const Telemetry &t, uint32_t seq, const char *ts,
                       char *buf, size_t len);