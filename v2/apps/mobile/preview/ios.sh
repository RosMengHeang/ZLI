#!/usr/bin/env bash
# Builds ZLI Remote in demo mode for the iOS Simulator and captures every screen and the Live Activity.
#
#   ios.sh build <out>     expo prebuild, pod install, and a Release simulator build
#   ios.sh capture <out>   boots the simulator and saves <out>/<screen>-<light|dark>.png
#
# Needs macOS with Xcode 26, CocoaPods, Maestro, and `pnpm install` run in v2/.
set -euo pipefail

STEP="${1:?usage: ios.sh build|capture <out>}"
mkdir -p "${2:?usage: ios.sh build|capture <out>}"
OUT="$(cd "$2" && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$HERE")"
DEVICE="${PREVIEW_IOS_DEVICE:-iPhone 17}"
DERIVED="${PREVIEW_DERIVED_DATA:-$APP_DIR/ios/build}"
BUNDLE_ID=dev.zli.remote

log() { printf '\n== %s\n' "$*"; }

build() {
  cd "$APP_DIR"
  export CI=1 EXPO_NO_TELEMETRY=1 EXPO_PUBLIC_ZLI_DEMO=1
  # The Xcode phase that bundles the JavaScript does not always pass this shell's environment on.
  printf 'EXPO_PUBLIC_ZLI_DEMO=1\n' > .env.local
  trap 'rm -f "$APP_DIR/.env.local"' EXIT

  log "Generating the iOS project"
  pnpm exec expo prebuild --platform ios --clean --no-install
  (cd ios && pod install)
  local workspace scheme
  workspace="$(find ios -maxdepth 1 -name '*.xcworkspace' | head -n 1)"
  scheme="$(basename "$workspace" .xcworkspace)"

  log "Building $scheme for the simulator (log: $OUT/xcodebuild.log)"
  # Ad hoc signing keeps the App Group entitlement; the Live Activity reads its layout through it.
  if ! xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release -sdk iphonesimulator \
    -destination "generic/platform=iOS Simulator" -derivedDataPath "$DERIVED" \
    CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= \
    COMPILER_INDEX_STORE_ENABLE=NO ONLY_ACTIVE_ARCH=YES ARCHS="$(uname -m)" \
    build > "$OUT/xcodebuild.log" 2>&1; then
    grep -E "error:|BUILD FAILED" "$OUT/xcodebuild.log" | head -n 40 || true
    tail -n 60 "$OUT/xcodebuild.log"
    exit 1
  fi
  find "$DERIVED/Build/Products/Release-iphonesimulator" -maxdepth 1 -name '*.app' | head -n 1 > "$OUT/app-path.txt"
  log "Built $(cat "$OUT/app-path.txt")"
}

# Maestro keeps screenshots inside its own output folder, so they are copied out once the flow ends.
flow() {
  local dir="$OUT/maestro/$1-$2" status=0
  maestro test -e THEME="$2" --test-output-dir "$dir" "$HERE/flows/$1.yaml" || status=$?
  if [ "$status" -ne 0 ]; then xcrun simctl io booted screenshot "$dir/failed.png" > /dev/null 2>&1 || true; fi
  find "$dir" -name "*-$2.png" -exec cp {} "$OUT/" \;
  return "$status"
}

capture() {
  local app udid failed=0
  # The first start of Maestro's XCTest driver on a fresh simulator can take minutes on CI.
  export MAESTRO_DRIVER_STARTUP_TIMEOUT="${MAESTRO_DRIVER_STARTUP_TIMEOUT:-300000}"
  app="$(cat "$OUT/app-path.txt")"
  udid="$(xcrun simctl list devices available -j | DEVICE="$DEVICE" node -e '
    const { devices } = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const ios = Object.entries(devices).filter(([runtime]) => runtime.includes("iOS")).sort().reverse();
    const match = ios.flatMap(([, list]) => list).find((device) => device.name === process.env.DEVICE);
    if (match) console.log(match.udid);
  ')"
  if [ -z "$udid" ]; then
    echo "No available simulator named $DEVICE:" >&2
    xcrun simctl list devices available >&2
    exit 1
  fi

  log "Booting $DEVICE ($udid)"
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b
  xcrun simctl status_bar "$udid" override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
    --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
  xcrun simctl install "$udid" "$app"

  for theme in light dark; do
    log "Screens, $theme"
    xcrun simctl ui "$udid" appearance "$theme"
    flow screens "$theme" || failed=1
    log "Live Activity, $theme"
    flow live-ios "$theme" || failed=1
  done
  xcrun simctl terminate "$udid" "$BUNDLE_ID" 2>/dev/null || true
  # A crash at launch only shows up as a missing screen, so the reports and their reason go along too.
  local report
  for report in "$HOME"/Library/Logs/DiagnosticReports/ZLIRemote*.ips; do
    [ -e "$report" ] || continue
    cp "$report" "$OUT/maestro/"
    echo "Crash report $(basename "$report"):"
    grep -oE '"(indicator|details)" *: *(\[[^]]*\]|"[^"]*")' "$report" | head -n 4 || true
  done
  ls -1 "$OUT"/*.png 2>/dev/null || true
  return "$failed"
}

case "$STEP" in
  build) build ;;
  capture) capture ;;
  *) echo "usage: ios.sh build|capture <out>" >&2; exit 2 ;;
esac
