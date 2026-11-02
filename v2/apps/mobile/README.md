# ZLI Remote

The phone app for ZLI. It pairs with the ZLI desktop app over the local network and lets you
follow agents, answer their approvals and questions, send them messages, start new ones, and use a
shell in a worktree.

The phone never talks to the runtime directly. It connects to the desktop's Phone access gateway,
which is off until you turn it on, over a channel encrypted with keys that stay on the two devices.
The gateway forwards only an allowlist of commands; see `packages/remote-protocol/src/policy.ts`.

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

## Pair a phone

1. On the desktop, open Settings, then Phone access, and turn on Allow phones on this network.
2. Choose Pair a new phone. A QR code appears for five minutes.
3. In ZLI Remote, scan the code, or copy it on the desktop and paste it into the app.
4. Name the phone and choose Pair. The phone shows up under Paired phones on the desktop.

The phone and the desktop need to be on the same network, and the desktop's firewall has to allow
the gateway's port (47321 unless it was taken). To remove a phone, revoke it on the desktop or
choose Forget in the app's settings.

## Notifications

The app asks to send notifications the first time it opens after pairing, and Settings shows whether
they are on. It compares each update from the desktop with the one before and alerts when an agent
asks for approval, asks a question, finishes a turn, fails, or stops. Nothing is sent for the
conversation already on screen, and an answered request removes its notification. Tapping one opens
that agent.

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
- `metro.config.js` lets Metro resolve the `./file.js` imports the TypeScript workspace packages use.

## Limits

- Local network only. There is no relay, so the phone cannot reach the desktop from elsewhere.
- No push service. The phone posts its own notifications and live status, so they only change while
  it is connected.
- On Android the foreground service keeps the connection open in the background while an agent is
  busy, and the app disconnects once none is. iOS suspends the app soon after it leaves the screen:
  the Live Activity then says to open the app, and a button press reconnects for a few seconds to
  send the answer.
- The Android `specialUse` foreground service has to be explained in the Play Console before release.
- Messages are plain text. Markdown, diffs, and attachments stay on the desktop.
- The terminal shows recent output as text and sends typed lines and a few keys. Full-screen
  programs such as editors do not render on the phone.
