#!/usr/bin/env bash
# Person 2: quick checks for the ingestion API. Start the server first: npm start
# Usage: ./test_api.sh [base-url] [device-key]
BASE=${1:-http://localhost:8080}
KEY=${2:-change-me}
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
show() { echo; echo "== $1"; }

show "1. Valid telemetry (expect 200)"
curl -s -X POST "$BASE/api/telemetry" -H "Content-Type: application/json" -H "X-Device-Key: $KEY" \
  -d "{\"device\":\"g20-desk-01\",\"ts\":\"$TS\",\"seq\":1,\"light_pct\":56,\"temp_c\":24.6,\"motion_rms_g\":0.031,\"motion_spikes\":3,\"state\":\"focused\",\"session_s\":1520,\"rssi_dbm\":-58,\"uptime_s\":86400,\"free_heap\":182340}"

show "2. Button event (expect 200)"
curl -s -X POST "$BASE/api/telemetry" -H "Content-Type: application/json" -H "X-Device-Key: $KEY" \
  -d "{\"device\":\"g20-desk-01\",\"ts\":\"$TS\",\"seq\":2,\"event\":\"distraction\"}"

show "3. Gap: seq jumps from 2 to 5 (expect 200 with missed: 2)"
curl -s -X POST "$BASE/api/telemetry" -H "Content-Type: application/json" -H "X-Device-Key: $KEY" \
  -d "{\"device\":\"g20-desk-01\",\"ts\":\"$TS\",\"seq\":5,\"light_pct\":40,\"temp_c\":25.1,\"motion_rms_g\":0.12,\"motion_spikes\":9,\"state\":\"restless\",\"session_s\":1610}"

show "4. Wrong key (expect 401)"
curl -s -X POST "$BASE/api/telemetry" -H "Content-Type: application/json" -H "X-Device-Key: wrong" -d '{}'

show "5. Not JSON (expect 400)"
curl -s -X POST "$BASE/api/telemetry" -H "Content-Type: application/json" -H "X-Device-Key: $KEY" -d 'hello'

show "6. Out-of-range values (expect 400 with a list of errors)"
curl -s -X POST "$BASE/api/telemetry" -H "Content-Type: application/json" -H "X-Device-Key: $KEY" \
  -d "{\"device\":\"g20-desk-01\",\"ts\":\"$TS\",\"seq\":6,\"light_pct\":150,\"temp_c\":24,\"motion_rms_g\":0.1,\"motion_spikes\":1,\"state\":\"sleepy\",\"session_s\":10}"

show "7. Latest reading (expect online: true)"
curl -s "$BASE/api/latest?device=g20-desk-01"

show "8. Last hour for charts"
curl -s "$BASE/api/history?device=g20-desk-01&minutes=60"
echo
