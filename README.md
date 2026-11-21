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

1. Copy `firmware/include/secrets.example.h` to `firmware/include/secrets.h` and fill in the Wi-Fi name and password,
   `SERVER_URL` (`http://<laptop IP>:8080`) and `DEVICE_API_KEY`.
2. Create `server/.env` with `PORT=8080` and `DEVICE_API_KEYS=<the same key>`.
3. Never commit `secrets.h` or `.env` (they are in `.gitignore`).

## Running

| What | Command (from `server/`) |
| --- | --- |
| Start the server (dashboard at http://localhost:8080) | `npm start` |
| Start it for the 72-hour test (auto-restart, Mac stays awake) | `npm run forever` |
| API tests (server must be running) | `npm test` |
| Reliability report from the logs | `npm run report` (options: `-- --from <ISO> --to <ISO> --interval 10`) |
| Check the report logic against a simulated run | `npm run test:reliability` |

Firmware: build and upload with PlatformIO from the repo root.

## Server API

| Endpoint | What it returns |
| --- | --- |
| `POST /api/telemetry` | Stores a reading or event. Needs the `X-Device-Key` header. 200 = stored (or a duplicate already stored), 400 = bad data, 401 = bad key, 429 = too many. |
| `GET /api/latest?device=g20-desk-01` | Newest reading, plus `online` (a reading in the last 60 s) and `age_s` |
| `GET /api/history?device=g20-desk-01&minutes=60` | Readings and events in that window, oldest first, by device time |
| `GET /api/reliability?device=g20-desk-01&hours=72&interval=10` | Uptime, messages expected vs received, gaps with causes, reboots, server downtime, health |
| `GET /health` | Server is up |

Data is stored as append-only JSON Lines in `server/data/` (`telemetry.jsonl`, `events.jsonl`,
`server.jsonl` for server start / heartbeat / stop).

## Reliability features

- **Offline queue (device):** every message is queued first and sent from `netLoop()`. If Wi-Fi or the server is down,
  up to 400 messages (about 66 minutes at 10 s) wait and are sent in order later, stamped with the time they were taken.
- **Watchdog (device):** reboots the ESP32 if `loop()` stalls for 30 s.
- **Boot events (device):** every start sends a `boot` event with the reset reason (`power_on`, `brownout`, `panic`, `app_watchdog`, ...).
- **Health fields (device):** `rssi_dbm`, `uptime_s`, `free_heap`, `queued`, `dropped` in every reading.
- **Wi-Fi reconnect (device):** automatic, with backoff from 2 s up to 60 s.
- **Gap and duplicate detection (server):** sequence numbers per boot; duplicates are acknowledged but stored once.
- **Server heartbeat (server):** a line in `data/server.jsonl` every 60 s, so the report can tell server downtime from device downtime.

See [`docs/RELIABILITY_TEST.md`](docs/RELIABILITY_TEST.md) for running the 72-hour test and [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for fixing problems.
