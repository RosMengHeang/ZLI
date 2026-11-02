#!/usr/bin/env bash
# Builds ZLI Remote in demo mode for an Android emulator and captures every screen and the live status.
#
#   android.sh build <out>     expo prebuild and a release APK for x86_64
#   android.sh capture <out>   installs it on the running emulator and saves <out>/<screen>-<light|dark>.png
#
# Needs JDK 17, the Android SDK, Maestro, and `pnpm install` run in v2/. Capture expects one emulator
# on adb, Android 16 QPR2 (API 36.1) to show the status bar chip.
set -euo pipefail

STEP="${1:?usage: android.sh build|capture <out>}"
mkdir -p "${2:?usage: android.sh build|capture <out>}"
OUT="$(cd "$2" && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$HERE")"
APK="$APP_DIR/android/app/build/outputs/apk/release/app-release.apk"
PACKAGE=dev.zli.remote

log() { printf '\n== %s\n' "$*"; }

build() {
  cd "$APP_DIR"
  export CI=1 EXPO_NO_TELEMETRY=1 EXPO_PUBLIC_ZLI_DEMO=1
  # Gradle's bundling task does not always pass this shell's environment on.
  printf 'EXPO_PUBLIC_ZLI_DEMO=1\n' > .env.local
  trap 'rm -f "$APP_DIR/.env.local"' EXIT

  log "Generating the Android project"
  pnpm exec expo prebuild --platform android --clean --no-install

  log "Building the release APK (log: $OUT/gradle.log)"
  # The template signs release builds with the debug key, which is all an emulator needs.
  if ! (cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon --console=plain) \
    > "$OUT/gradle.log" 2>&1; then
    grep -E "^e: |error:|FAILURE|What went wrong" -A 4 "$OUT/gradle.log" | head -n 60 || true
    tail -n 60 "$OUT/gradle.log"
    exit 1
  fi
  log "Built $APK"
}

shot() {
  adb exec-out screencap -p > "$OUT/$1.png"
}

unlock() {
  adb shell input keyevent KEYCODE_WAKEUP
  adb shell wm dismiss-keyguard
  sleep 2
}

# Maestro keeps screenshots inside its own output folder, so they are copied out once the flow ends.
flow() {
  local dir="$OUT/maestro/$1-$2" status=0
  maestro test -e THEME="$2" --test-output-dir "$dir" "$HERE/flows/$1.yaml" || status=$?
  if [ "$status" -ne 0 ]; then adb exec-out screencap -p > "$dir/failed.png" || true; fi
  find "$dir" -name "*-$2.png" -exec cp {} "$OUT/" \;
  return "$status"
}

# Waits for the live status notification, which shows once the demo desktop answers.
live_notification() {
  local _
  for _ in $(seq 30); do
    if adb shell dumpsys notification --noredact | grep -q "pkg=$PACKAGE.*id=1001"; then return 0; fi
    sleep 1
  done
  echo "The live status notification did not show up" >&2
  return 1
}

live_status() {
  local theme="$1"
  unlock
  adb shell am force-stop "$PACKAGE"
  adb shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 > /dev/null
  local status=0
  live_notification || status=1
  {
    adb shell dumpsys activity services "$PACKAGE"
    adb shell dumpsys package "$PACKAGE" | grep -i "notification"
    adb shell dumpsys notification --noredact | grep -A 30 "pkg=$PACKAGE"
  } > "$OUT/maestro/live-$theme.txt" 2>&1 || true
  adb shell input keyevent KEYCODE_HOME
  sleep 3
  shot "chip-$theme"
  adb shell cmd statusbar expand-notifications
  sleep 3
  shot "shade-$theme"
  adb shell cmd statusbar collapse
  sleep 1
  adb shell input keyevent KEYCODE_SLEEP
  sleep 2
  adb shell input keyevent KEYCODE_WAKEUP
  sleep 3
  shot "lock-$theme"
  unlock
  return "$status"
}

capture() {
  local failed=0
  adb wait-for-device
  log "Installing $APK"
  # The package service can still drop installs for a while after the emulator reports it has booted.
  local attempt
  for attempt in 1 2 3 4 5 6; do
    if adb install -r "$APK"; then break; fi
    if [ "$attempt" -eq 6 ]; then exit 1; fi
    sleep 15
  done
  adb shell pm grant "$PACKAGE" android.permission.POST_NOTIFICATIONS || true
  # The emulator has no lock screen until one is turned on.
  adb shell locksettings set-disabled false || true

  for theme in light dark; do
    log "Screens, $theme"
    if [ "$theme" = dark ]; then adb shell cmd uimode night yes; else adb shell cmd uimode night no; fi
    sleep 2
    unlock
    flow screens "$theme" || failed=1
    log "Live status, $theme"
    live_status "$theme" || failed=1
  done
  adb shell am force-stop "$PACKAGE" || true
  # Uploaded with the artifact only, for when a screen or the notification goes missing.
  adb logcat -d > "$OUT/logcat.txt" 2>&1 || true
  adb shell dumpsys notification --noredact > "$OUT/notifications.txt" 2>&1 || true
  ls -1 "$OUT"/*.png 2>/dev/null || true
  return "$failed"
}

case "$STEP" in
  build) build ;;
  capture) capture ;;
  *) echo "usage: android.sh build|capture <out>" >&2; exit 2 ;;
esac
