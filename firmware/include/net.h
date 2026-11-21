#pragma once
#include <Arduino.h>
#include "telemetry.h"

// Person 2: Wi-Fi link and sending data to the server.
//
// Interface agreed between Person 1 and Person 2. main.cpp has weak placeholder
// versions so the firmware builds without net.cpp; the real ones in net.cpp
// replace them automatically.
//
// How Person 1 uses it from main.cpp:
//   setup():  netBegin();
//   loop():   netLoop();                       // every pass, never blocks for long
//             every 10 s:  sendTelemetry(t);    // t = the filled-in Telemetry struct
//             on a button: sendEvent("distraction");  // or "session_start" / "session_stop"
//
// Reliability (for the 72-hour test):
//   - Every message goes into an offline queue first and is sent from netLoop().
//     If Wi-Fi or the server is down, messages wait (up to NET_QUEUE_SLOTS of them,
//     about 66 minutes at one message every 10 s) and are sent in order later.
//     If the queue fills, the OLDEST message is dropped and counted in "dropped".
//   - Each message is timestamped from when it was CREATED, not when it was sent,
//     so late messages land at the right place in the history.
//   - At start-up a "boot" event is queued with the reset reason
//     (power_on, brownout, panic, task_watchdog, ...), which explains reboots.
//   - A watchdog (hardware timer) reboots the ESP32 if loop() stops calling netLoop()
//     for 30 s; the next boot event then says reason "app_watchdog".
//   - Wi-Fi reconnects by itself with backoff (2 s, 4 s ... 60 s).
//   - SERVER_URL may be http:// or https://. For https:// define SERVER_ROOT_CA
//     (the server's root certificate, PEM) in secrets.h.
//
// sendTelemetry() adds device, ts, seq, rssi_dbm, uptime_s, free_heap, queued and dropped.

constexpr size_t NET_QUEUE_SLOTS = 400;    // 400 x 10 s = about 66 minutes offline

void     netBegin();                        // called once from setup()
void     netLoop();                         // called every loop(); feeds the watchdog
bool     netIsConnected();                  // Wi-Fi up?

bool     sendTelemetry(const Telemetry& t); // true = queued for sending (false = not started)
bool     sendEvent(const char* event);      // "session_start", "session_stop" or "distraction"

size_t   netQueued();                       // messages waiting to be sent
uint32_t netDropped();                      // messages lost because the queue was full
uint32_t netRejected();                     // messages the server refused (bad data / key)
