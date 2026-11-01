# Mobile + AI agents research

## Part 1: Developer pain points (2026)

Research date: 2026-11-01. Scope: React Native/Expo, Flutter, native Android (Gradle/Kotlin/Compose) and native iOS (Xcode/Swift/SwiftUI), used with Claude Code, Codex, Cursor, Droid, Gemini in Android Studio and Xcode's built-in agents.

Severity is the cost when the pain hits (lost hours, broken build, shipped bug). Frequency is how often a typical team using agents meets it. Both are estimates from the volume and tone of the sources below, not from a survey.

### Context: where the ecosystem is in late 2026

These facts drive several pains below, because most models were trained before them:

- Expo SDK 55 (Feb 2026, RN 0.83) dropped the Legacy Architecture; SDK 56 (May 2026, RN 0.85) and SDK 57 (June 2026, RN 0.86) followed. React Native 0.82+ cannot disable the New Architecture. Sources: [expo.dev/blog/upgrading-to-sdk-55](https://expo.dev/blog/upgrading-to-sdk-55), [docs.expo.dev/guides/new-architecture](https://docs.expo.dev/guides/new-architecture/), [expo.dev/changelog/sdk-56](https://expo.dev/changelog/sdk-56), [expo.dev/changelog/sdk-57](https://expo.dev/changelog/sdk-57).
- Expo Go on the Apple App Store stops at SDK 54. SDK 55+ projects cannot use the store build of Expo Go on a physical iPhone. Source: [docs.expo.dev/troubleshooting/expo-go-version-mismatch](https://docs.expo.dev/troubleshooting/expo-go-version-mismatch/).
- AGP 9.0 shipped in January 2026 with built-in Kotlin and a new DSL; Google says the opt-out flags stop working in summer 2026. Flutter now writes `android.builtInKotlin=false` and `android.newDsl=false` into `gradle.properties` as a stopgap. Sources: [developer.android.com AGP 9 release notes](https://developer.android.com/build/releases/agp-9-0-0-release-notes), [nek12.dev AGP 9 migration](https://nek12.dev/blog/en/agp-9-0-migration-guide-android-gradle-plugin-9-kmp-migration-kotlin/), [docs.flutter.dev built-in Kotlin migration](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers).
- CocoaPods trunk becomes read-only on December 2, 2026; Firebase stopped publishing to CocoaPods in October 2026. This affects native iOS, React Native and Flutter. Source: [courier.com CocoaPods end of life](https://www.courier.com/blog/cocoapods-end-of-life-heres-what-to-do).
- Xcode 26.3 (Feb 2026) added agentic coding with Claude Agent and Codex; Xcode 26.6 added Gemini and any ACP agent. Claude Code Desktop added a live iOS Simulator pane in July 2026. Sources: [apple.com newsroom](https://www.apple.com/newsroom/2026/02/xcode-26-point-3-unlocks-the-power-of-agentic-coding/), [blakecrosley.com iOS agent guide](https://blakecrosley.com/guides/ios-agent-development), [macrumors.com](https://www.macrumors.com/2026/07/21/claude-code-ios-simulator/).
- General trust baseline: 66% of developers say their top AI frustration is "solutions that are almost right, but not quite", and 46% distrust AI output accuracy vs 33% who trust it. Source: [Stack Overflow 2025 survey, AI section](https://survey.stackoverflow.co/2025/ai).

### Ranked summary

| Rank | Pain | Status vs. the starting list | Severity | Frequency |
| --- | --- | --- | --- | --- |
| 1 | Agent cannot see or verify the UI it built | Confirmed, refined | High | Every UI task |
| 2 | Parallel agents collide on Metro, devices, DerivedData, CPU and RAM | New | High | Daily for anyone running 2+ agents on one app |
| 3 | Version drift: stale training data produces confident wrong fixes | Confirmed, 2026 specifics added | High | Weekly; spikes after every SDK/AGP/Xcode release |
| 4 | Build, signing and dependency failures are hard for agents to diagnose | Confirmed | High | Weekly |
| 5 | Agents make builds green by silencing errors | New | High (ships bugs) | Common on Swift 6 and Kotlin/TS type errors |
| 6 | Native logs and crashes are invisible to the agent | New | Medium-high | Every native crash |
| 7 | Native config: permissions, config plugins, privacy manifests, store rules | Confirmed | High (store rejection or crash) | Each time a native capability is added |
| 8 | Expo Go vs development build; OTA runtime mismatch | Confirmed, sharpened by SDK 55 | Medium-high | Expo teams, at setup and release |
| 9 | New Architecture package compatibility | Confirmed, now mandatory | Medium | Upgrades and new dependencies |
| 10 | Agents copy legacy code instead of the design system | Confirmed (mostly general evidence) | Medium | Most UI PRs |
| 11 | Each agent needs its own mobile tooling setup | New | Medium | Once per agent per machine, then drift |

---

### 1. The agent cannot see or verify the UI it built

**Description.** Web agents can open a browser, read the DOM and take screenshots. A mobile app runs in a simulator or emulator window the agent cannot read by default, so the loop is "write code, hope, ask the human for a screenshot". In 2026 the tooling for seeing has improved a lot, but it is fragmented per agent and per platform, and seeing a screenshot is not the same as verifying behavior.

**Evidence.**
- "People dragging screenshots into chat, describing what's broken, waiting, repeating... you're asking AI to debug something it literally cannot see." [zerotopete.com](https://www.zerotopete.com/p/give-claude-eyes-and-hands-on-your)
- "A running React Native app on iOS Simulator is a graphical window that the agent has no interface to. It's a write-and-pray loop." [hooton.codes](https://hooton.codes/blog/building-expo-agent-bridge/)
- r/ClaudeCode thread (June 2026): a developer smoke-tests via Expo Go on a phone and asks how Claude Code can see the running app; another says models are "VERY good for web tech, but for native or mobile apps are... okeysh". [reddit.com/r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/comments/1ug2if8/claude_code_react_native_whats_your_experience/)
- Claude Code Desktop's simulator pane (July 2026) is iOS-only, and observation is screenshot-only: "There is no element query, text extraction, UI hierarchy". The CLI uses computer use instead. [mobai.run teardown](https://mobai.run/blog/claude-code-ios-simulator-pane), [macrumors.com](https://www.macrumors.com/2026/07/21/claude-code-ios-simulator/)
- The ecosystem's answer is a pile of separate tools: Expo MCP screenshots and UI automation (SDK 54+, needs a running dev server) [docs.expo.dev/mcp](https://docs.expo.dev/mcp/); XcodeBuildMCP (82 tools) [github.com/getsentry/XcodeBuildMCP](https://github.com/getsentry/XcodeBuildMCP); mobile-mcp [github.com/mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp); Callstack agent-device, which says agents "still struggle to reliably interact with mobile apps" [callstack.com](https://www.callstack.com/blog/agent-device-ai-native-mobile-automation-for-ios-android); Dart MCP with agentic hot reload [dart.dev Dart 3.12](https://dart.dev/blog/announcing-dart-3-12); Gemini "Journeys" in Android Studio [android-developers.googleblog.com](https://android-developers.googleblog.com/2025/05/google-io-2025-whats-new-in-android-development-tools.html).
- A practitioner with 8 shipped iOS apps lists "visual debugging" as one of three things agents fail at. [blakecrosley.com](https://blakecrosley.com/guides/ios-agent-development)
- Generated RN code "compiles. It renders. The screenshot looks right." Reviewers then find missing empty/loading/error states. A screenshot of the happy path is not proof. [dev.to RN review checklist](https://dev.to/hugo_rus_630dd942fcf7cc62/the-code-review-checklist-for-ai-generated-react-native-10-things-agents-get-wrong-1lkf)

**Severity / frequency.** High / every UI task. It is the root of the "almost right" problem on mobile.

**What a desktop agent-workspace tool can do.**
- Give every agent the same device surface regardless of vendor: screenshot, accessibility/UI tree (`adb shell uiautomator dump`, `xcrun simctl` + idb or XCUITest tree), tap/type/swipe, open URL. Expose it as one MCP server or CLI that ZLI registers for each agent it launches, so Claude, Codex and Droid all get it.
- Return the UI tree with the screenshot. Text and IDs let the agent assert ("button 'Save' visible, enabled") instead of guessing from pixels, and cost fewer tokens.
- Capture before/after evidence per task: screenshot or short recording attached to the agent's turn and to the PR description.
- Cover states, not just the happy path: helpers to launch with a deep link, toggle dark mode (`xcrun simctl ui booted appearance dark`, `adb shell cmd uimode night yes`), large text, RTL, offline (airplane mode), and a small phone + tablet size.
- Detection signals: the agent edited files under `app/`, `src/screens`, `lib/` (Flutter), `*View.swift`, `@Composable` files, but took no screenshot after the last build. ZLI can prompt or auto-capture.

### 2. Parallel agents collide on Metro, devices, DerivedData, CPU and RAM (new)

**Description.** Git worktrees isolate source files, not the machine. Several agents working on the same app share Metro's default port 8081, the booted simulator, the installed bundle ID, the dev-client server picker, Xcode DerivedData, Gradle daemons and RAM. Failures are silent: each agent reports success while testing another branch's bundle. This is ZLI's core use case, so it matters more here than anywhere else.

**Evidence.**
- rn-dev-agent issue: "five separate interference incidents in a single working day". Metro on 8081 belonged to another worktree, "the simulator silently showed that branch's bundle; the human tested 'missing rows' that were simply the wrong branch". The dev-client picker auto-attached to 8082 and a wrong bundle made it into a proof video. Proposed fixes: session registry with device claims, deterministic per-worktree Metro ports, dev-client pinning via `<scheme>://expo-development-client/?url=...`, and refusing actions when the bundle's cwd is not the project root. [github.com/Lykhoyda/rn-dev-agent/issues/582](https://github.com/Lykhoyda/rn-dev-agent/issues/582)
- Two Claude Code agents in separate worktrees both picked the same booted iPhone simulator; the second install silently replaced the first build, kept its UserDefaults, and `simctl` returned the same PID to both. "Worktrees keep files apart. They don't keep simulators apart." [flowdeck.studio](https://flowdeck.studio/blog/run-multiple-claude-code-agents-xcode-project)
- XcodeBuildMCP shared one DerivedData directory across clones, causing "corrupted incremental builds, race conditions"; a commenter also hit orphaned `xcodebuild` processes holding DerivedData and simulator locks after a cancelled tool call. [github.com/getsentry/XcodeBuildMCP/issues/340](https://github.com/getsentry/XcodeBuildMCP/issues/340)
- A team running agents per worktree had a machine-wide Xcode lock serializing every build, one simulator UDID returned to every checkout, and a stop script that killed every worktree's builds. [github.com/Munyon-Canyon/monaco/issues/2179](https://github.com/Munyon-Canyon/monaco/issues/2179)
- Two agents running Gradle together turned a 3-minute build into 15 minutes; "More parallel work produced less completed work." [mcclowes.com](https://mcclowes.com/blog/2026/09/20/too-many-agents-one-mac). Three worktrees running JVM tests reached ~36 GiB before the emulator and IDE. [github.com/gazon1/sing/issues/1654](https://github.com/gazon1/sing/issues/1654). Duplicate Gradle daemons from mismatched JDKs: [levelup.gitconnected.com](https://levelup.gitconnected.com/you-have-four-gradle-daemons-you-need-one-53a362682a42)
- Products now sell this as a feature: Bitrig gives each agent its own worktree, simulator and DerivedData ("I find myself fighting Xcode and its DerivedData") [bitrig.com](https://bitrig.com/blog/run-parallel-agents); Stim gives each workspace its own Metro port and is adding ports for other servers, warning that Vite's silent slide to the next port gives "a server that works and serves the wrong worktree" [github.com/appandflow/stim/issues/847](https://github.com/appandflow/stim/issues/847).
- The default prompt itself: "Another process is using port 8081. Would you like to run the app on another port instead?" is interactive and blocks a headless agent. [bleepingswift.com](https://bleepingswift.com/blog/orphaned-metro-bundler-port-8081), [reactnative.dev troubleshooting](https://reactnative.dev/docs/troubleshooting)

**Severity / frequency.** High / daily for anyone running two or more agents on one app. Failures are silent, so the cost includes wrong conclusions, not just lost time.

**What a desktop agent-workspace tool can do.**
- Allocate a stable Metro port per worktree (hash of path, from a reserved band such as 8100-8199) and inject it: `RCT_METRO_PORT`, `npx expo start --port <p>`, `npx react-native start --port <p>`. Show the port on the worktree.
- Own the port-to-worktree map: before an agent uses a dev server, check `lsof -iTCP:<port> -sTCP:LISTEN` and the listener's cwd (`lsof -p <pid> -a -d cwd`). Refuse or warn when the cwd is not this worktree.
- Pin the dev client to this worktree's server on every launch: `xcrun simctl openurl <udid> "<scheme>://expo-development-client/?url=http%3A%2F%2Flocalhost%3A<port>"`, `adb -s <serial> shell am start -a android.intent.action.VIEW -d "<same url>"`. Read `<scheme>` from `app.json` `expo.scheme`.
- Device leases per agent (one simulator/emulator per active agent, or explicit hand-off), with a named error when another agent holds the device. Create per-worktree simulators (`xcrun simctl clone`/`create`) and AVDs when RAM allows; queue otherwise.
- Per-worktree DerivedData (`-derivedDataPath <worktree>/.build/DerivedData`) and cleanup on worktree removal; sweep orphaned `xcodebuild`/`gradle`/`node metro` processes owned by a removed or idle worktree.
- A machine-level build slot pool sized by RAM and CPU (e.g. one Gradle/xcodebuild slot per 16 GB), shared across agents, with a visible queue. Pin `org.gradle.java.home` so worktrees share one daemon instead of spawning one per JDK.
- Verify bundle identity after install: compare installed build number/version (`xcrun simctl appinfo`, `adb shell dumpsys package <id> | grep versionName`) and Metro's served project root to the worktree.

### 3. Version drift: stale training data produces confident wrong fixes

**Description.** Mobile stacks change several times a year, and the compatibility rules between Gradle, AGP, Kotlin, Compose compiler, JDK, Expo SDK, React Native, Xcode, Swift and CocoaPods are strict. Models answer from older tutorials and from whatever version they saw most. The result is plausible, confident fixes that target the wrong version: `npm install` instead of `npx expo install`, deprecated packages, removed flags, downgrades.

**Evidence.**
- Agents "write React Native the way the internet wrote it, which is often a few versions" old: reaching for `expo-av` (deprecated), `SafeAreaView` from `react-native` (deprecated), plain `npm install` "which is how you end up with a native module that doesn't match your SDK and a build that fails in EAS". [dev.to CLAUDE.md for Expo](https://dev.to/hugo_rus_630dd942fcf7cc62/stop-your-ai-agent-writing-2023-react-native-a-claudemd-for-expo-supabase-apps-3fia)
- Android: agents "don't know about Kotlin 2.x K2, AGP 9, Navigation 3... They write what was correct three years ago" (`GlobalScope.launch`, `collectAsState()` leaks, `LazyColumn` without keys). [haidrrrry.medium.com](https://haidrrrry.medium.com/your-ai-coding-agent-is-writing-broken-kotlin-heres-how-to-fix-it-fbfd65939469)
- AGP 9 is the biggest 2026 trap: "the biggest migration effort that I had to undergo this year", Hilt and KSP lagged support, `BuildConfig` behavior changed in KMP. [nek12.dev](https://nek12.dev/blog/en/agp-9-0-migration-guide-android-gradle-plugin-9-kmp-migration-kotlin/), [r/androiddev "AGP 9.0 is Out, and Its a Disaster"](https://www.reddit.com/r/androiddev/comments/1qi110y/agp_90_is_out_and_its_a_disaster_heres_full/). Google now ships an "AGP 9 migration skill" for agents, which confirms models get it wrong unaided. [developer.android.com agents skill](https://developer.android.com/agents/skills/build-system/agp/agp-9-upgrade/skill)
- Kotlin/AGP/Gradle compatibility is a matrix that changes every release. [kotlinlang.org compatibility table](https://kotlinlang.org/docs/gradle-configure-project.html); classic errors like "Module was compiled with an incompatible version of Kotlin" still dominate searches. [stackoverflow.com/questions/67699823](https://stackoverflow.com/questions/67699823/module-was-compiled-with-an-incompatible-version-of-kotlin-the-binary-version-o)
- Flutter: the built-in Kotlin migration and its `gradle.properties` flags [docs.flutter.dev](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers); r/FlutterDev threads on "the Flutter/Gradle" breakage (Aug 2026) [reddit.com/r/FlutterDev](https://www.reddit.com/r/FlutterDev/comments/1vh8k6x/anyone_else_experiencing_the_fluttergradle/); generic agents produce "800-line StatefulWidget spaghetti" [reddit.com/r/FlutterDev](https://www.reddit.com/r/FlutterDev/comments/1rhwllw/why_generic_ai_coding_agents_write_terrible/).
- iOS: a model trained before WWDC 2026 "will not know" iOS 27 frameworks [blakecrosley.com](https://blakecrosley.com/guides/ios-agent-development); "Why are most AI models really bad at SwiftUI?" [r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1ovqw2o/why_are_most_ai_models_really_bad_at_swiftui/).
- Vendors responded with version-aware context: Expo writes `AGENTS.md` pointing to docs for the project's SDK and ships Expo Skills + MCP with `npx expo install` [docs.expo.dev/agents](https://docs.expo.dev/agents/); the upgrade guide says "If you use an AI coding agent, install Expo Skills and use the expo-upgrade" skill [docs.expo.dev upgrade walkthrough](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/); Flutter publishes official AI rules [docs.flutter.dev/ai](https://docs.flutter.dev/ai/get-started).

**Severity / frequency.** High / weekly, with spikes in the weeks after each Expo SDK, AGP, Kotlin, Flutter or Xcode release.

**What a desktop agent-workspace tool can do.**
- Build a "toolchain fingerprint" per worktree and inject it into every agent's context (and show it in the Mobile tab). Read:
  - `package.json`: `expo`, `react-native`, `react`, `expo-router`, `react-native-reanimated`; lockfile for resolved versions.
  - `app.json` / `app.config.(js|ts)`: `sdkVersion` (should be absent or match), `runtimeVersion`, `plugins`, `newArchEnabled`.
  - `android/gradle/wrapper/gradle-wrapper.properties` (`distributionUrl`), `android/build.gradle(.kts)` and `settings.gradle(.kts)` (AGP and Kotlin plugin versions), `gradle/libs.versions.toml`, `android/gradle.properties` (`android.builtInKotlin`, `android.newDsl`, `newArchEnabled`, `org.gradle.jvmargs`), Compose BOM.
  - `ios/Podfile`, `ios/Podfile.lock` (`COCOAPODS:` version, RN pods), `*.xcodeproj/project.pbxproj` (`IPHONEOS_DEPLOYMENT_TARGET`, `SWIFT_VERSION`), `Package.resolved`.
  - `pubspec.yaml` / `pubspec.lock` (Flutter/Dart SDK constraints), `.fvmrc` / `.tool-versions`.
  - Host: `java -version`, `xcodebuild -version`, `flutter --version`, `node -v`, `pod --version`.
- Flag known-bad combinations with a small rules table (Kotlin vs AGP vs Gradle vs JDK; Expo SDK vs RN vs Expo Go availability). Link the official matrix.
- Run the stack's own doctor and feed the result to the agent: `npx expo-doctor`, `npx expo install --check`, `flutter doctor -v`, `./gradlew --version`, `npx react-native doctor`.
- Guard installs: when an agent runs `npm install <pkg>`/`yarn add` in an Expo project, suggest or rewrite to `npx expo install <pkg>`.
- Review diffs that change version strings (wrapper, AGP, Kotlin, `expo`, `react-native`, Podfile platform) and highlight downgrades; agents often "fix" a build by downgrading.
- Offer to install vendor context per stack (Expo plugin/skills + MCP, Flutter rules + Dart MCP, Android AGP skill, XcodeBuildMCP) for each agent ZLI launches.

### 4. Build, signing and dependency failures are hard for agents to diagnose

**Description.** Native builds fail with thousands of lines of output where the real error is early and buried. Signing (certificates, provisioning profiles, entitlements, keystores) depends on account state the agent cannot see. CocoaPods state (`Pods/`, `Podfile.lock`, `Manifest.lock`) drifts per worktree. Agents also corrupt `project.pbxproj`. In late 2026 the CocoaPods-to-SPM transition adds new churn.

**Evidence.**
- Without an Xcode MCP the agent must "parse thousands of lines of unstructured output... hope it found the actual error"; "No code signing diagnostics. Provisioning profile errors, certificate mismatches, and entitlement conflicts produce some of the most opaque build failures in iOS". [blakecrosley.com/blog/xcode-mcp-claude-code](https://blakecrosley.com/blog/xcode-mcp-claude-code)
- Agents "fail at .pbxproj modifications, code signing, and visual debugging". [blakecrosley.com guide](https://blakecrosley.com/guides/ios-agent-development). "Never let them touch .pbxproj files... LLMs frequently introduce syntax errors when editing this file." [dev.to](https://dev.to/anicca_301094325e/how-to-automate-ios-development-without-breaking-pbxproj-files-2mpk). Xcode 27.2 beta adds a JSON `project.xcproj` format, partly for agents. [artemnovichkov.com](https://artemnovichkov.com/blog/xcode-projects-for-the-command-line-and-coding-agents)
- EAS: "the earliest phase with errors will contain the most useful information". [docs.expo.dev build troubleshooting](https://docs.expo.dev/build-reference/troubleshooting/). Third-party tools now exist just to pick the relevant line from an EAS log. [dev.to](https://dev.to/asta_dev/how-to-fix-eas-build-failed-errors-in-expo-1a4k)
- "The sandbox is not in sync with the Podfile.lock" remains a top CocoaPods error. [stackoverflow.com/questions/44942889](https://stackoverflow.com/questions/44942889/the-sandbox-is-not-in-sync-with-the-podfile-lock-run-pod-install-or-update-yo)
- CocoaPods trunk read-only on Dec 2, 2026; RN and Flutter apps still have Podfiles. [courier.com](https://www.courier.com/blog/cocoapods-end-of-life-heres-what-to-do), [dev.to RN roadmap to SPM](https://dev.to/estolegion/react-native-roadmap-to-swift-package-manager-2026-3elg)
- Xcode's own agent integration has auth and crash issues in 26.4 and 27.0. [developer.apple.com/forums/thread/819968](https://developer.apple.com/forums/thread/819968), [Apple forums coding-intelligence tag](https://developer.apple.com/forums/tags/coding-intelligence)

**Severity / frequency.** High / weekly. Signing failures are rarer but can block a release for a day.

**What a desktop agent-workspace tool can do.**
- Wrap builds and return a structured summary: first error, file:line, failing phase/task, and a short excerpt. For Xcode use `xcodebuild ... -resultBundlePath` + `xcrun xcresulttool`, or `xcbeautify`; for Gradle use `--console=plain` and extract `What went wrong:` blocks, `> Task :app:... FAILED`; for EAS use `eas build:view --json` and fetch the failing phase log.
- Classify common failures and attach a known fix: Pod sandbox out of sync (`cd ios && pod install`), Ruby/CocoaPods version mismatch, `No profiles for 'com.x' were found`, `Signing for "App" requires a development team`, Kotlin metadata version mismatch, `Unsupported class file major version` (JDK), `Duplicate class`, `minSdkVersion` too low, missing `google-services.json`/`GoogleService-Info.plist`.
- Signing preflight (read-only): `security find-identity -v -p codesigning`, provisioning profiles in `~/Library/MobileDevice/Provisioning Profiles` (decode with `security cms -D`), `DEVELOPMENT_TEAM` and `CODE_SIGN_STYLE` in `project.pbxproj`, `eas credentials` status, `android/app/build.gradle` `signingConfigs`, `eas.json` profiles. Report mismatches to the human; do not let agents create or rotate credentials.
- Protect `project.pbxproj`: warn on agent edits, run `plutil -lint` on it after any change, and suggest XcodeGen/Tuist or the Expo CNG/prebuild path instead.
- Per-worktree Pods hygiene: detect `Podfile.lock` vs `Pods/Manifest.lock` drift and offer `pod install`; flag pods that need an SPM migration plan before Dec 2, 2026.
- Lock credential files from agent writes (`*.p12`, `*.mobileprovision`, `*.jks`, `*.keystore`, `credentials.json`) and keep them out of agent context.

### 5. Agents make builds green by silencing errors (new)

**Description.** Asked to fix a failing build or test, agents often pick the cheapest change that makes the error disappear: `@unchecked Sendable`, `nonisolated(unsafe)`, `try!`, `as!`, disabling or skipping tests, `@Suppress`, `// @ts-ignore`, `any`, downgrading a dependency, or setting a flag back to legacy. The build passes and the bug ships.

**Evidence.**
- "AI coding agents are very good at making a red build go green. They're less reliable at making it go green for the right reason." Six recurring shortcuts in Swift, plus a pre-commit grep for `@unchecked Sendable|nonisolated(unsafe)|try!|as!|.disabled(|XCTSkip`. [dev.to/iboson](https://dev.to/iboson/the-ai-agent-made-my-xcode-build-green-here-are-6-ways-it-might-have-cheated-2bhb)
- Controlled experiment: given a Swift 6 strict-concurrency error, agents "make the build green by adding one annotation. The error goes away. The data race it was warning about does not." [dev.to/jbrackin](https://dev.to/jbrackin/watch-a-coding-agent-silence-a-swift-6-data-race-instead-of-fixing-it-4jpp)
- RN: agents reach for `any` "the moment a type gets inconvenient" and move secrets into `EXPO_PUBLIC_` vars to make an API call "work". [dev.to RN review checklist](https://dev.to/hugo_rus_630dd942fcf7cc62/the-code-review-checklist-for-ai-generated-react-native-10-things-agents-get-wrong-1lkf)

**Severity / frequency.** High (latent data races, security leaks) / common whenever agents fix compile or type errors, especially during Swift 6 and AGP 9 migrations.

**What a desktop agent-workspace tool can do.**
- Scan each agent's diff for escape hatches and surface them in review before merge. Patterns: Swift `@unchecked Sendable`, `nonisolated(unsafe)`, `@preconcurrency`, `try!`, `as!`, `XCTSkip`, `.disabled(`; Kotlin `@Suppress`, `!!`, `GlobalScope`; TS `@ts-ignore`, `@ts-expect-error`, `: any`, `eslint-disable`; secrets in `EXPO_PUBLIC_.*(KEY|SECRET|TOKEN)`; config regressions such as `newArchEnabled=false`, `android.builtInKotlin=false`, version downgrades, deleted tests.
- Require a short reason from the agent for each flagged line, shown next to the diff.

### 6. Native logs and crashes are invisible to the agent (new)

**Description.** Many mobile failures never reach the terminal the agent watches. Native crashes, missing native modules and config errors show up in Logcat, the iOS unified log or a crash report, not in Metro or `flutter run`. Apps also "crash on launch" with an empty JS console. The agent sees "it exited" and guesses.

**Evidence.**
- "This crash never shows up in Metro. Only Logcat knows the truth." [medium.com silent crashes in RN](https://medium.com/@jhanzeb.ali99/the-silent-crashes-in-react-native-crashes-with-no-error-logs-traces-c742dee51b2b); "If the app is stuck on the splash screen then there should be an error regarding native modules" [stackoverflow.com/questions/76902975](https://stackoverflow.com/questions/76902975/unable-to-see-logs-in-react-native-regardless-of-what-i-do)
- A dedicated CLI to let agents read Metro logs via CDP exists because agents had no clean access: "Plain text output for low context usage". [github.com/okwasniewski/react-native-logs-cli](https://github.com/okwasniewski/react-native-logs-cli)
- Expo MCP can "pull crash data" from EAS; Dart MCP exposes runtime errors and widget inspection. [docs.expo.dev/mcp](https://docs.expo.dev/mcp/), [medium.com Dart MCP](https://medium.com/@flutter-app/your-ai-agent-can-see-your-flutter-app-now-what-the-dart-mcp-server-lets-you-do-8ed58a273811)

**Severity / frequency.** Medium-high / every native crash or launch failure.

**What a desktop agent-workspace tool can do.**
- Give agents a filtered, bounded log tool scoped to the app under test: Android `adb -s <serial> logcat --pid=$(adb shell pidof -s <appId>) -v brief` plus `AndroidRuntime:E *:S` for fatal exceptions; iOS `xcrun simctl spawn <udid> log stream --predicate 'process == "<App>"' --style compact`; crash reports in `~/Library/Logs/DiagnosticReports`; Metro/Expo logs via CDP; `flutter logs`.
- On crash or app exit after launch, auto-attach the last ~100 relevant lines and the first stack trace to the agent's next turn.
- Deduplicate and trim (stack frames, repeated warnings) to keep context small.

### 7. Native config: permissions, config plugins, privacy manifests, store rules

**Description.** Adding a native capability (camera, location, notifications, background audio, Bluetooth, health) needs changes outside the code the agent is editing: iOS `Info.plist` usage strings, Android manifest permissions, Expo config plugins in `app.json`, entitlements, privacy manifests, and store policies. Miss one and the app crashes on first use, the build fails, or the store rejects it. In Expo CNG projects, edits to `ios/` or `android/` are overwritten by prebuild, which agents also get wrong.

**Evidence.**
- iOS kills the app if a usage description is missing; `expo-camera` also needs `NSMicrophoneUsageDescription`, which surprised users who only set the camera key. [github.com/expo/expo/issues/11736](https://github.com/expo/expo/issues/11736). Expo docs on where permissions must be declared. [docs.expo.dev/guides/permissions](https://docs.expo.dev/guides/permissions/)
- EAS iOS build shipped default strings instead of the custom ones (April 2026), found only by unzipping the IPA and reading `Info.plist`. [r/expo](https://www.reddit.com/r/expo/comments/1se5r85/eas_ios_build_ignores_custom_permission_strings/). App Store rejections for vague strings: [stackoverflow.com/questions/61641880](https://stackoverflow.com/questions/61641880/nscamerausagedescription-doesnt-work-on-expo-application)
- Privacy manifests: apps are rejected without `PrivacyInfo.xcprivacy` entries for third-party SDKs that use required-reason APIs. [developer.apple.com privacy manifest](https://developer.apple.com/documentation/bundleresources/adding-a-privacy-manifest-to-your-app-or-third-party-sdk), [pushmyapp.ai 2026 guide](https://pushmyapp.ai/blog/ios-privacy-manifest-guide)
- Google Play 16 KB page size requirement for apps with native code. [developer.android.com page sizes](https://developer.android.com/guide/practices/page-sizes), [creolestudios.com RN fix guide](https://www.creolestudios.com/react-native-16kb-page-size-rejection-fix/)
- The Expo rules file explicitly adds "Every user-facing string that requests a permission needs a clear reason" because agents skip it. [dev.to CLAUDE.md for Expo](https://dev.to/hugo_rus_630dd942fcf7cc62/stop-your-ai-agent-writing-2023-react-native-a-claudemd-for-expo-supabase-apps-3fia)

**Severity / frequency.** High (crash or rejection) / each time a native capability is added; lower frequency than pains 1-4.

**What a desktop agent-workspace tool can do.**
- Permission linter: map packages/APIs to required config and check it. Examples: `expo-camera` needs `NSCameraUsageDescription` (+ microphone if recording) and `android.permission.CAMERA`; `expo-location` needs `NSLocationWhenInUseUsageDescription`; `expo-notifications` needs its plugin and `aps-environment`. Sources to read: `package.json` deps, `app.json` `expo.plugins` / `expo.ios.infoPlist` / `expo.android.permissions`, `ios/<App>/Info.plist`, `android/app/src/main/AndroidManifest.xml`, `*.entitlements`, `PrivacyInfo.xcprivacy`; Flutter `pubspec.yaml` plugins vs the same native files; Swift imports (`AVFoundation`, `CoreLocation`, `HealthKit`) and Kotlin permission calls.
- Check the built artifact, not just source: after a build, read the generated `Info.plist` (`plutil -p`) and merged manifest (`android/app/build/intermediates/merged_manifests/...`), or `aapt2 dump permissions`.
- CNG guard: if `app.json` drives prebuild (no committed `ios/`/`android/`, or `.gitignore` lists them), warn when an agent edits generated native files; suggest a config plugin instead and run `npx expo prebuild --clean` in a scratch dir to confirm.
- 16 KB check for Android builds with native libs: `zipalign -c -P 16 -v 4 app.apk` or check ELF alignment of `.so` files.

### 8. Expo Go vs development build; OTA runtime mismatch

**Description.** Expo Go and a development build look the same at runtime but have different native code. Agents add a package with native code and tell the user to "open in Expo Go", which fails on first call. Since SDK 55, the App Store's Expo Go no longer runs current projects on physical iPhones at all. On the release side, `runtimeVersion` must match between the installed binary and the OTA update; native changes without a runtime bump ship updates that crash or never apply.

**Evidence.**
- "Expo Go and a development build look identical at runtime but expose different capabilities." [fixdevs.com](https://fixdevs.com/blog/expo-not-working/). Expo Go "stops working, not gradually but on the first call" once native code it lacks is needed; App Store Expo Go stops at SDK 54. [newly.app guide (Oct 2026)](https://newly.app/guides/expo-go-versus-a-development-build), [docs.expo.dev Expo Go mismatch](https://docs.expo.dev/troubleshooting/expo-go-version-mismatch/)
- Confusion persists among new users in 2026. [r/expo "Confused About Expo Go vs Dev Builds"](https://www.reddit.com/r/expo/comments/1rhwwa7/confused_about_expo_go_vs_dev_builds_whats_the/), [abp.io support thread](https://abp.io/support/questions/10817/Expo-version-mismatch---can't-use)
- Runtime mismatch: "if you forget to bump the app version when changing the native runtime, then you'll have a runtime version mismatch". [docs.expo.dev runtime versions](https://docs.expo.dev/eas-update/runtime-versions/). A team spent 2 days and 18 EAS builds on an SDK 54 bug where Android AAB builds kept an old runtimeVersion and OTA updates were rejected. [github.com/expo/expo/issues/41694](https://github.com/expo/expo/issues/41694). Local vs EAS fingerprint differences: [r/expo](https://www.reddit.com/r/expo/comments/1h839dz/trouble_and_confusion_with_expoupdates/)

**Severity / frequency.** Medium-high / Expo teams hit Expo Go confusion at setup and after adding native deps; runtime mismatches hit at release time but are costly (broken production updates).

**What a desktop agent-workspace tool can do.**
- Detect the right client automatically: if `expo-dev-client` is in `package.json`, or any dependency has native code not in Expo Go, or the SDK is above what Expo Go supports on the target device, open the project in the dev build (`<scheme>://expo-development-client/?url=...`) and say why. Otherwise Expo Go (`exp://<host>:<port>`) is fine.
- Check that the dev build on the device matches the worktree's native fingerprint (`npx expo-updates fingerprint:generate`) and prompt a rebuild (`npx expo run:ios|android` or `eas build --profile development`) when native deps or `app.json` plugins changed.
- Before any `eas update`, compare the current fingerprint with the runtime of the target channel's latest build (`eas build:list --json`, `eas update:list --json`) and block on mismatch. Recommend `runtimeVersion: { policy: "fingerprint" }`. Files: `app.json` (`runtimeVersion`, `updates.url`), `eas.json` (`channel` per profile), `fingerprint.config.js`.

### 9. New Architecture package compatibility

**Description.** With Expo SDK 55+ and RN 0.82+, the New Architecture is the only option. Libraries that were never migrated now break at build or runtime, and key libraries (Reanimated 4, FlashList 2) dropped the old architecture. Agents trained on 2024 answers still suggest `newArchEnabled=false`, which no longer works, or add unmaintained packages.

**Evidence.**
- "SDK 55 removes the newArchEnabled escape hatch entirely, and a build that tries to opt out just fails." [dainemawer.com](https://www.dainemawer.com/react-native-new-architecture-expo-sdk-55), [docs.expo.dev/guides/new-architecture](https://docs.expo.dev/guides/new-architecture/)
- ~83% of EAS Build projects had migrated before removal; the rest face a painful migration. [byteiota.com](https://byteiota.com/expo-sdk-55-legacy-architecture-is-gone-migrate-now/). State of RN 2025: New Architecture at 80% adoption [results.stateofreactnative.com](https://results.stateofreactnative.com/en-US/); the prior edition called it a pain point [devclass.com](https://www.devclass.com/development/2025/03/04/react-native-survey-shows-rocky-path-for-new-architecture/1623425).
- Reanimated 4 and FlashList 2 dropped legacy support; audit with `npx expo-doctor` or React Native Directory. [dianapps.com](https://dianapps.com/blog/react-native-new-architecture/)
- Point releases still regress: SDK 56/57 Hermes V1 memory regression with Reanimated/worklets. [expo.dev/changelog/sdk-57](https://expo.dev/changelog/sdk-57)

**Severity / frequency.** Medium / at upgrades and when adding dependencies.

**What a desktop agent-workspace tool can do.**
- When an agent adds a dependency, check it against React Native Directory (New Architecture support, last release, Expo Go support) and `npx expo-doctor`, and show the result before install.
- Flag `newArchEnabled=false` in `app.json` or `android/gradle.properties` on SDK 55+/RN 0.82+ as a guaranteed failure.
- Surface known regressions for the project's exact `expo` patch version (from the Expo changelog) in the toolchain fingerprint.

### 10. Agents copy legacy code instead of the design system

**Description.** Agents infer conventions from what is most common in the repo, and legacy code usually outnumbers the new design system. They import old components, hardcode colors and spacing, mix styling systems, and skip accessibility. Rules files help less than expected. Mobile-specific evidence is thinner than for the other pains, but the mechanism is the same and mobile adds dark mode, dynamic type and platform conventions.

**Evidence.**
- An agent PR "imported a modal from `components/legacy/`... used a form hook I deprecated months ago... hardcoded `#FF3B30` instead of my semantic tokens". "Every one of those mistakes was the model being a good student of my codebase." Rules files "grew to... several hundred lines... The agents kept making the same mistakes anyway." [builder.io](https://www.builder.io/blog/how-to-make-ai-agents-follow-your-design-system)
- RN-specific: "Half the components use NativeWind classes, half use `style={{ marginTop: 12 }}`, and a few use `StyleSheet.create`." [dev.to RN review checklist](https://dev.to/hugo_rus_630dd942fcf7cc62/the-code-review-checklist-for-ai-generated-react-native-10-things-agents-get-wrong-1lkf); "tokens beat pixels" for AI-generated RN UI [dev.to](https://dev.to/hasansarwer/building-an-ai-assisted-react-native-ui-kit-why-tokens-beat-pixels-in-the-age-of-copilot-1122)
- Token accuracy went from 12% to 94% after making the design system machine-readable. [medium.muz.li](https://medium.muz.li/my-4-step-framework-to-make-design-systems-ai-readable-74ba07145312)
- Tooling responses: RN/Expo agent kits with a design-system agent [github.com/senaiverse](https://github.com/senaiverse/claude-code-reactnative-expo-agent-system); SwiftUI agent skills [r/iOSProgramming](https://www.reddit.com/r/iOSProgramming/comments/1rmnna0/swiftui_agent_skill_for_people_using_codex_claude/), [r/ClaudeAI 23 iOS 26 skills](https://www.reddit.com/r/ClaudeAI/comments/1rng766/23_agent_skills_for_ios_26_development_swiftui/).

**Severity / frequency.** Medium / most UI PRs. Rarely breaks a build; costs review time and visual quality.

**What a desktop agent-workspace tool can do.**
- Detect the design system and tell agents where it is: theme/token files (`theme.ts`, `tokens.json`, `tailwind.config.js` with NativeWind, `Colors.kt`/`Theme.kt`, `Color+Theme.swift`, Asset catalog colors, Flutter `ThemeData`), and folders marked legacy or deprecated.
- Lint the agent's diff: hex/RGB literals and raw numbers in style props where tokens exist, imports from `legacy/` or `deprecated/` paths, inline styles mixed with the main system.
- Visual check in states that reveal token misuse: dark mode and large text screenshots (see pain 1).

### 11. Each agent needs its own mobile tooling setup (new)

**Description.** Expo, Apple, Google and the community each ship agent tooling, but setup differs per agent: Claude Code and Codex have an official Expo plugin; Cursor and others need manual Skills + MCP setup; Xcode agents use `xcrun mcpbridge`; XcodeBuildMCP, mobile-mcp, agent-device and Dart MCP each have their own install. A team running several agents ends up with uneven capabilities and config drift.

**Evidence.** Expo's per-agent instructions ("Cursor and other agents do not have an official Expo plugin") [docs.expo.dev/agents](https://docs.expo.dev/agents/); two separate MCP servers recommended for iOS [blakecrosley.com](https://blakecrosley.com/blog/xcode-mcp-claude-code); Flutter docs note Claude Code plugins "don't automatically load plugin rules" [docs.flutter.dev/ai](https://docs.flutter.dev/ai/get-started); setup friction with Claude inside Xcode [r/Xcode](https://www.reddit.com/r/Xcode/comments/1rlohed/cant_get_claude_pro_plan_to_work_inside_xcode/).

**Severity / frequency.** Medium / once per agent per machine, then ongoing drift.

**What a desktop agent-workspace tool can do.** Detect the stack per worktree and register the matching MCP servers/skills for every agent ZLI launches (one config, many agents), with a health check that each server starts.

### Detection cheat sheet (files and commands)

| Signal | Where to read | What it tells ZLI |
| --- | --- | --- |
| Stack type | `package.json` (`expo`, `react-native`), `pubspec.yaml`, `*.xcodeproj`/`*.xcworkspace`, `settings.gradle(.kts)` | Which checks and tools to enable |
| Expo SDK / RN version | `package.json`, lockfile, `app.json` `sdkVersion` | Expo Go viability, New Architecture rules, known regressions |
| Expo config | `app.json` / `app.config.*`: `scheme`, `plugins`, `ios.infoPlist`, `android.permissions`, `runtimeVersion`, `updates`, `newArchEnabled` | Deep-link pinning, permission lint, OTA safety |
| EAS | `eas.json` (profiles, `channel`, `developmentClient`), `eas build:list --json`, `eas update:list --json` | Dev build vs Expo Go, runtime match before updates |
| Native fingerprint | `npx expo-updates fingerprint:generate` | Whether a dev build must be rebuilt |
| Android toolchain | `gradle/wrapper/gradle-wrapper.properties`, `build.gradle(.kts)`, `libs.versions.toml`, `gradle.properties` (`android.builtInKotlin`, `android.newDsl`, `org.gradle.jvmargs`), `java -version` | AGP/Kotlin/Gradle/JDK compatibility, AGP 9 status, memory |
| Android manifest | `AndroidManifest.xml`, merged manifest under `build/intermediates` | Permissions actually shipped |
| iOS toolchain | `Podfile`, `Podfile.lock` vs `Pods/Manifest.lock`, `Package.resolved`, `project.pbxproj` (`DEVELOPMENT_TEAM`, `IPHONEOS_DEPLOYMENT_TARGET`, `SWIFT_VERSION`), `xcodebuild -version` | Pods drift, signing setup, SPM migration need |
| iOS config | `Info.plist`, `*.entitlements`, `PrivacyInfo.xcprivacy` | Usage strings, capabilities, privacy manifest |
| Signing | `security find-identity -v -p codesigning`, provisioning profiles, `eas credentials` | Signing preflight (read-only) |
| Flutter | `pubspec.yaml`/`pubspec.lock`, `flutter doctor -v`, `.fvmrc` | SDK constraints, Android/iOS toolchain health |
| Dev server ownership | `lsof -iTCP:<port> -sTCP:LISTEN`, `lsof -p <pid> -a -d cwd` | Which worktree a Metro/Expo port serves |
| Installed build | `xcrun simctl appinfo <udid> <bundleId>`, `adb shell dumpsys package <id>` | Whether the device runs this worktree's build |
| Health | `npx expo-doctor`, `npx expo install --check`, `npx react-native doctor`, `flutter doctor` | Version mismatches the agent should fix first |

### What ZLI should do, in priority order

1. **Isolate parallel agents on mobile resources (pain 2).** Per-worktree Metro port, port ownership check by cwd, dev-client pinning on launch, one device per agent via leases, per-worktree DerivedData, a RAM-sized build slot pool, installed-build identity check. No other tool category owns this as directly as an agent workspace does, and ZLI already has device leases and an Expo dev-server banner to build on.
2. **Give every agent one device tool with screenshots plus UI tree (pain 1)** and auto-captured evidence per task, including dark mode and large text. Register it for all agents ZLI launches (pain 11).
3. **Toolchain fingerprint and version guard (pains 3, 9).** Read the files in the cheat sheet, run the stack doctor, inject the result into agent context, flag known-bad combos and downgrades, and rewrite `npm install` to `npx expo install` in Expo projects.
4. **Structured build and log feedback (pains 4, 6).** First-error extraction for xcodebuild/Gradle/EAS, a failure classifier with known fixes, signing preflight, and crash-triggered log capture scoped to the app's PID.
5. **Diff guards (pains 5, 7, 10).** Escape-hatch scan, permission/config-plugin linter against built artifacts, `project.pbxproj` and credential protection, design-token lint.
6. **Expo release safety (pain 8).** Choose Expo Go vs dev build automatically and explain why; block `eas update` on runtime/fingerprint mismatch.

## Part 2: Existing tools: wrap vs build

Researched 2026-11-01. Star counts, licenses, and push dates come from the GitHub API. Versions come from the npm registry or GitHub releases on that date.

### What ZLI already has (relevant to every decision below)

The desktop app already ships a device layer in `v2/apps/desktop/src/mobile/`:

- Drivers: `AndroidDriver.ts` (adb screencap, `uiautomator` dump, `logcat -d -v threadtime`), `IosSimulatorDriver.ts`, `IosVideoSource.ts`, and scrcpy streaming (`scrcpy/`).
- AVD and SDK management: `AvdManager.ts`, `AndroidSdk.ts`, `AndroidSetup.ts`.
- Per-worktree device leases: `DeviceLeases.ts`. A person's lease always wins over an agent's.
- A built-in `zli-mobile` agent tool set in `MobileControlActions.ts`: `mobile_devices`, `mobile_boot`, `mobile_shutdown`, `mobile_install`, `mobile_launch`, `mobile_open_url`, `mobile_snapshot`, `mobile_tap`, `mobile_swipe`, `mobile_type`, `mobile_press`, `mobile_rotate`, `mobile_screenshot`, `mobile_logs`, `mobile_release`.
- Test fakes: `FakeProcessRunner.ts`, `FakeDriver.ts`, and `fixtures/`.

ZLI hands MCP servers to agents as `McpServerSpec` values (`v2/apps/server/src/browser-tool/browserTool.ts`): stdio `{ name, command, args, env }` or http `{ transport: "http", name, url, headers }`. `agentLaunch.ts` turns them into per-CLI flags or project MCP files. Every "wrap" below is one more `McpServerSpec` or one more `ProcessRunner` call, so it can be unit-tested with the existing fakes on Linux.

### Tool landscape

| Tool | What it does | Install | License | Targets | Host OS | Interface | Maturity (2026-11-01) |
|---|---|---|---|---|---|---|---|
| **Callstack agent-device** | Device layer for agents: accessibility snapshots with `@eN` refs, press/fill/scroll, screenshots, video, logs, network, perf, React profiling, crash symbolication, `.ad` replay scripts, Maestro YAML export | `npm i -g agent-device` (Node ≥ 22.12) | MIT | iOS sim + device, Android emulator + device, tvOS, Android TV, HarmonyOS, macOS, Linux desktop, web | macOS (all); Linux/Windows (Android only); remote proxy for a Mac | CLI with `--json`, stdio MCP (`agent-device mcp`), typed Node API (`createAgentDeviceClient`) | 5.2k stars, v0.21.35 (2026-10-29), pushed daily |
| **Argent** (Software Mansion) | MCP and skills to control, debug, and profile: taps and gestures, logs, network (JS and native), React tree, Hermes/Instruments/Perfetto profiling, e2e record/replay, visual diff | `npx @swmansion/argent@latest init` or `npm i -g @swmansion/argent` (Node ≥ 20.12) | Apache-2.0 source plus **proprietary binaries** (`simulator-server`, `ax-service`, iOS dylibs) | iOS sim + iPhone, Android emulator + device, TV, Electron/Chromium, HarmonyOS (flag) | macOS for iOS; Android needs only adb | stdio MCP (`argent mcp`), CLI (`argent tools`, `argent run <tool>`) | 3.1k stars, v0.31.0 (2026-10-28) |
| **Expo MCP Server** | Remote: Expo docs, EAS builds/workflows/logs/submit, TestFlight crashes, EAS Observe metrics, EAS cloud simulators. Local (via `expo-mcp` package): screenshot, tap, find view by testID, `collect_app_logs`, open DevTools, Expo Router sitemap | Remote: `https://mcp.expo.dev/mcp` (OAuth). Local: `npx expo install expo-mcp --dev`, then `EXPO_UNSTABLE_MCP_SERVER=1 npx expo start` | Hosted service; `expo-mcp` npm is MIT (v0.2.4) | Local tools: iOS sim, Android emulator; EAS Simulator in the cloud | Any host for remote tools; local tools need a simulator or emulator | Streamable HTTP MCP | Free plan since 2026-05-26 with metered usage; some tools (for example `search_documentation`) need a paid EAS plan |
| **Maestro** (`maestro mcp`) | YAML E2E flows; MCP tools `list_devices`, `inspect_screen`, `take_screenshot`, `run` (inline YAML or files), `cheat_sheet`, cloud runs, `open_maestro_viewer` | `curl -fsSL "https://get.maestro.mobile.dev" \| bash` (Java 17+) | Apache-2.0 | iOS sim, Android emulator + device, web | macOS, Linux, Windows (WSL); iOS needs macOS | CLI, stdio MCP bundled in the CLI | 16.3k stars, cli-2.12.0 (2026-10-26). The old Python `maestro-mcp` repo is **archived** |
| **mobile-mcp** (Mobile Next) | Platform-neutral MCP: list devices, screenshot, list elements, tap/swipe/type, install/launch apps, `mobile_get_device_logs`, `mobile_list_crashes`, `mobile_get_crash`, batch commands, screen recording | `npx -y @mobilenext/mobile-mcp@latest` | Apache-2.0 | iOS sim + real device, Android emulator + device, optional cloud devices | macOS for iOS; Linux/Windows for Android | stdio MCP, or HTTP via `--listen 3000` (`MOBILEMCP_AUTH` bearer) | 10.2k stars, 1.0.15 (2026-10-30) |
| **XcodeBuildMCP**, now **MobileBuildMCP** (Sentry) | Xcode build/test/run for simulator and device, log capture, UI automation via the AXe binary, structured build results | `brew tap getsentry/xcodebuildmcp && brew install mobilebuildmcp` or `npx -y mobilebuildmcp@latest mcp` | MIT | iOS/macOS only | macOS 14.5+, Xcode 16+ | CLI and stdio MCP (`mobilebuildmcp mcp`) | 6.5k stars, v2.7.1 (2026-09-23). The `xcodebuildmcp` npm name stopped at 2.7.0. Sentry telemetry is on by default |
| **Android CLI** (Google) | `android emulator create/list/start/stop`, `android build/install/run`, `android screen capture --annotate`, `android screen resolve`, Journeys tests, `android profiler`, `android signals` (Crashlytics crashes and ANRs), plus an `android-cli` agent skill | `curl -fsSL https://dl.google.com/android/cli/latest/linux_x86_64/install.sh \| bash`, then `android init` | Google proprietary, free | Android emulator + device | Linux, macOS, Windows | CLI and agent skill (no MCP found) | 1.0 stable May 2026; 1.1.16717390 (October 2026). Collects usage metrics unless `--no-metrics` |
| **Android-MCP** (CursorTouch) | adb-based MCP: tap, type, UI tree, screenshots | `uvx`/pip (Python) | MIT | Android emulator + device | Any | stdio MCP | 911 stars, pushed 2026-10-27 |
| **android-mcp-server** (minhalvp) | adb MCP | Python | Apache-2.0 | Android | Any | MCP | 810 stars, **stale** (last push 2025-05) |
| **React Native Directory API** | Package metadata: New Architecture status, Expo Go support, config plugin, platforms, maintenance | Public HTTP, no key | MIT (dataset repo) | n/a | Any | JSON over HTTP | 1.4k stars, pushed 2026-10-31 |
| **expo-doctor** | Project health checks: dependency versions, React Native Directory checks, app config sync | `npx expo-doctor` | MIT | n/a | Any | Text only. There is no `--json` (feature request expo/expo#44785 was closed without the feature) | v1.21.5 (2026-10-16) |
| **Callstack agent-skills** | Skills and Codex plugins: "Building React Native Apps", "Testing React Native Apps", React Native best practices | `npx codex-plugin add callstackincubator/agent-skills` | MIT | n/a | Any | Skills (Markdown) | 1.7k stars |

Sources: [agent-device](https://github.com/callstack/agent-device), [agent-device docs (llms-full)](https://agent-device.dev/llms-full.txt), [Argent](https://github.com/software-mansion/argent), [Argent install](https://docs.swmansion.com/argent/docs/fundamentals/installation), [Argent platforms](https://docs.swmansion.com/argent/docs/fundamentals/supported-platforms), [Argent CLI](https://docs.swmansion.com/argent/docs/reference/cli), [Expo + Argent](https://docs.expo.dev/agents/argent/), [Expo MCP](https://docs.expo.dev/mcp/), [Expo MCP free plan](https://expo.dev/changelog/the-expo-mcp-server-is-now-available-on-the-free-plan), [Maestro MCP](https://docs.maestro.dev/get-started/maestro-mcp), [Maestro](https://github.com/mobile-dev-inc/maestro), [archived maestro-mcp](https://github.com/mobile-dev-inc/maestro-mcp), [mobile-mcp](https://github.com/mobile-next/mobile-mcp), [MobileBuildMCP](https://github.com/getsentry/XcodeBuildMCP), [Android CLI](https://developer.android.com/tools/agents/android-cli), [Android CLI release notes](https://developer.android.com/tools/agents/android-cli/release-notes), [android screen](https://developer.android.com/tools/agents/android-cli/commands/screen), [Android-MCP](https://github.com/CursorTouch/Android-MCP), [android-mcp-server](https://github.com/minhalvp/android-mcp-server), [RN Directory API](https://github.com/react-native-community/directory/blob/main/API.md), [expo-doctor JSON request](https://github.com/expo/expo/issues/44785), [Expo CLI](https://docs.expo.dev/more/expo-cli/), [EAS CLI](https://docs.expo.dev/eas/cli/), [Callstack agent-skills](https://www.callstack.com/blog/announcing-codex-plugins-for-react-native-development).

### Gotchas that affect ZLI

- **agent-device** needs Node ≥ 22.12. ZLI should not assume Electron's bundled Node is on `PATH`. Probe `agent-device --version` and fall back to `zli-mobile`. Its docs tell agents not to run `npx -y agent-device@latest`, so ZLI should launch a pinned global or project-local binary. It keeps state in `~/.agent-device` (sessions, claims, logs). Without `--session`, sessions are scoped to the caller's git worktree, which fits ZLI's model directly.
- **agent-device on Linux** drives Android only. iOS needs a Mac, either locally or through `agent-device proxy --port 4310` behind a tunnel. Some features (touch overlay export, `record contact-sheet`) are macOS-only and fail with `details.reason` codes such as `contact_sheet_unsupported_host`.
- **Argent** ships closed binaries that may not be redistributed. ZLI must not bundle it; it can only point to a user-installed `argent`. `argent init` edits workspace files (MCP configs, skills, rules), so ZLI should register `argent mcp` itself and never run `init` inside a worktree. Telemetry is opt-out: `argent telemetry disable`.
- **Expo MCP local tools** need SDK 54+, an Expo login that matches the OAuth account, the `expo-mcp` devDependency, and `EXPO_UNSTABLE_MCP_SERVER=1` on `expo start`. The agent must reconnect MCP after each dev server restart. Remote tools are metered. EAS Simulator sessions are billed.
- **Maestro** needs Java 17 and the full binary path plus `JAVA_HOME` when launched from a minimal environment, which is how ZLI starts agents. Use the bundled `maestro mcp`, not the archived Python repo.
- **mobile-mcp** with `@latest` via npx floats versions. Pin a version in the spec. `--listen 0.0.0.0` exposes device control; keep the default loopback.
- **MobileBuildMCP** was renamed from XcodeBuildMCP. Use the `mobilebuildmcp` package. It is macOS-only and sends Sentry telemetry unless disabled.
- **expo-doctor** has no machine-readable output. ZLI must rely on the exit code and parse `✔`/`✖` lines defensively, or use the underlying sources directly (React Native Directory, `npx expo install --check`).
- **Android 16** `adb shell cmd clipboard` silently does nothing (agent-device documents and guards this). **WSL**: a Windows `adb.exe` breaks host paths; Linux platform-tools are needed.

### Wrap vs build, per feature

Summary first, then invocation details.

| Feature | Decision | Primary tool | Fallback | Works on Linux without devices? |
|---|---|---|---|---|
| Simulator/emulator tile with screenshot loop | **Wrap** | agent-device (MCP + CLI) | existing `zli-mobile`; mobile-mcp as a user-installed option | Detection and config: yes. Live loop: Android with adb only |
| Per-worktree device isolation | **Build thin** on existing `DeviceLeases`, pass results to wrapped tools | ZLI allocator, then agent-device `--session`/`--serial`/`--metro-port` | none needed | Yes (pure allocation logic) |
| Mobile doctor | **Build** the aggregator and AGENTS.md writer; **wrap** probes | `expo config --json`, `expo install --check`, `expo-doctor`, `agent-device doctor --json`, adb, simctl | static file parsing only | Yes. Every probe is optional |
| Build-fix | **Build** the classifier and brief; **wrap** log sources | `eas build:list/view --json`, Gradle `--console=plain`, `xcresulttool`, Expo MCP `build_logs` | raw log text pasted or captured | Yes (classifier runs on fixtures) |
| Live device log and crash stream | **Build thin** stream and crash detector on ZLI's drivers; **wrap** agent-device logs when present | `adb logcat`, `simctl log stream`, agent-device `logs` | `mobile_logs` (existing snapshot) | Parser yes; stream needs a device |
| Package guard | **Build thin** pre-install check | React Native Directory API, `npx expo install`, `npx expo install --check` | npm registry metadata | Yes (HTTP plus fakes) |

#### 1. Simulator/emulator tile with screenshot loop: wrap agent-device

ZLI already renders the device (scrcpy, `IosVideoSource`) and has a small built-in tool set. Instead of growing `zli-mobile` into a full automation runtime, ZLI should hand agents **agent-device** when it is installed. agent-device is MIT, the most complete option, has worktree-scoped sessions and device claims, returns `--json`, and exposes the same runtime through CLI, MCP, and a typed Node API. Keep `zli-mobile` as the zero-install fallback and keep the tile's video stream.

MCP spec ZLI adds at launch (stdio):

```json
{
  "name": "agent-device",
  "command": "agent-device",
  "args": ["mcp"],
  "env": {
    "AGENT_DEVICE_SESSION": "zli-<worktreeId>",
    "AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST": "emulator-5556",
    "AGENT_DEVICE_SCREENSHOT_SCALE": "0.3",
    "AGENT_DEVICE_NO_UPDATE_NOTIFIER": "1"
  }
}
```

The screenshot feedback loop for the tile (ZLI calls the CLI, the agent calls the same commands through MCP):

```bash
agent-device open com.example.app --platform android --serial emulator-5556 --session zli-wt1 --metro-port 8082 --relaunch
agent-device snapshot -i --json --session zli-wt1        # nodes[]: { ref, kind, type, label, rect, ... }
agent-device press @e7 --settle --session zli-wt1        # diff of changed refs
agent-device screenshot /tmp/zli/wt1/latest.png --scale 0.3 --overlay-refs --json --session zli-wt1
agent-device diff screenshot --baseline base.png /tmp/zli/wt1/latest.png --out diff.png --json
agent-device close --session zli-wt1
```

Output shape: `batch`/`--json` results use `{ "success": true, "data": { ... } }` or `{ "success": false, "error": { ... , "details": { "reason": "..." } } }`. ZLI should branch on `details.reason` codes (`DEVICE_IN_USE`, `AMBIGUOUS_MATCH`, `DEVICE_NOT_FOUND`), never on message text.

Alternatives ZLI can offer in Settings > Mobile as user-installed MCP servers. ZLI only writes the spec:

```json
{ "name": "mobile-mcp", "command": "npx", "args": ["-y", "@mobilenext/mobile-mcp@1.0.15"], "env": {} }
{ "name": "argent", "command": "argent", "args": ["mcp"], "env": {} }
{ "name": "maestro", "command": "/abs/path/maestro", "args": ["mcp"], "env": { "JAVA_HOME": "/abs/jdk17" } }
{ "transport": "http", "name": "expo", "url": "https://mcp.expo.dev/mcp", "headers": {} }
{ "name": "mobilebuildmcp", "command": "mobilebuildmcp", "args": ["mcp"], "env": {} }
```

Choose Argent when the user wants profiling (Hermes, Instruments, Perfetto) and accepts its binary license. Choose Expo MCP when the project is Expo and the user wants EAS build logs, TestFlight crashes, or Observe data. Choose MobileBuildMCP only for native iOS on macOS.

Linux degradation: detect `agent-device`, `adb`, and `xcrun` with `findOnPath` (`host.ts`). With none present, show "no device tooling" in the tile and give agents only `zli-mobile` (which already reports "no device available"). Unit tests run with `FakeProcessRunner` returning recorded `--json` fixtures.

#### 2. Per-worktree device isolation: build a thin allocator

No tool allocates Metro ports and AVDs across ZLI's agents, but agent-device can enforce the result. ZLI should build the allocator on top of `DeviceLeases.ts` and `freeEmulatorPort()` (`adb.ts`), then pass the result down.

Per worktree, ZLI picks:

- A Metro port: `8081 + n`, after checking that the port is free.
- An Android emulator console port: an even number from 5554 to 5584 (the serial is `emulator-<port>`).
- An AVD, or the same AVD started in read-only mode.
- An iOS simulator UDID (macOS only).

Commands ZLI runs or injects:

```bash
# Android: one emulator per worktree. -read-only lets several instances share one AVD.
emulator -avd Pixel_9_API_36 -port 5556 -read-only -no-snapshot-save -no-boot-anim
adb -s emulator-5556 reverse tcp:8082 tcp:8082

# Metro per worktree (Expo / bare React Native)
npx expo start --dev-client --port 8082 --host localhost
RCT_METRO_PORT=8082 npx react-native start --port 8082

# iOS (macOS): one simulator per worktree
xcrun simctl list devices available --json
xcrun simctl boot <udid>

# Give the scope to agent-device so the agent cannot take another worktree's device
AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST=emulator-5556
AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET=<per-worktree set path>   # optional, strongest iOS isolation
agent-device device status --platform android --serial emulator-5556
agent-device device release --stale
```

agent-device documents the same pattern for "multiple React Native worktrees": one Metro server per worktree, a different simulator per session, `open --metro-host 127.0.0.1 --metro-port 8082 --relaunch`, and `metro reload --session <name>`. One simulator cannot run two copies of the same bundle id. Native changes still need a rebuild per worktree.

ZLI injects `ZLI_METRO_PORT`, `ANDROID_SERIAL` (adb honors it), `AGENT_DEVICE_SESSION`, and the allowlist into the agent's environment, and writes them into the AGENTS.md block (feature 3). The allocator is pure logic, fully testable on Linux.

#### 3. Mobile doctor: build the aggregator, wrap the probes

No single tool covers Expo SDK, Expo Go vs dev build, device tooling, and signing, and expo-doctor has no JSON output. ZLI should build a doctor that runs optional probes (each with a timeout, each allowed to be missing) and writes one marked block into the worktree's AGENTS.md.

| Fact | Probe | Parse |
|---|---|---|
| Expo SDK, app id, plugins | `npx expo config --json --type public` | `sdkVersion`, `ios.bundleIdentifier`, `android.package`, `plugins[]` |
| Expo Go vs dev build | `package.json` has `expo-dev-client`; `android/` or `ios/` exists (bare/prebuild); `eas.json` profiles with `developmentClient: true` | static file read |
| Dependency drift | `CI=1 npx expo install --check` | exit code ≠ 0 means drift; list package lines from stdout |
| Project health | `npx expo-doctor` | exit code, plus defensive `✖` line parsing |
| New Architecture | `app.json` `newArchEnabled`, `gradle.properties` `newArchEnabled`, RN version | static |
| Android tooling | `adb version`, `adb devices -l`, `emulator -list-avds`, `java -version` | existing `parseAdbDevices` |
| iOS tooling (macOS) | `xcodebuild -version`, `xcrun simctl list devices available --json`, `pod --version` | JSON |
| iOS signing (macOS) | `security find-identity -v -p codesigning`; `eas.json` `credentialsSource` | count of valid identities |
| Android signing | `android/app/build.gradle` `signingConfigs`, `credentials.json`, `eas.json` | static |
| Device automation readiness | `agent-device doctor --json`, `agent-device logs doctor` | JSON |

AGENTS.md block (ZLI owns only the text between its markers):

```markdown
<!-- zli:mobile:start -->
### Mobile environment (written by ZLI, 2026-11-01)
- Expo SDK 58, dev build (expo-dev-client), New Architecture on
- This worktree: Metro port 8082, Android emulator-5556 (Pixel_9_API_36), iOS: unavailable on this host
- Device automation: agent-device 0.21.35 (session zli-wt1). Use it to verify UI changes.
- Install packages with `npx expo install <pkg>`; dependency check: 2 packages out of range (run `npx expo install --fix`)
- Signing: Android debug keystore only; iOS not checked (no macOS)
<!-- zli:mobile:end -->
```

On this Linux box only the static probes and Node-based Expo commands produce results. The adb, simctl, and signing rows report `unavailable`, not errors. Tests feed `FakeProcessRunner` with recorded outputs and file fixtures.

#### 4. Build-fix: build the classifier, wrap the log sources

Tools fetch logs, but none turns them into a precise brief for an agent. ZLI should build the classifier and brief generator. It should run version checks **before** reading logs, because version drift is a common root cause of Expo and React Native build failures and the check is cheap.

Step 1, version checks (cheap, deterministic): `CI=1 npx expo install --check`, `npx expo-doctor`, `node -v`, `java -version` (React Native 0.73+ requires JDK 17), `./gradlew --version`, and on macOS `xcodebuild -version` and `pod --version`.

Step 2, get the log:

```bash
# EAS (remote). Documented flags; --json implies --non-interactive on list
eas build:list --platform android --status errored --limit 1 --json --non-interactive
eas build:view <BUILD_ID> --json           # build record, including log file URLs
# or let the agent use Expo MCP: build_list / build_info / build_logs / workflow_logs

# Local Android
cd android && ./gradlew :app:assembleDebug --console=plain --stacktrace > /tmp/zli/gradle.log 2>&1

# Local iOS (macOS)
xcodebuild -workspace ios/App.xcworkspace -scheme App -sdk iphonesimulator \
  -resultBundlePath /tmp/zli/build.xcresult build > /tmp/zli/xcode.log 2>&1
xcrun xcresulttool get build-results --path /tmp/zli/build.xcresult --format json
# or MobileBuildMCP, which returns structured build results
```

Step 3, classify with regex rules over the log tail (ZLI-owned, table-driven, fixture-tested):

| Class | Example signature |
|---|---|
| Version mismatch | `expo install --check` failures; `requires a minimum Expo SDK`; `Unsupported class file major version` |
| JDK / Gradle | `Unsupported Java`; `Could not resolve com.android.tools.build:gradle`; `Gradle version X is required` |
| Autolinking / native module | `Could not find module`; `Unable to resolve module`; `duplicate class` |
| CocoaPods | `CocoaPods could not find compatible versions`; `pod install` errors |
| Signing | `No signing certificate`; `Provisioning profile ... doesn't include`; `Keystore file not found` |
| New Architecture / codegen | `codegenConfig`; `TurboModule ... not found`; `Fabric` component errors |
| Config plugin | `PluginError`; `Failed to resolve plugin for module` |
| Memory / infra | `Java heap space`; `Daemon disappeared`; EAS `ENOSPC` |

The brief handed to the agent: the class, the first failing line with 20 lines of context, the version-check results, the files most likely to change (`package.json`, `app.json` plugins, `android/gradle.properties`, `Podfile`), and one suggested first command (for example `npx expo install --fix`). All of this runs on Linux against fixture logs.

#### 5. Live device log and crash stream: build a thin stream on ZLI's drivers

ZLI's `AndroidDriver` already reads `logcat -d` snapshots. Streaming plus crash detection is a small addition and keeps ZLI in control of rate limiting before anything reaches the agent chat. When agent-device is installed, prefer its session log file for evidence, because the agent can `grep` it.

```bash
# Android: app-scoped stream plus the crash buffer
adb -s emulator-5556 shell pidof -s com.example.app
adb -s emulator-5556 logcat -v threadtime --pid=<pid>
adb -s emulator-5556 logcat -b crash -v threadtime

# iOS simulator (macOS)
xcrun simctl spawn <udid> log stream --style ndjson --level debug \
  --predicate 'process == "App" OR subsystem == "com.facebook.react.log"'

# agent-device (any host it supports)
agent-device logs clear --restart --session zli-wt1
agent-device logs mark "before tap" --session zli-wt1
agent-device logs path --session zli-wt1     # ~/.agent-device/sessions/<name>/app.log

# JS console via Expo MCP (local tools): collect_app_logs
```

Crash detector signatures: `FATAL EXCEPTION`, `AndroidRuntime: Shutting down VM`, `ANR in`, `Terminating app due to uncaught exception`, `EXC_BAD_ACCESS`, React Native redbox and `LogBox` errors, and `Invariant Violation`. On a match, ZLI posts one compact card (exception, top frames, last 30 lines) into the chat and attaches the full log as a file. It must not paste the whole stream. iOS crash symbolication: `agent-device debug symbols --artifact crash.ips --dsym App.dSYM`. Android stack traces from R8 builds need `mapping.txt`, which agent-device does not handle. Line parsing is unit-testable with fixtures; the stream itself degrades to "no device" on this box.

#### 6. Package guard: build a thin pre-install check

React Native Directory exposes exactly the data needed, verified live on 2026-11-01:

```bash
curl -s 'https://reactnative.directory/api/libraries/check?packages=react-native-reanimated,react-native-vision-camera,react-native-fs'
# {"react-native-reanimated":{"newArchitecture":"supported"},
#  "react-native-vision-camera":{"newArchitecture":"new-arch-only"},
#  "react-native-fs":{"unmaintained":true,"newArchitecture":"untested"}}

curl -s 'https://reactnative.directory/api/library?name=react-native-reanimated'
# { "<pkg>": { "ios": true, "android": true, "expoGo": true, "newArchitecture": true,
#              "github": { "configPlugin": false, "hasNativeCode": true, "moduleType": ..., "isArchived": false },
#              "npm": { "latestRelease": "...", "latestReleaseDate": "..." }, "unmaintained"?: true } }
```

Guard rules before `npm install <pkg>` in an Expo or React Native project:

1. Not in the directory → warn "unknown to React Native Directory". Check `hasNativeCode` via the npm tarball if needed.
2. `newArchitecture: "untested"` or `false` while the project has New Architecture on → block with a note. `new-arch-only` while it is off → block.
3. `unmaintained: true` or `github.isArchived` → warn and suggest alternatives (`/api/libraries?search=<topic>&newArchitecture=true&isMaintained=true&order=downloads`).
4. `expoGo: false` while the project uses Expo Go → "needs a dev build".
5. `github.configPlugin: true` → remind the agent to add it to `plugins` in `app.json` and rebuild.
6. Install through `npx expo install <pkg>` so Expo picks the SDK-compatible version, then run `CI=1 npx expo install --check`.

ZLI exposes this as a skill or MCP tool (`mobile_check_package`) and writes the rule into the AGENTS.md block. HTTP goes through an injectable `fetch` (as in `download.ts`), so tests use canned JSON. With no network, it falls back to "unchecked" without blocking.

### Recommendation in one paragraph

Wrap **agent-device** as the default agent-facing device runtime (MIT, CLI + MCP + Node API, worktree-scoped sessions, device claims, `--json`), keep **zli-mobile** as the zero-install fallback and keep ZLI's own video tile, and list **mobile-mcp**, **Argent**, **Maestro**, **Expo MCP**, and **MobileBuildMCP** as optional MCP servers that ZLI configures but never bundles. Build only the parts no tool owns: the per-worktree port and AVD allocator, the doctor aggregator with its AGENTS.md block, the build-failure classifier and brief, the crash detector on the log stream, and the React Native Directory package guard. All five built parts are pure parsing and allocation logic over `ProcessRunner` and `fetch`, so they are unit-testable on this Linux box with no adb, emulator, or Xcode installed.
