# Desk Environment and Focus Timer

CS 244P IoT project, Group 20. ESP32 desk device that senses light, temperature and motion,
sends telemetry over Wi-Fi to a Node.js server, and shows AI break advice on a web dashboard.

## Layout

| Folder | What it is |
| --- | --- |
| `firmware/` | ESP32 code (PlatformIO; `platformio.ini` is at the repo root) |
| `server/` | Node.js ingestion API, database and daily AI job |
| `dashboard/` | Web dashboard front end |

## Who owns what

| Person | Files |
| --- | --- |
| Person 1: ESP32 sensing and on-device logic | `firmware/src/sensors.cpp`, `motion.cpp`, `focus_state.cpp`, `ui.cpp`, `main.cpp` |
| Person 2: ESP32 networking and server API | `firmware/src/net.cpp`, `server/server.js`, `server/db.js` |
| Person 3: AI and dashboard | `server/ai_job.js`, `dashboard/*` |

## Agreements between the parts

- **Person 1 and Person 2:** `firmware/include/telemetry.h` holds the `Telemetry` struct.
  Person 1 fills it in; Person 2's `sendTelemetry()` turns it into JSON.
- **Person 2 and Person 3:** the server exposes `GET /api/latest`, `GET /api/history` and
  `GET /api/advice`. Return sample data first so the dashboard can be built right away.
- The JSON format is in the progress report's Data schema section.

## Setup

1. Copy `firmware/include/secrets.example.h` to `firmware/include/secrets.h` and fill in your Wi-Fi and server details.
2. Copy `server/.env.example` to `server/.env` and fill in the keys.
3. Never commit `secrets.h` or `.env` (they are in `.gitignore`).
# iotProject
# iotProject
