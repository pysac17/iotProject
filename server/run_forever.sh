#!/usr/bin/env bash
# Person 2: runs the server for the 72-hour test.
#   - restarts it within 5 s if it ever crashes
#   - keeps the Mac awake (caffeinate) while it runs
#   - logs every restart to data/restarts.log
# Start:  ./run_forever.sh        Stop: Ctrl+C
cd "$(dirname "$0")" || exit 1
mkdir -p data

if command -v caffeinate >/dev/null 2>&1; then
  # -d display, -i idle, -m disk, -s system sleep (on AC power); ends when this script ends
  caffeinate -dims -w $$ &
  echo "caffeinate on: the Mac will not sleep while this runs (keep it plugged in)"
fi

trap 'echo "stopped by user"; exit 0' INT TERM
while true; do
  node server.js
  code=$?
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) server exited with code $code, restarting in 5 s" | tee -a data/restarts.log
  sleep 5
done
