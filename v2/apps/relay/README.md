# ZLI relay

A Cloudflare Worker with one Durable Object per paired desktop. It lets the phone app reach the
desktop when they are not on the same network. It passes encrypted frames between the two sockets
and does nothing else.

The phone tries the local network first and uses the relay only when that fails. The relay is off
unless the desktop owner turns on Connect from anywhere in Settings, Phone access.

## What the relay can and cannot see

It sees: the room id, when each side connects and disconnects, the size of each frame, and the
network address of the phone and of the desktop.

It cannot: read traffic, change or invent frames, or pair a device. Every frame is encrypted and
authenticated between the phone and the desktop with keys the relay never holds. A pairing through
the relay also needs a click on Allow in the desktop app (120 s). A "not paired" close that comes
only through the relay is shown on the phone but never makes it forget its pairing.

The desktop opens no inbound port for the relay. It dials out to the relay and keeps the socket open.

## Close codes the phone sees

- 4404: no desktop holds the room, or it did not dial back in time. The app says the PC is unreachable.
- 1013: the relay is busy, restarting, over a limit, or out of its daily budget. The phone retries.

Over the relay the phone cannot see the desktop's own close codes. The relay passes its own on.

## Limits

Defaults are in `src/RelayRoom.ts` (`DEFAULT_LIMITS`) and `wrangler.toml`.

- 4 phones waiting for the desktop to answer, and 8 sessions open, per room.
- Before the desktop first answers a session, the phone may send 8 frames and 256 KiB. Past that
  the session is closed. These frames are not counted against the daily budget.
- 150 000 forwarded frames per room per UTC day. After that, new sessions are refused with 1013
  until the next UTC day, and the desktop is told once. The local network is not affected.
- 30 requests per minute per connecting address (an IPv6 address counts by its /64).
  Requests over that get a 429. Any request counts, so probing costs the same as connecting.
- 8 MiB for one frame, 10 s to dial, 60 s idle before a session is closed.

### Known gaps

- A distributed attacker (about 170 addresses over about an hour) can use up a room's daily budget
  through the desktop's counted replies. That denies relay service to that room for the day. The
  local network still works.
- The budget counter is saved every 8 frames, so an eviction can lose up to 7 counted frames. It
  can only under-count, by at most that much each time.
- Turning Connect from anywhere off and on again makes a new room. Phones paired before need to pair
  again to use the relay.

## Deploy

You need a Cloudflare account on a domain you own, with its DNS on Cloudflare. Use two-factor
sign-in on the account and a registrar lock on the domain: whoever controls either one controls
which server the app talks to. Everything here is run from `v2/`.

1. Sign in: `pnpm --filter @zli-v2/relay exec wrangler login`.
2. In `apps/relay/wrangler.toml`, set the rate-limit `namespace_id` under `[[ratelimits]]`. It is
   a number you pick, unique within your Cloudflare account. It ships as `"1001"`; change it if
   another Worker of yours already uses that one.
3. Add the custom domain to the same file. Cloudflare creates the DNS record on deploy:

   ```toml
   routes = [{ pattern = "relay.<your-domain>", custom_domain = true }]
   ```

4. Deploy: `pnpm --filter @zli-v2/relay deploy` (this runs `wrangler deploy`). The first deploy
   also applies the `v1` migration that creates the `RoomObject` class.
5. Check it: `curl -i https://relay.<your-domain>/` should return 404. The Worker only answers
   WebSocket upgrades on `/v1/...`.
6. In the Cloudflare dashboard, add a usage notification at 70% of your plan's included requests
   and Durable Object usage. Look up the current free-tier limits and WebSocket billing before you
   rely on them.

For a local try-out, `pnpm --filter @zli-v2/relay dev` runs `wrangler dev`. Without the rate-limit
binding the per-address limit is skipped.

## Point the desktop at it

The desktop reads `ZLI_RELAY_URL` from its environment when it starts. It is read at run time, not
built into the app, so set it wherever the desktop is launched:

```sh
ZLI_RELAY_URL=wss://relay.<your-domain> pnpm desktop:dev      # from v2/, dev run
```

```powershell
$env:ZLI_RELAY_URL = "wss://relay.<your-domain>"; pnpm desktop:dev
```

For an installed build, set it as a user environment variable before launching the app. The value
must be a plain `wss://` URL with no query, fragment, or credentials; anything else counts as unset
and Connect from anywhere stays disabled ("This build has no relay set up.").

The mobile app has no relay setting. It gets the relay route (URL and room) from the pairing code
the desktop shows, so there is nothing to set for a mobile build. To change relays, change
`ZLI_RELAY_URL`, restart the desktop, and pair again.

The protocol code never hardcodes a relay URL.
