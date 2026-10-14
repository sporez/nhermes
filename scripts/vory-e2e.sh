#!/bin/sh
# Runs stock Vory's gateway E2E tests (and optionally its UI E2E test) against a running gateway.
# usage: NHERMES_TOKEN=... scripts/vory-e2e.sh [url] [--ui]
# Needs Xcode with the iOS 27 SDK and the pinned Vory clone (scripts/fetch-upstream.sh).
set -eu
URL=${1:-http://127.0.0.1:9119}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VORY="$ROOT/reference/vory"
DD=${NH_VORY_DERIVED:-/tmp/nh-vory-dd}
UDID=$(xcrun simctl list devices | awk -F'[()]' '/NH Vory E2E/ {print $2; exit}')
if [ -z "$UDID" ]; then
  UDID=$(xcrun simctl create "NH Vory E2E" com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-0)
fi
ONLY="-only-testing:VoryTests/GatewayIntegrationTests"
[ "${2:-}" = "--ui" ] && ONLY="$ONLY -only-testing:VoryUITests/VoryUITests/testOnboardingConnectChatAndSettings"
ACTION=test
[ -d "$DD/Build/Products" ] && ACTION=test-without-building
cd "$VORY"
TEST_RUNNER_HERMES_E2E_URL="$URL" TEST_RUNNER_HERMES_E2E_TOKEN="$NHERMES_TOKEN" TEST_RUNNER_HERMES_E2E_REQUIRED=1 \
  xcodebuild $ACTION -project Vory.xcodeproj -scheme Vory -destination "id=$UDID" $ONLY -derivedDataPath "$DD" CODE_SIGN_IDENTITY=- \
  | grep -E "^Test (case|Case)|error:|Executed|TEST (SUCCEEDED|FAILED)"
