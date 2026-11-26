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
  "Relay daily limit reached." means the whole relay hit its cap for the UTC day.
- 4409: another desktop claimed the room. Only the desktop sees it, and it waits for its owner.

The desktop's own close codes (4000-4999) are passed on to the phone with their reason, cut to 120
bytes. Anything else from the far side reaches the phone as 1000. These codes are not
authenticated, so the phone treats them as hints: a "not paired" over the relay is shown but
retried.

## Limits

Defaults are in `src/RelayRoom.ts` (`DEFAULT_LIMITS`) and `wrangler.toml`.

- 4 phones waiting for the desktop to answer, and 8 sessions open, per room.
- Before the desktop first answers a session, the phone may send 8 frames and 256 KiB. Past that
  the session is closed. These frames are not counted against the daily budget.
- 150 000 forwarded frames per room per UTC day. After that, new sessions are refused with 1013
  until the next UTC day, and the desktop is told once. The local network is not affected.
- 30 requests per minute per connecting address (an IPv6 address counts by its /64).
  Requests over that get a 429. Any request counts, so probing costs the same as connecting.
- 2 000 000 forwarded frames per UTC day across the whole relay (`RELAY_DAILY_FRAMES` in
  `wrangler.toml`). Rooms report their counts to one `RelayCounter` Durable Object in batches of 64.
  Over the cap, new phone sessions are refused with 1013 "Relay daily limit reached."; sessions
  already open carry on.
- 8 MiB for one frame, 10 s to dial. A session is closed when either side has been silent for
  60 s. The desktop's control heartbeat counts for its side; a phone on the relay sends a sealed
  keepalive every 25 s, about 3 500 frames a day per phone.
- The desktop pings its control socket every 20 s. The Durable Object runtime answers those pings
  itself (`setWebSocketAutoResponse`), so an idle room does not wake for them; the room reads the
  last answer time when it next wakes or sweeps.

### Known gaps

- A distributed attacker (about 170 addresses over about an hour) can use up a room's daily budget
  through the desktop's counted replies. That denies relay service to that room for the day. The
  local network still works.
- The budget counter is saved every 8 frames, so an eviction can lose up to 7 counted frames. It
  can only under-count, by at most that much each time.
- Turning Connect from anywhere off and on again makes a new room. A paired phone learns the new
  room the next time it connects on the same network as the desktop; until then it cannot use the
  relay.
- The relay-wide counter is fed in batches, so it can run up to 63 frames per room behind, and an
  eviction can lose that many. The cap is a cost guard, not an exact count.

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
   also applies the migrations that create the `RoomObject` and `RelayCounter` classes.
5. Check it: `curl -i https://relay.<your-domain>/` should return 404. The Worker only answers
   WebSocket upgrades on `/v1/...`.
6. In the Cloudflare dashboard, add a usage notification at 70% of your plan's included requests
   and Durable Object usage. Look up the current free-tier limits and WebSocket billing before you
   rely on them.

## Before you publish a relay URL

The relay is self-hosted: it runs on your Cloudflare account and you pay for what it uses. Nobody
else runs one for you, and the app ships without a relay URL. Before you put `ZLI_RELAY_URL` in a
build or share it with anyone:

1. In the Cloudflare dashboard, set a usage notification for Workers requests and Durable Object
   usage, at a level you would want to hear about (for example 70% of what your plan includes).
2. If your plan has a spend limit or a way to stop paid usage, turn it on. On the free plan,
   Cloudflare stops the Worker when it runs out instead of billing you; check that this is still
   how it works for your account.
3. Set `RELAY_DAILY_FRAMES` in `wrangler.toml` to a number you are comfortable paying for in a day.
   It is the relay-wide cap above, and the room cap (150 000) still applies per desktop.
4. Remember that anyone with the URL can open sockets to it. The rate limit, the per-room limits
   and the daily cap bound what that costs you; they do not keep strangers out.

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
the desktop shows, and again, sealed, each time it connects, so there is nothing to set for a
mobile build. To change relays, change `ZLI_RELAY_URL` and restart the desktop. Paired phones pick
up the new route the next time they connect on the same network.

The protocol code never hardcodes a relay URL.
