# ZLI Remote

The phone app for ZLI. It pairs with the ZLI desktop app over the local network and lets you
follow agents, answer their approvals and questions, send them messages, start new ones, and use a
shell in a worktree.

The phone never talks to the runtime directly. It connects to the desktop's Mobile access gateway,
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

## Pair a phone

1. On the desktop, open Settings, then Mobile access, and turn on Allow phones on this network.
2. Choose Pair a new phone. A QR code appears for five minutes.
3. In ZLI Remote, scan the code, or copy it on the desktop and paste it into the app.
4. Name the phone and choose Pair. The phone shows up under Paired phones on the desktop.

The phone and the desktop need to be on the same network, and the desktop's firewall has to allow
the gateway's port (47321 unless it was taken). To remove a phone, revoke it on the desktop or
choose Forget in the app's settings.

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
- No push notifications. Approvals show up while the app is open; it disconnects in the background.
- Messages are plain text. Markdown, diffs, and attachments stay on the desktop.
- The terminal shows recent output as text and sends typed lines and a few keys. Full-screen
  programs such as editors do not render on the phone.
