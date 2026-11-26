# ZLI Remote

The phone app for ZLI. It pairs with the ZLI desktop app and lets you
follow agents, answer their approvals and questions, send them messages, start new ones, and use a
shell in a worktree.

The phone never talks to the runtime directly. It connects to the desktop's Phone access gateway,
which is off until you turn it on, over a channel encrypted with keys that stay on the two devices.
The gateway forwards only an allowlist of commands; see `packages/remote-protocol/src/policy.ts`.

## How the phone reaches the desktop

The phone tries the desktop's addresses on the local network first. If you turned on Connect from
anywhere on the desktop, the pairing code also carries a relay route, and the phone tries it after
a 1.5 s head start for the local network (at once if the relay worked last time, or if every local
address already failed). The first connection that completes the encrypted handshake wins.

The badge under the header says which one is in use while the phone is online: Home Wi-Fi or
Remote. Offline, the app shows the usual out-of-reach message instead. Settings shows the same
word under Connected by.

The relay is a Cloudflare Worker that passes bytes between the two sides; see `apps/relay`. The
phone and the desktop encrypt and authenticate every frame with keys that never reach it, so it
cannot read, change, or invent traffic, and it cannot pair a device. It does see the room id, when
each side connects, how large the frames are, and both sides' network addresses. A "not paired"
answer that comes only through the relay is shown but never makes the phone forget its pairing.

The relay URL is not configured in this app. It comes from the pairing code, which the desktop
builds from its own `ZLI_RELAY_URL`, so the mobile build needs no relay setting.

## Run it

Install dependencies from `v2/` as usual (`pnpm install`), then from this folder:

```sh
pnpm exec expo start          # open in Expo Go, or a development build
pnpm exec expo run:android    # native build on a connected Android device
pnpm exec expo run:ios        # native build on an iPhone (macOS with Xcode)
```

`pnpm exec expo export --platform android` bundles the JavaScript without a device, which is a quick
check that Metro resolves the workspace packages.

Expo Go runs everything except the live status, which needs native code: use a development build to
try it.

Set `EXPO_PUBLIC_ZLI_DEMO=1` to run the app against a demo desktop inside it
(`src/lib/demoDesktop.ts`) instead of a paired one. It shows the sample agents and accepts every
command. The flag is read at build time, so never set it for a build people install.

## Phone preview on pull requests

The Mobile preview workflow (`.github/workflows/mobile-preview.yml`) runs on pull requests that
touch this app or the packages it uses, and can be started by hand with a pull request number. It
builds the app in demo mode for an iPhone 17 simulator and an Android 16 emulator, takes a
screenshot of every screen in light and dark, captures the live status (Dynamic Island, lock screen,
Android notification and status bar chip), and keeps one comment on the pull request up to date.
When the base branch has this preview too, the comment shows before and after.

The screenshots are pushed to the `pr-media` branch so the comment can show them; each pull request
keeps only its newest run there. Pull requests from forks get the screenshots as workflow artifacts
but no comment. A run takes about an hour, most of it the two native builds.

To run it on a Mac, from `v2/` after `pnpm install`, with Maestro installed and an iPhone 17
simulator available:

```sh
bash apps/mobile/preview/ios.sh build /tmp/preview
bash apps/mobile/preview/ios.sh capture /tmp/preview
```

`android.sh` takes the same steps and needs a running emulator for `capture`. The flows are in
`preview/flows/`; they find their way by the text on screen, so update them when that text changes.

## Pair a phone

1. On the desktop, open Settings, then Phone access, and turn on Allow phones on this network.
2. Choose Pair a new phone. A QR code appears for five minutes.
3. In ZLI Remote, scan the code, or copy it on the desktop and paste it into the app.
4. Name the phone and choose Pair. The phone shows up under Paired phones on the desktop.

To pair on the local network, the phone and the desktop need to be on the same network, and the
desktop's firewall has to allow the gateway's port (47321 unless it was taken). Pairing through the
relay needs a click on Allow in the desktop app within 120 s, and only works when Connect from
anywhere was on when the code was made. To remove a phone, revoke it on the desktop or choose
Forget in the app's settings.

Connect from anywhere is off by default, as is Allow terminal input from anywhere. Without the
second one, a phone that is away can read terminals but cannot open one or type into it. Both need
`ZLI_RELAY_URL` set in the desktop's environment; see `apps/relay/README.md`. Turning Connect from
anywhere off and on again makes a new room, so phones paired before need to pair again to use the
relay. The local network keeps working for them.

## Notifications

The app asks to send notifications the first time it opens after pairing, and Settings shows whether
they are on. It compares each update from the desktop with the one before and alerts when an agent
asks for approval, asks a question, finishes a turn, fails, or stops. Nothing is sent for the
conversation already on screen, and an answered request removes its notification. Tapping one opens
that agent.

### Push notifications

While the app is not connected, or on iPhone once it leaves the screen, the desktop sends the same
alerts through Expo's push service instead, with the same title, state, and text. The phone gives
the desktop its Expo push token after each connection, or tells it to forget the token when
notifications are off. The desktop needs internet access to reach Expo.

Push stays off until the app has an EAS project, and it never works in a simulator or emulator.
To turn it on:

1. Run `eas init` in this folder. It adds `extra.eas.projectId` to `app.json`.
2. Set `enableRemoteNotifications` to `true` in the `expo-notifications` plugin in `app.json`.
3. For Android, create a Firebase project for `dev.zli.remote`, download `google-services.json` into
   this folder, and point `android.googleServicesFile` at it.
4. Upload the push keys with `eas credentials`: the FCM V1 service account key for Android, and an
   APNs key for iPhone. APNs needs a paid Apple Developer account.
5. Build the app again. Settings > Phone access on the desktop then says "Gets alerts while ZLI
   Remote is closed" under the phone.

## Live status

While an agent is working or waiting on you, the app shows one status outside itself: the agent that
needs you first, else the one that changed last, with a count of the others.

- On iPhone it is a Live Activity on the lock screen and in the Dynamic Island, built with
  `expo-widgets`. Approvals get Approve and Reject buttons; everything else gets Stop.
- On Android it is an ongoing notification with the same buttons, posted by a foreground service in
  `modules/zli-live-status`. Android 16 promotes it to a Live Update, a chip in the status bar.

Tapping the status opens that agent. A button checks the newest update from the desktop before it
sends anything, so it does nothing if the request was already answered or the agent already stopped.
Swiping the Live Activity away hides it until no agent is busy.

## What it stores

The pairing lives in the platform keystore through `expo-secure-store`, readable after the first
unlock and never copied to backups or other devices: the desktop's public key and addresses, the
phone's own X25519 key, and the device credential the desktop issued.

## Layout

- `src/lib/` holds the logic with no React Native imports, tested with Vitest from `v2/`:
  pairing, the reconnecting link, launch steps, terminal output, and what screens show.
- `src/screens/` and `src/ui/` are the React Native screens and primitives.
- `preview/` builds and screenshots the app in CI; see Phone preview on pull requests.
- `metro.config.js` lets Metro resolve the `./file.js` imports the TypeScript workspace packages use.

## Limits

- Away from home the phone needs the relay, which the desktop owner has to run and turn on. Without
  it the phone only reaches the desktop on the same network. If the relay has no desktop, the app
  says the PC is unreachable.
- A phone sees the relay's close codes, not the desktop's. A desktop that is off shows up as 4404,
  and a relay that is busy or restarting as 1013.
- Without push set up (see Push notifications), the phone posts its own notifications and live
  status, so they only change while it is connected. Push carries the alerts, not the live status.
- On Android the foreground service keeps the connection open in the background while an agent is
  busy, and the app disconnects once none is. iOS suspends the app soon after it leaves the screen:
  the Live Activity then says to open the app, and a button press reconnects for a few seconds to
  send the answer.
- The Android `specialUse` foreground service has to be explained in the Play Console before release.
- Messages are plain text. Markdown, diffs, and attachments stay on the desktop.
- The terminal shows recent output as text and sends typed lines and a few keys. Full-screen
  programs such as editors do not render on the phone.
