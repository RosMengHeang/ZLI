# ZLI Remote Anywhere (Relay) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paired phone controls the desktop from any network with only the ZLI apps installed: direct on the same Wi-Fi, through a free Cloudflare relay everywhere else, with no change to ZLI's encryption or pairing trust.

**Architecture:** The relay is a dumb, untrusted byte pipe. The desktop dials out to it (no inbound port); the phone dials in; the relay joins the two sockets of a session and forwards frames. The existing end-to-end handshake (`openRemoteSession` / `acceptClientHello`, pinned desktop key, device credential) runs unchanged through the pipe, so a compromised relay can drop traffic but cannot read, forge, or pair. The phone tries LAN first, then the relay. Tailscale stays a separate optional mode, out of scope here.

**Tech Stack:** TypeScript, zod, vitest, `ws`, Cloudflare Workers + Durable Objects (WebSocket Hibernation API), wrangler, Electron main process, Expo / React Native.

**Spec:** No separate spec. The Design Decisions below, taken from the design discussion on branch `feat/remote-anywhere-relay`, are the spec. Existing remote design lives in `v2/apps/mobile/README.md`.

## Design Decisions (from the discussion)

1. **Phase 1 is a byte relay, not WebRTC/TURN.** It reuses the existing protocol untouched, needs no native WebRTC module, and costs $0 on Cloudflare's free plan. Direct P2P (WebRTC) is an optional later optimization, not in this plan.
2. **Route order:** saved LAN hosts first with a 1500 ms head start, then the relay; whichever completes the end-to-end handshake first wins. "Same Wi-Fi" is never decided by SSID, only by a verified handshake.
3. **Pairing works from anywhere** because the QR scan itself proves physical presence at the desktop screen. The desktop still requires an explicit "Allow this phone" confirmation.
4. **Room id is derived, not stored:** `room = Id16(SHA-256(relaySecret)[0..16])`. The desktop proves ownership by sending `relaySecret` once; the relay recomputes the hash. The QR carries only the room id, never the secret.
5. **Remote is off by default**, has a kill switch, and relay-route sessions cannot use terminal input unless a separate toggle is on.
6. **Budget:** $0 on the free plan, up to $5/month on Workers Paid. A hard per-room message budget keeps one abuser from exhausting the quota.

## Global Constraints

- Do not change `REMOTE_PROTOCOL_VERSION` (stays `1`); new fields are optional so old phones and desktops keep working.
- Do not weaken or bypass `acceptClientHello`, `AttemptLimiter`, `MAX_UNAUTHENTICATED`, or `checkPhoneMessage`.
- The relay never sees plaintext and holds no device keys, credentials, pairing secrets, or `relaySecret` at rest (only the connection-time proof).
- The desktop opens no new listening port for the relay; it only makes outbound `wss://` connections.
- No logging of frame contents; relay logs carry room-id prefix (8 chars), event, and counts only.
- The relay URL ships in app config (`ZLI_RELAY_URL`, default `wss://relay.example.invalid`), never hardcoded in protocol code. The owner's domain is substituted at deploy time.
- Follow existing patterns: `.js` import suffixes, biome formatting, tests beside source as `*.test.ts`.
- Commit messages end with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. A relay that tampers with or replays frames: handshake or channel must fail closed, never downgrade. (Task 8)
2. All relay-originated connections share the relay's address: the per-address limiter would either lock out everyone or none. (Task 4)
3. A phone is revoked or "Disconnect all" is pressed while sessions are live over the relay: they must close at once. (Task 4)
4. The phone is on home Wi-Fi but the LAN host is stale and the relay is reachable: it must fall back without showing an error. (Task 6)
5. The desktop sleeps or loses network: the phone must show "PC unreachable", not hang, and the relay must not accumulate half-open sessions. (Tasks 3, 6)

---

## File Structure

| File | Responsibility |
|---|---|
| `v2/packages/remote-protocol/src/relay.ts` (new) | `RelayRoute` schema, `roomIdFromSecret`, `relayUrl`, relay control messages |
| `v2/packages/remote-protocol/src/pairingCode.ts` (modify) | optional `relay` field in the QR payload |
| `v2/apps/relay/` (new package) | Worker entry, `RelayRoom` core class, Durable Object shell, limits |
| `v2/apps/desktop/src/remote/RelayHost.ts` (new) | outbound relay connection, dials a socket per session into the gateway |
| `v2/apps/desktop/src/remote/MobileGateway.ts` (modify) | public `accept(socket, origin)`, per-origin limiter keys, route-aware policy |
| `v2/apps/desktop/src/remote/MobileAccessStore.ts` (modify) | `relay` settings and sealed `relaySecret` |
| `v2/apps/desktop/src/remote/electronMobileAccess.ts` (modify) | start/stop relay, status, pairing code includes relay |
| `v2/packages/contracts/src/` (modify, `MobileAccessStatus`) | relay state fields |
| `v2/apps/web/src/settings/MobileAccessSection.tsx` (modify) | "Connect from anywhere" toggle and status |
| `v2/packages/remote-protocol/src/policy.ts` (modify) | route-aware terminal-input rule |
| `v2/apps/mobile/src/lib/routes.ts` (new) | `raceRoutes` LAN-then-relay connector |
| `v2/apps/mobile/src/lib/link.ts`, `pairingRecord.ts` (modify) | use `raceRoutes`, store `relay` and `lastRoute` |
| `v2/apps/mobile/src/screens/ConnectionBanner.tsx` (modify) | route badge |
| `v2/tests/remote-relay.e2e.test.ts` (new) | desktop + relay + phone client integration and hostile-relay tests |
| `v2/apps/mobile/README.md` (modify) | replace "local-network only" claims |

Run tests from `v2/`: `pnpm vitest run <path>`.

---

### Task 1: Relay route in the protocol package

**Files:**
- Create: `v2/packages/remote-protocol/src/relay.ts`, `v2/packages/remote-protocol/src/relay.test.ts`
- Modify: `v2/packages/remote-protocol/src/index.ts`, `v2/packages/remote-protocol/src/pairingCode.ts`, `v2/packages/remote-protocol/src/pairingCode.test.ts`

**Interfaces:**
- Produces:
  - `RelayRoute = z.object({ url: z.string().url().startsWith("wss://"), room: Id16 })`
  - `roomIdFromSecret(secret: Uint8Array): string` (first 16 bytes of `hashSecret(secret)`, base64url)
  - `relayUrl(route: RelayRoute, role: "phone" | "host", session?: string): string` producing `wss://host/v1/phone/<room>`, `.../v1/host/<room>`, `.../v1/host/<room>/<session>`
  - `RelayHostMessage` (zod union): `{type:"claim", secret: Key32}`, server-to-host `{type:"open", session: Id16, client: string}` where `client` is an opaque per-client key (hash of the connecting IP computed by the relay, max 64 chars), host-to-server `{type:"ping"}`
  - `PairingCode.relay?: RelayRoute`

- [ ] **Step 1: Write failing tests** in `relay.test.ts`: `roomIdFromSecret` is deterministic, 22 chars, matches `Id16`; different secrets give different rooms; `relayUrl` yields the three exact URL shapes above; `RelayRoute` rejects `ws://` and `http://`; in `pairingCode.test.ts`, a code with `relay` round-trips through `encodePairingCode`/`decodePairingCode`, and a code without `relay` still decodes (old QR compatibility).
- [ ] **Step 2: Run** `pnpm vitest run v2/packages/remote-protocol/src/relay.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `relay.ts` with the signatures above; add `relay: RelayRoute.optional()` to `PairingCode`; export from `index.ts`.
- [ ] **Step 4: Run** both test files — Expected: PASS.
- [ ] **Step 5: Commit** `feat(remote-protocol): relay route and room id`

---

### Task 2: Relay core (`RelayRoom`) and Worker shell

**Files:**
- Create: `v2/apps/relay/package.json`, `tsconfig.json`, `wrangler.toml`, `src/RelayRoom.ts`, `src/RelayRoom.test.ts`, `src/worker.ts`, `src/RoomObject.ts`
- Modify: none (workspace glob `apps/*` already picks it up)

**Interfaces:**
- Consumes: `roomIdFromSecret`, `RelayHostMessage`, `Id16`, `Key32` (Task 1)
- Produces: `interface PipeSocket { send(data: string | ArrayBuffer): void; close(code: number, reason?: string): void }` and `class RelayRoom` with:
  - `constructor(roomId: string, options: RoomLimits, now?: () => number)`
  - `claimHost(socket: PipeSocket, secret: string): boolean` — true only if `roomIdFromSecret(fromBase64Url(secret)) === roomId`; replaces any previous host socket (old one closed with code 4000)
  - `phoneConnected(socket: PipeSocket, client: string): "queued" | "rejected"` — assigns session id, sends `open` to the host, starts a 10 s dial timeout
  - `sessionHostConnected(session: string, socket: PipeSocket): boolean` — joins the pair, flushes frames the phone sent while waiting
  - `onFrame(from: "phone" | "host", session: string, data: string | ArrayBuffer): void` — forwards to the other side
  - `onClose(from: ..., session: string): void` — closes the peer, frees the session
  - `RoomLimits` fields are defined in Task 3
- `worker.ts` routes `/v1/phone/:room`, `/v1/host/:room`, `/v1/host/:room/:session` (WebSocket upgrade only, everything else 404) to one `RoomObject` per room id via `idFromName(room)`. `RoomObject` is a thin Durable Object using the Hibernation API that adapts sockets to `PipeSocket` and calls `RelayRoom`.

- [ ] **Step 1: Write failing tests** in `RelayRoom.test.ts` using fake `PipeSocket`s: wrong secret → `claimHost` false and nothing opens; right secret → true; `phoneConnected` with no host → `"rejected"` and socket closed with 1013; with host → host receives `{type:"open", session, client}`; frames sent by the phone before the host dials arrive at the host in order after `sessionHostConnected`; a frame from host reaches only the matching phone; closing either side closes the other; a second `claimHost` closes the first host with 4000.
- [ ] **Step 2: Run** `pnpm vitest run v2/apps/relay/src/RelayRoom.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `RelayRoom` (in-memory maps, no I/O) and the Worker/DO shell. Keep every decision in `RelayRoom` so it is testable in plain Node; the DO only translates events. Add `"dev"`/`"deploy"` scripts using `wrangler`.
- [ ] **Step 4: Run** the tests — Expected: PASS. Then `pnpm --filter ./v2/apps/relay exec wrangler dev --local` boots and a manual `wscat` to `/v1/phone/<room>` with no host closes with 1013.
- [ ] **Step 5: Commit** `feat(relay): room core and worker shell`

---

### Task 3: Relay abuse limits and budget

**Files:**
- Modify: `v2/apps/relay/src/RelayRoom.ts`, `RelayRoom.test.ts`, `RoomObject.ts`, `wrangler.toml`

**Interfaces:**
- Produces: `interface RoomLimits { maxPendingPhones: number; maxActiveSessions: number; maxFrameBytes: number; dialTimeoutMs: number; idleTimeoutMs: number; messagesPerDay: number; handshakeBytesCap: number }` and `DEFAULT_LIMITS = { maxPendingPhones: 4, maxActiveSessions: 8, maxFrameBytes: 8 * 1024 * 1024 + 4096, dialTimeoutMs: 10_000, idleTimeoutMs: 60_000, messagesPerDay: 150_000, handshakeBytesCap: 256 * 1024 }`

- [ ] **Step 1: Write failing tests** (fake clock): 5th pending phone is rejected with 1013; 9th active session rejected; a frame over `maxFrameBytes` closes that session with 1009; a session sending more than `handshakeBytesCap` bytes before the host has sent its first frame is closed (stops unauthenticated flooding of the host); host that never dials within `dialTimeoutMs` closes the phone with 1013; a session silent for `idleTimeoutMs` is closed; after `messagesPerDay` forwarded frames in a UTC day the room refuses new frames until the next day and the host is told once with `{type:"budget"}`; host heartbeat missing for 2× `idleTimeoutMs` marks the room offline so new phones are rejected immediately (Review Focus 5).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the limits inside `RelayRoom` with an injected clock. In `RoomObject` use `acceptWebSocket` (hibernation) so idle sockets are not billed for duration, and set an alarm for idle sweeps. In `wrangler.toml` add a rate-limit binding keyed by `CF-Connecting-IP`, 30 upgrades/minute, applied in `worker.ts` before routing.
- [ ] **Step 4: Run** tests — Expected: PASS.
- [ ] **Step 5: Commit** `feat(relay): abuse limits, budget, hibernation`

---

### Task 4: Gateway accepts relay sockets with safe origin handling

**Files:**
- Modify: `v2/apps/desktop/src/remote/MobileGateway.ts`, `MobileGateway.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `type ConnectionOrigin = { route: "lan"; address: string } | { route: "relay"; client: string }` and `MobileGateway.accept(socket: WebSocket, origin: ConnectionOrigin): void`. The existing `server.on("connection")` path calls `accept(socket, { route: "lan", address })`. `#accept` is refactored to take the origin instead of an `IncomingMessage`. Relay origins use limiter key `relay:<client>` and share one extra cap `MAX_UNAUTHENTICATED_RELAY = 4` on top of the existing `MAX_UNAUTHENTICATED`. `disconnect(deviceId)` and `stop()` already close relay sessions because they are tracked in the same maps (verify in test).

- [ ] **Step 1: Write failing tests:** a relay-origin socket completes a full resume handshake exactly like a LAN one (reuse the existing test helpers); 21 attempts from one `client` are rate limited while a different `client` is not (Review Focus 2); 5 concurrent unauthenticated relay sockets from different clients → the 5th is closed with `tryAgain`, and LAN sockets are unaffected; `disconnect(deviceId)` closes a connected relay session with `notPaired` (Review Focus 3).
- [ ] **Step 2: Run** `pnpm vitest run v2/apps/desktop/src/remote/MobileGateway.test.ts` — Expected: new tests FAIL, existing tests still pass.
- [ ] **Step 3: Implement** the refactor; keep every existing constant and phase check; the route is recorded per connection for Task 7.
- [ ] **Step 4: Run** the full gateway test file — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): gateway accepts relay sockets with per-client limits`

---

### Task 5: Desktop `RelayHost`

**Files:**
- Create: `v2/apps/desktop/src/remote/RelayHost.ts`, `RelayHost.test.ts`

**Interfaces:**
- Consumes: `relayUrl`, `RelayHostMessage`, `RelayRoute` (Task 1); `MobileGateway.accept` (Task 4)
- Produces: `class RelayHost` with `constructor(options: { route: RelayRoute; secret: Uint8Array; gateway: Pick<MobileGateway, "accept">; createSocket: (url: string) => WebSocket; onState: (state: RelayState) => void; now?: () => number })`, `start(): void`, `stop(): void`; `type RelayState = "off" | "connecting" | "online" | "offline" | "budget-exhausted"`.

Behavior: dial `relayUrl(route, "host")`, send `{type:"claim", secret}`, heartbeat `{type:"ping"}` every 20 s; on `{type:"open", session, client}` dial `relayUrl(route, "host", session)` and call `gateway.accept(socket, { route: "relay", client })`; reconnect with exponential backoff 1 s → 60 s with jitter; refuse to open more than 8 sessions at once; `stop()` closes the control socket and every session socket.

- [ ] **Step 1: Write failing tests** with fake sockets: sends `claim` on open; an `open` message dials the session URL and hands the socket to `gateway.accept` with the `client` key; control-socket close → state `offline` then reconnect after backoff (fake timers); `budget` message → `budget-exhausted` and no reconnect storm; `stop()` closes everything and never reconnects; a malformed server message is ignored, not thrown.
- [ ] **Step 2: Run** `pnpm vitest run v2/apps/desktop/src/remote/RelayHost.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `RelayHost`. Validate every server message with `RelayHostMessage`; never log frame contents.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): outbound relay host`

---

### Task 6: Phone route racing (LAN then relay)

**Files:**
- Create: `v2/apps/mobile/src/lib/routes.ts`, `routes.test.ts`
- Modify: `v2/apps/mobile/src/lib/pairingRecord.ts` (+test), `v2/apps/mobile/src/lib/link.ts` (+test)

**Interfaces:**
- Consumes: `relayUrl`, `RelayRoute`, `openRemoteSession`
- Produces:
  - `StoredPairing.relay?: RelayRoute` and `lastRoute?: "lan" | "relay"`
  - `type RouteResult = { session: RemoteSession; route: "lan" | "relay"; host?: string }`
  - `raceRoutes(options: { lanHosts: string[]; port: number; relay?: RelayRoute; open: (url: string, signal: AbortSignal) => Promise<RemoteSession>; lanHeadStartMs?: number /* default 1500 */; }): Promise<RouteResult>`. Starts LAN attempts immediately and the relay after `lanHeadStartMs` (immediately if there are no LAN hosts, or if `lastRoute` was `"relay"`); first successful handshake wins and aborts the rest; a failure that is **blocking** (`not-paired`, `handshake`, `pairing-code`) from any route ends the race at once; if all fail, rejects with the most informative `RemoteConnectError` (prefer non-`network`).
  - `link.ts` `#connectOnce` uses `raceRoutes`, records `lastRoute`, and exposes `route` on the link snapshot.

- [ ] **Step 1: Write failing tests** with fake `open`: LAN succeeds in 200 ms → relay never starts; LAN stalls and relay succeeds → result route `"relay"` and LAN attempts aborted; LAN stale (fails fast `network`) → relay starts without waiting out the head start (Review Focus 4); both blocked with `handshake` → rejects `handshake`, not `network`; no relay configured → behaves exactly like today; `lastRoute: "relay"` skips the head start; result is never a LAN success when its handshake failed (no route reports success without a completed session).
- [ ] **Step 2: Run** `pnpm vitest run v2/apps/mobile/src/lib/routes.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `raceRoutes`, extend `StoredPairing` (optional fields, old stored pairings still parse), and switch `link.ts` over. Message for all-failed relay-only case: "Your PC is not reachable. Check that it is on and connected to the internet." (`failureMessages.network` stays for LAN-only pairings).
- [ ] **Step 4: Run** `pnpm vitest run v2/apps/mobile/src/lib` — Expected: PASS, existing `link.test.ts` and `pairingRecord.test.ts` unchanged and green.
- [ ] **Step 5: Commit** `feat(mobile): connect over LAN first, then relay`

---

### Task 7: Desktop settings, status, and relay-route policy

**Files:**
- Modify: `v2/apps/desktop/src/remote/MobileAccessStore.ts`, `electronMobileAccess.ts`, `v2/packages/contracts/src/` (`MobileAccessStatus`), `v2/apps/web/src/settings/MobileAccessSection.tsx` (+test), `v2/packages/remote-protocol/src/policy.ts` (+test), `MobileGateway.ts`

**Interfaces:**
- Consumes: `RelayHost` (Task 5), `roomIdFromSecret` (Task 1), `ConnectionOrigin` (Task 4)
- Produces:
  - Store: `relay: { enabled: boolean; remoteTerminalInput: boolean }` (both default `false`) and a sealed `relaySecret` created on first enable via the existing `SecretCodec`; methods `setRelayEnabled(enabled: boolean)`, `setRemoteTerminalInput(enabled: boolean)`, `relaySecret(): Uint8Array | undefined`; disabling relay deletes the secret so the old room id dies (rotating it also invalidates any leaked QR).
  - `MobileAccessStatus.relay: { enabled: boolean; state: RelayState; remoteTerminalInput: boolean }`
  - `checkPhoneMessage(input, projection, options?: { route?: "lan" | "relay"; remoteTerminalInput?: boolean })` — for `route: "relay"` without `remoteTerminalInput`, `terminal.create` and `terminal.write` return `{ kind: "reject", commandId, reason: "Terminal input from outside your network is turned off on the desktop." }`; every other command is unchanged.
  - Pairing code built in `electronMobileAccess.ts` includes `relay: { url: <ZLI_RELAY_URL>, room }` only when `relay.enabled`.
  - UI: switch "Connect from anywhere" (off by default) with one-line honesty copy, a second switch "Allow terminal input from anywhere" (off by default), a status line (Connecting / Online / Offline / Daily limit reached), and the existing "Disconnect all phones" also closes relay sessions.

- [ ] **Step 1: Write failing tests:** store round-trips `relay` settings and never writes the secret unsealed; `checkPhoneMessage` rejects `terminal.write` on the relay route by default and allows it on `lan` and when `remoteTerminalInput` is true; `MobileGateway` passes the connection's route into the policy; `mobileAccess.test.ts` shows the pairing code has no `relay` when disabled and has the derived room when enabled; component test: toggling the switch calls the bridge and shows the status line; disabling hides remote input toggle.
- [ ] **Step 2: Run** the touched test files — Expected: FAIL.
- [ ] **Step 3: Implement** the store fields, status plumbing through `preloadApi`/bridge (follow how `enabled` is plumbed today), `RelayHost` start/stop tied to `relay.enabled && gateway.listening`, and the UI.
- [ ] **Step 4: Run** the touched tests plus `v2/apps/desktop/src/preload.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): connect-from-anywhere setting and relay-route policy`

---

### Task 8: End-to-end and hostile-relay tests

**Files:**
- Create: `v2/tests/remote-relay.e2e.test.ts` (Node-only; real `RelayRoom` behind a local `ws` server, real `MobileGateway`, real `RelayHost`, real `openRemoteSession`)

**Interfaces:**
- Consumes: everything above. Produces: no new APIs.

- [ ] **Step 1: Write the tests:**
  - Happy path: pair and resume through the relay, run one runtime command, see the reply.
  - **Hostile relay** (a test relay wrapper that mutates traffic): flipping one bit in any client→host or host→client frame closes the session with a handshake/channel failure and nothing is forwarded to the runtime; replaying a captured handshake frame in a new session fails; a relay that routes a phone to a different desktop's room fails because the pinned desktop key does not match.
  - A relay-only observer sees no plaintext: assert known command text never appears in captured relay bytes.
  - Unknown device on the relay route is refused with `notPaired` and counts against its client key.
  - Revoke while connected over the relay closes the phone within 1 s.
  - Desktop offline: phone gets `network` failure promptly and the room holds no queued sessions afterwards (Review Focus 5).
- [ ] **Step 2: Run** `pnpm vitest run v2/tests/remote-relay.e2e.test.ts` — Expected: PASS. Any hostile-relay test that passes by luck must be re-checked by temporarily breaking the check it relies on.
- [ ] **Step 3: Commit** `test(remote): relay end-to-end and hostile-relay suite`

---

### Task 9: Mobile route badge, docs, and deploy

**Files:**
- Modify: `v2/apps/mobile/src/screens/ConnectionBanner.tsx` (+test if one exists), `v2/apps/mobile/src/screens/SettingsScreen.tsx`, `v2/apps/mobile/README.md`
- Create: `v2/apps/relay/README.md`

- [ ] **Step 1: Write failing test** for the banner label mapping: route `lan` → "Home Wi-Fi", `relay` → "Remote", offline → existing copy. Run it; Expected: FAIL.
- [ ] **Step 2: Implement** the badge and update the README sections that say "local-network only" so they describe the LAN-first, relay-fallback behavior, the threat model (relay sees metadata only: room id, timing, sizes, client IP), and the off-by-default setting.
- [ ] **Step 3: Relay README** with deploy steps: domain DNS on Cloudflare, `wrangler.toml` custom domain `relay.<owner-domain>`, `wrangler deploy`, set `ZLI_RELAY_URL` for desktop and mobile builds, usage alert at 70% of free quota, owner-account 2FA and registrar lock.
- [ ] **Step 4: Run** the full affected suites: `pnpm vitest run v2/packages/remote-protocol v2/apps/relay v2/apps/desktop/src/remote v2/apps/mobile/src v2/tests/remote-relay.e2e.test.ts` and `pnpm -w typecheck` — Expected: all PASS.
- [ ] **Step 5: Commit** `feat(mobile): route badge; docs and deploy notes for the relay`

---

## Self-Review

- **Spec coverage:** LAN-first then relay (Task 6); free Cloudflare relay on the owner's domain (Tasks 2, 3, 9); pairing from anywhere with desktop approval, unchanged (Task 7 reuses the existing flow); security layers: end-to-end untrusted relay (Task 8), no inbound port (Task 5), limits (Tasks 3, 4), remote terminal input toggle (Task 7), kill switch and revoke (Tasks 4, 7); budget under $5 (Task 3 limits). Tailscale-optional mode is deliberately excluded (separate plan).
- **Deviation from the discussed plan:** the discussion proposed WebRTC P2P + TURN. This plan ships a byte relay first because it reuses the protocol unchanged and needs no native module; P2P can follow as an optimization behind the same `raceRoutes` interface.
- **Type consistency:** `RelayRoute`, `roomIdFromSecret`, `relayUrl`, `ConnectionOrigin`, `RelayState`, `RoomLimits`, and `raceRoutes` are defined once and referenced by the same names in later tasks.
- **Open items to confirm during execution:** exact Cloudflare free-tier limits and WebSocket billing at build time (verify against current pricing; the plan's numbers are from memory); whether the Expo build exposes `ZLI_RELAY_URL` through `app.json` extra or an env file (follow how existing push config is read); the `MobileAccessStatus` file location inside `packages/contracts/src`.
