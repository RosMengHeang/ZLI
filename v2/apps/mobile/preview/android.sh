#!/usr/bin/env bash
# Builds ZLI Remote in demo mode for an Android emulator and captures every screen and the live status.
#
#   android.sh build <out>     expo prebuild and a release APK for x86_64
#   android.sh capture <out>   installs it on the running emulator and saves <out>/<screen>-<light|dark>.png
#
# Needs JDK 17, the Android SDK, Maestro, and `pnpm install` run in v2/. Capture expects one emulator
# on adb, Android 16 (API 36) to show the status bar chip.
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

live_status() {
  local theme="$1"
  adb shell am force-stop "$PACKAGE"
  adb shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 > /dev/null
  # Long enough for the demo desktop to answer and the foreground service to post the notification.
  sleep 12
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
  adb shell wm dismiss-keyguard
  sleep 1
}

capture() {
  local failed=0
  adb wait-for-device
  log "Installing $APK"
  adb install -r "$APK"
  adb shell pm grant "$PACKAGE" android.permission.POST_NOTIFICATIONS || true
  # The emulator has no lock screen until one is turned on.
  adb shell locksettings set-disabled false || true

  for theme in light dark; do
    log "Screens, $theme"
    if [ "$theme" = dark ]; then adb shell cmd uimode night yes; else adb shell cmd uimode night no; fi
    sleep 2
    maestro test -e SHOTS="$OUT" -e THEME="$theme" --debug-output "$OUT/maestro-debug/screens-$theme" \
      "$HERE/flows/screens.yaml" || failed=1
    log "Live status, $theme"
    live_status "$theme" || failed=1
  done
  adb shell am force-stop "$PACKAGE" || true
  ls -1 "$OUT"/*.png 2>/dev/null || true
  return "$failed"
}

case "$STEP" in
  build) build ;;
  capture) capture ;;
  *) echo "usage: android.sh build|capture <out>" >&2; exit 2 ;;
esac
