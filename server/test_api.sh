#!/usr/bin/env bash
# Person 2: quick checks for the ingestion API. Start the server first: npm start
# Usage: ./test_api.sh [base-url] [device-key]
BASE=${1:-http://localhost:8080}
KEY=${2:-change-me}
DEV=test-desk-$$                      # a fresh test device so real data is not mixed in
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PASS=0; FAIL=0

post() { curl -s -X POST "$BASE/api/telemetry" -H "Content-Type: application/json" -H "X-Device-Key: $1" -d "$2"; }
check() { # name, expected substring, actual
  if [[ "$3" == *"$2"* ]]; then PASS=$((PASS+1)); echo "PASS  $1"; else FAIL=$((FAIL+1)); echo "FAIL  $1"; echo "      expected to contain: $2"; echo "      got: $3"; fi
}
T() { echo "{\"device\":\"$DEV\",\"ts\":\"$TS\",\"seq\":$1,\"light_pct\":56,\"temp_c\":$2,\"motion_rms_g\":0.031,\"motion_spikes\":3,\"state\":\"focused\",\"session_s\":1520,\"rssi_dbm\":-58,\"uptime_s\":86400,\"free_heap\":182340,\"queued\":0,\"dropped\":0}"; }

check "1. Boot event with reset reason"      '"ok":true' "$(post $KEY "{\"device\":\"$DEV\",\"ts\":\"$TS\",\"seq\":1,\"event\":\"boot\",\"reason\":\"power_on\",\"uptime_s\":0}")"
check "2. Valid telemetry"                   '"ok":true' "$(post $KEY "$(T 2 24.6)")"
check "3. Button event"                      '"kind":"event"' "$(post $KEY "{\"device\":\"$DEV\",\"ts\":\"$TS\",\"seq\":3,\"event\":\"distraction\"}")"
check "4. Gap: seq 3 -> 6 reports 2 missed"  '"missed":2' "$(post $KEY "$(T 6 25.1)")"
check "5. Same message again = duplicate"    '"duplicate":true' "$(post $KEY "$(T 6 25.1)")"
check "6. BMP280 missing (temp_c null)"      '"ok":true' "$(post $KEY "$(T 7 null)")"
check "7. Wrong key rejected (401)"          'unknown X-Device-Key' "$(post wrong '{}')"
check "8. Not JSON rejected"                 'not valid JSON' "$(post $KEY 'hello')"
check "9. Out-of-range values rejected"      'light_pct must be' "$(post $KEY "{\"device\":\"$DEV\",\"ts\":\"$TS\",\"seq\":8,\"light_pct\":150,\"temp_c\":24,\"motion_rms_g\":0.1,\"motion_spikes\":1,\"state\":\"sleepy\",\"session_s\":10}")"
check "10. Unknown event rejected"           'event must be one of' "$(post $KEY "{\"device\":\"$DEV\",\"ts\":\"$TS\",\"seq\":9,\"event\":\"unlock\"}")"
check "11. Reboot resets seq (no false gap)" '"missed":0' "$(post $KEY "{\"device\":\"$DEV\",\"ts\":\"$TS\",\"seq\":1,\"event\":\"boot\",\"reason\":\"brownout\"}")"
check "12. Latest reading, online"           '"online":true' "$(curl -s "$BASE/api/latest?device=$DEV")"
check "13. History for charts"               '"telemetry":[' "$(curl -s "$BASE/api/history?device=$DEV&minutes=60")"
check "14. Reliability summary"              '"uptime_pct"' "$(curl -s "$BASE/api/reliability?device=$DEV&hours=1")"
check "15. Server health"                    '"ok":true' "$(curl -s "$BASE/health")"

echo; echo "$PASS passed, $FAIL failed  (test device: $DEV)"
[ "$FAIL" -eq 0 ]
