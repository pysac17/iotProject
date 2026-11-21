# On-call runbook

How to tell what is wrong and fix it, starting from what you see.

| What you see | Most likely cause | Check | Fix |
| --- | --- | --- | --- |
| Dashboard says "offline" | Device has no power, no Wi-Fi, or cannot reach the server | Is the OLED on? Serial Monitor shows `[net]` lines? | Power: replug. Wi-Fi: router on? Server: see next rows. The device queues about 66 minutes of data and sends it when the link is back. |
| Serial: `POST failed: -1` or `connection refused` | Server not running, wrong `SERVER_URL`, or the Mac firewall blocks Node | `curl http://<laptop IP>:8080/health` from the laptop | Start the server (`npm run forever`); fix the IP in `secrets.h`; allow Node in System Settings > Network > Firewall |
| Serial: `POST failed: 401` | Device key does not match | `DEVICE_API_KEY` in `secrets.h` vs `DEVICE_API_KEYS` in `server/.env` | Make them identical, re-upload |
| Serial: `POST failed: 400` | Firmware sends a field the server rejects | The error text lists the field | Fix the firmware or the validation in `server.js`; rejected messages are not retried |
| Serial: `skipped` / no sends, `clock not set` | Network has no internet, so NTP cannot set the clock | `[net] clock set` never appears | Use a network with internet access; messages wait in the queue meanwhile |
| Laptop IP is `192.0.0.2` on a phone hotspot | Phone gives the Mac IPv6 only | `ifconfig en0` | `networksetup -setv6off Wi-Fi` then `sudo ipconfig set en0 DHCP` |
| Boot events with `brownout` | Power supply dips (servo, weak adapter or cable) | Reliability report reboot list | Better 5 V adapter and cable; check the 470 uF capacitor on the 5 V rail |
| Boot events with `app_watchdog` or `panic` | Firmware hang or crash | Times in the report; Serial output if connected | Reproduce with the Serial Monitor attached; check the last code change |
| `free_heap` keeps falling | Memory leak in the firmware | Report "Free RAM" change | Look for `String` building or `new` in loops |
| Gaps whose cause is "server was not running" | Laptop slept, crashed or was closed | `data/server.jsonl` heartbeat gaps, `data/restarts.log` | Use `npm run forever` (keeps the Mac awake), keep it on AC power |
