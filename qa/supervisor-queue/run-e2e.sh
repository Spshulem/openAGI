#!/bin/bash
# Two-device Supervisor chat queue QA on one Mac (simulator iPhone + Mac
# client code), against an isolated QA hub. Synthetic data; never touches
# ~/.openagi or the owner's main. See README.md.
#   qa/supervisor-queue/run-e2e.sh <out-dir> <simulator-udid> <lan-ip>
set -euo pipefail
OUT=$1; SIM=$2; HOST=$3; PORT=${PORT:-47811}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
NODE=${NODE:-$HOME/.nvm/versions/node/v22.21.1/bin/node}
DEV=/Applications/Xcode-beta.app/Contents/Developer
mkdir -p "$OUT"; rm -f "$OUT"/*.jsonl "$OUT"/hub.json

echo "== build Mac tests"; (cd "$REPO/mac" && nice swift build --build-tests >"$OUT/mac-build.log" 2>&1)
echo "== build iOS tests"; (cd "$REPO/mobile/ios" && /opt/homebrew/bin/xcodegen generate -q && \
  DEVELOPER_DIR=$DEV nice xcodebuild -project OpenAGI.xcodeproj -scheme OpenAGI -configuration Debug \
  -destination "id=$SIM" -derivedDataPath /tmp/openagi-e2e-ios build-for-testing >"$OUT/ios-build.log" 2>&1)
xcrun simctl boot "$SIM" 2>/dev/null || true

echo "== start hub"
(cd "$REPO" && exec "$NODE" qa/supervisor-queue/hub.mjs --host "$HOST" --port "$PORT" --out "$OUT" --slow-ms 20000 >"$OUT/hub.log" 2>&1) &
HUB=$!
trap 'kill $HUB 2>/dev/null || true' EXIT
for _ in $(seq 1 600); do [ -s "$OUT/hub.json" ] && break; sleep 0.2; done
[ -s "$OUT/hub.json" ] || { echo "hub did not start"; cat "$OUT/hub.log"; exit 1; }
URL=$("$NODE" -e 'console.log(require(process.argv[1]).url)' "$OUT/hub.json")
OWNER=$("$NODE" -e 'console.log(require(process.argv[1]).ownerToken)' "$OUT/hub.json")
PID=$("$NODE" -e 'console.log(require(process.argv[1]).phone.id)' "$OUT/hub.json")
PTOKEN=$("$NODE" -e 'console.log(require(process.argv[1]).phone.token)' "$OUT/hub.json")
T0=$(( $(date +%s) * 1000 + 75000 ))
echo "== hub $URL, T0 $T0"

( DEVELOPER_DIR=$DEV TEST_RUNNER_OPENAGI_E2E_HUB=$URL TEST_RUNNER_OPENAGI_E2E_PHONE_ID=$PID \
  TEST_RUNNER_OPENAGI_E2E_PHONE_TOKEN=$PTOKEN TEST_RUNNER_OPENAGI_E2E_OUT=$OUT TEST_RUNNER_OPENAGI_E2E_T0=$T0 \
  xcodebuild -project "$REPO/mobile/ios/OpenAGI.xcodeproj" -scheme OpenAGI -destination "id=$SIM" \
  -derivedDataPath /tmp/openagi-e2e-ios -only-testing:OpenAGITests/CrossDeviceQueueE2ETests test-without-building \
  >"$OUT/ios-test.log" 2>&1; echo "ios exit $?" >>"$OUT/ios-test.log" ) &
IOS=$!
( cd "$REPO/mac" && OPENAGI_E2E_HUB=$URL OPENAGI_E2E_OWNER_TOKEN=$OWNER OPENAGI_E2E_OUT=$OUT OPENAGI_E2E_T0=$T0 \
  swift test --skip-build --filter CrossDeviceQueueE2ETests >"$OUT/mac-test.log" 2>&1; echo "mac exit $?" >>"$OUT/mac-test.log" ) &
MAC=$!
wait $IOS $MAC || true
curl -s -H "Authorization: Bearer $OWNER" "$URL/conversations/supervisor/messages?limit=100" >"$OUT/history.json"
curl -s -H "Authorization: Bearer $OWNER" "$URL/conversations/supervisor/queue" >"$OUT/hub-queue.json" || true
grep -E "passed|failed|skipped|exit" "$OUT/ios-test.log" "$OUT/mac-test.log" | grep -E "Test Case|exit" | tail -6
