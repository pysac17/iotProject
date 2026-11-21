# 72-hour reliability test

The device and the server run untouched for at least 72 hours. Everything the Final Report needs
(uptime, messages expected vs received, every gap and its cause) is computed from the server's logs
by `npm run report`. Current draw is measured by hand with a USB power meter.

## Before the test (about 1 hour)

1. **Pick the place.** Reliable power, a Wi-Fi network you control (home router, not a phone hotspot,
   not UCInet/eduroam), and somewhere nobody will unplug things.
2. **Server laptop.** Plugged into the wall, on the same Wi-Fi, lid open (or closed with an external
   display), macOS updates postponed. Note its IP: `ipconfig getifaddr en0`. If the router lets you,
   reserve that IP for the laptop so it cannot change mid-test.
3. **Firmware.** In `firmware/include/secrets.h` set the home Wi-Fi, `SERVER_URL "http://<laptop IP>:8080"`
   and the device key. Pull the latest `main`, upload, and note the commit (`git log -1 --oneline`).
4. **Device power.** A USB wall adapter (5 V, at least 1 A), not the laptop's USB port.
   Put the USB power meter between the adapter and the ESP32 cable.
5. **Rehearsal (30-60 min, optional but recommended).** Start the server, check data arrives, then
   prove recovery once: turn the router off for 5 minutes, stop the server for 5 minutes, unplug the
   ESP32 for 1 minute. Run `npm run report` and check each shows up with the right cause.
   Keep this report for the write-up, separate from the 72-hour run.
6. **Clean start.** Stop the server and move the rehearsal data aside (`mv server/data server/data-rehearsal`).

## Start

```
cd server
npm run forever          # restarts the server if it crashes, keeps the Mac awake
```
Then plug in the ESP32. Within a minute, http://localhost:8080 shows it online.
Write down the exact start time (UTC: `date -u`).

## During the test

Do not touch anything. Check the dashboard (or `curl -s localhost:8080/api/reliability?hours=72`)
two or three times a day **without** changing anything, and note what you see. If something does
go wrong, write down the time and what you saw; that note is the "cause" in the report.

## End

1. Note the end time (UTC), then stop the server with Ctrl+C.
2. Generate the report for exactly the test window:
   ```
   npm run report -- --from <start UTC> --to <end UTC>
   ```
   This writes `server/data/reliability_report.md`, `reliability_report.json` and `gaps.csv`.
3. Copy the whole `server/data/` folder somewhere safe and share it with the team (it is not in Git).

## Current measurements (USB power meter)

Prediction from the Progress Report: about **82 mA at 5 V** on average, at one message every 30 s.
The firmware now sends every 10 s, so expect about 3 mA more from extra transmissions.

| State | How to get it | Record |
| --- | --- | --- |
| Normal sensing, OLED on | just running | mA, read over about 1 minute |
| Sending | watch the meter at a send (every 10 s) | peak mA if the meter shows it |
| Buzzer / break alert | trigger a break alert | mA |
| Wi-Fi reconnecting | router off for 1 minute | mA |
| Whole test | the meter's mAh counter | total mAh / hours = true average mA |

The last row is the most useful number: total mAh divided by test hours gives the real average,
to compare with the 82 mA prediction.
