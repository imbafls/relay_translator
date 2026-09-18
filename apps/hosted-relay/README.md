# Hosted relay

A multi-tenant relay on Cloudflare Workers, so users can get internet-reachable
phone viewers without running a server. One Durable Object per streamer.

## Why this exists

`packages/relay` is single-tenant by construction. It holds one publisher
(`server.ts:207`), one flat viewer map and one global `currentLanguages`, and a
second streamer connecting evicts the first (`server.ts:556`, "publisher
replaced by new connection"). The VPS that used to run it served exactly one
person at a time and could not be offered to users at all — not for want of
credentials, but because the program cannot do it. That VPS is retired.

This Worker answers on **`textrelay.cc`**, the product's own name and what the
app claims rooms on. `relay.supr.systems` still answers too, and so does the
`workers.dev` name: rooms claimed before the move keep working, and the app
moves when a release changes `HOSTED_RELAY_URL` rather than when a deploy
happens. The apex rather than a `relay.` subdomain, because the Worker serves
the landing page at `/` and the viewer at `/watch/<token>` — the viewer link is
the most-shared thing this project makes, and `textrelay.cc/watch/<token>` says
what it is.

Those three globals are what a Durable Object gives you per-room for free. The
room's logic is the old server's live half; isolation stops being something to
enforce and becomes structural.

## Why it is cheap

The hosted side does **no speech recognition and no translation**. The uplink
carries finished captions — the desktop app did that work locally on the user's
own Deepgram and Gemini keys. See the protocol comment in
`packages/shared/src/index.ts`:

> The uplink carries FINISHED subtitles: the remote relay does no STT/translation.

So this service holds no API keys, has no per-user API cost, and forwards a few
hundred short strings per stream.

## Hibernation is the design, not an optimisation

Cloudflare bills a Durable Object for **wall-clock duration while it holds an
accepted WebSocket**. A room that stayed resident through a four-hour stream
would be billed for four hours of compute to forward some text. Hibernation
evicts the object between messages, so it is billed only when it runs.

The consequence is the thing most likely to bite: **eviction is normal and
mid-stream, and every deploy evicts every room.** Nothing a viewer depends on
may live in an instance field. `languages`, `translates`, `since` and `live` are
read from `ctx.storage` on every wake. A field would pass local testing
perfectly and blank every live overlay the first time the service was
redeployed.

## Credentials

    p1_<rid>_<secret>   publisher - the uplink and the admin routes
    v1_<rid>_<secret>   viewer    - the token in a /watch/<token> link

`rid` is public. Both secrets are **stored random values, not derived**, which
is what makes rotation real: `POST /admin/rotate-viewer-token` mints a new
viewer secret and closes every viewer socket, and old links are dead. An HMAC
over a fixed room id could not do that without invalidating every room sharing
the key.

The room id comes out of the **token**, never the path, so there is no way to
address a room you hold no credential for.

Tokens stay inside `[A-Za-z0-9_-]` and contain no dot. Both are load-bearing:
`packages/relay/src/server.ts` and `packages/viewer/public/app.js` each match
`/watch/([A-Za-z0-9_-]+)`, and the dot is how a filename is told from a token.

## The asset trap

The viewer page references its assets relatively (`href="style.css"`), so a page
served at `/watch/<token>` requests `/watch/style.css`. `resolveRoute` maps any
dotted path under `/watch/` to the asset bundle, the same way the existing relay
does. Get it wrong and the overlay serves an unstyled page with no script — a
failure that looks like a broken relay.

## The app needs no changes

Verified against the real client:

| Client | Service |
| --- | --- |
| stops retrying on close `4401` (`uplinkClient.ts`) | 4401 on a bad secret, sent **after** upgrading — an HTTP rejection would be retried forever |
| stops on `4409` too, as "replaced by another machine" | `4409` when a second publisher takes the room |
| `uplinkUrlFor(relayUrl, token)` (`packages/shared`) - one trailing slash taken off | `/ws/uplink?token=` |
| `Authorization: Bearer <publisherToken>` → `{viewerToken}` (`main.ts:213`) | same, Bearer first, query fallback |
| `/health` → `{ok, live, viewers}` | same payload; `docs/OPEN-WORK.md` diagnoses production with exactly those fields. Per-room with the publish key or the current viewer link; any other token is a 403, so a link NEW rotated away no longer reads the room |

Point `relayUrl` at the deployment and paste the publisher token. Anyone running
their own relay is unaffected.

## Deploy

    cd apps/hosted-relay
    npx --yes wrangler deploy

No dependency is added to the workspace: `wrangler` is fetched on demand, the
way `postject` already is in the release workflow, so `pnpm install
--frozen-lockfile` in CI is untouched. `src/cf.d.ts` declares only the runtime
surface this service uses; `wrangler deploy` type-checks against the real
definitions.

## What is tested

**Unit** (`test/routes.test.ts`, 16 cases): routing, the token/filename
disambiguation, traversal refusal, token round-trip, the alphabet both existing
link checks enforce, malformed-token rejection, constant-time comparison.

**Against a real deployment** - the Durable Object runtime, which unit tests
cannot reach:

    node scripts/verify-deploy.cjs    https://<your-worker>   # 15 checks
    node scripts/verify-isolation.cjs https://<your-worker>   #  9 checks

`verify-deploy` covers the uplink handshake, a viewer joining mid-stream and
receiving the state it missed, captions arriving with their segment id intact,
the viewer count reaching the uplink - and reaching one that reconnects to
viewers already there - per-room `/health`, 4401 on a bad
credential for either role, and rotation actually killing the old link (4410 to
the connected viewers, then 4401 when the dead link is retried). It claims its
own room each run - reusing a fixture makes a successful rotation look like a
failure, which is exactly how it misled me once.

`verify-isolation` runs two streamers at once, which the single-tenant relay
could not do at all: both uplinks stay up, each viewer gets its own room's
languages, neither room's captions reach the other, one room's secret cannot
open another, and each room counts only its own viewers.

Both passed against the live deployment on 2026-09-07, on both names
(14/14 and 9/9 on the new one, 14/14 on the old):
https://textrelay.cc and https://relay.supr.systems

### Two things only deploying could catch

Cloudflare serves any path matching an asset **before** the Worker runs, and its
directory-index handling answered `/` with `index.html` - the viewer page -
instead of letting the router serve `home.html`. `/watch/<token>` was reaching
the right page by luck rather than by routing. `run_worker_first = true` fixes
it. No unit test could have seen this: the behaviour is in the platform, not in
the code.

Second, a socket for a room that does not exist answered **HTTP 404**, and
`uplinkClient` treats an HTTP failure as a transport error and retries forever -
so a user whose room had gone would have reconnected in a loop. An unknown room
now refuses the same way a bad credential does, with a 4401 close, which is what
stops the client. Found because a stale room id in the verification script
happened to point at a room that did not exist on the new account.

## Cost, honestly

Free tier covers Workers requests and SQLite-backed Durable Objects at small
scale, and hibernation keeps billed duration proportional to messages rather
than to stream length. The number that grows with usage is **duration while
awake plus egress**, not requests. I have not measured it against a real stream,
so the figures to check before opening this to users are: billed DO duration per
hour of a live room, and whether concurrent rooms stay inside the free tier's
daily duration allowance. Do that with two or three real streams before
inviting anyone.

## Rooms nobody uses

A room nobody has ever touched is removed 30 days after it was claimed. A
room somebody HAS touched is kept for ever, however old: age is not evidence
that a link has stopped mattering, and there is nobody to ask.

"Touched" is any authenticated use - a publisher connecting, a viewer
connecting, the owner reading or rotating the viewer token. Each proves a person
is on the other end. It is recorded once, on the first touch, so a room costs one
extra write in its life rather than one per reconnect.

The sweep runs from an alarm set when the room is claimed, under
`blockConcurrencyWhile` so it cannot race a request arriving at the same moment.
`src/reap.ts` holds the decision and `test/reap.test.ts` covers it; the window is
`UNTOUCHED_ROOM_TTL_MS`.

## A publisher that vanished

A streamer's PC that loses power, crashes or drops off the network never closes
its uplink, and nothing else a publisher does can end a stream here - so a room
used to stay ON AIR for good: viewers watching kept a running clock over
nothing, and everyone who opened the link later was greeted as live.

The uplink beats with the same `{"type":"ping"}` a viewer sends, every 20 s,
and the runtime records when it last answered. An OPEN uplink silent for
`UPLINK_SILENT_MS` (70 s) is closed with 4408 - the uplink reconnects from
that, so one that was only slow is back within seconds - and with no publisher
left the room tells viewers "stream ended", exactly as a clean close does. It
is checked whenever the room is awake anyway: a viewer joining, a viewer's
`sync`, `/health`. Viewers already watching wake nothing, so while a publisher
has declared a session live the same alarm the reap uses looks in every
`LIVENESS_CHECK_MS` (60 s) - about 60 billed requests and 60 row writes per
live hour, on top of the ~1,600 measured below. An app from before 0.8 says
hello with no `live` field at every boot; that still reads as live but never
starts the alarm, or an idle one in the tray would cost a request a minute all
day. `test/uplinkGone.test.ts` covers it.

## Still open

- ~~**An unexplained viewer socket, seen once**~~ — **closed 2026-09-18: a
  cause fits it, and the room can no longer hold one either way.** Since
  `dcaaded` the sweep also skips any socket the room has already closed, which
  the runtime keeps handing back in CLOSING until the peer answers, so neither
  a silent socket nor a closed one is counted. What follows is why it was open.

  The first room the desktop app
  attached to reported one viewer with nothing watching; a room claimed after
  the subdomain change reported zero from the same app, so it was that object
  rather than the service.

  The fitting explanation is a viewer socket that died without a FIN. The count
  is `getWebSockets("viewer").length`, and hibernation meant this object ran
  no timer for viewers — so a socket whose phone walked into a tunnel was held
  until something else closed it, and nothing else ever did. A room never
  opened reads zero; the first one, opened once to check it worked, reads one
  for ever. That matches every detail of the sighting, including why a fresh
  room was clean.

  It is a fit, not a proof — the original room is gone and nothing was captured
  from it at the time. What would confirm it is a room whose count stays above
  what `getWebSockets` reports after a reader force-quits a browser on mobile
  data.

  Either way the count is now self-correcting. Viewers send a heartbeat, the
  runtime records when each socket last auto-answered, and `liveViewers()`
  drops one that has been silent for 70 s — read on a wake-up that was going to
  happen anyway, so it needs no alarm and costs nothing. A socket that has
  **never** beaten is always left alone: that is a page served before the
  heartbeat shipped, and closing it would put a healthy reader in a reconnect
  loop.

  Original note: The room the desktop app is attached to
  reports one viewer with nothing watching. It is not the app (which holds a
  single Cloudflare connection, the uplink), not a browser tab, and not a tag
  bug - a fresh room with only an uplink correctly reports zero, and captions
  do not echo back to the uplink. A real viewer joining still counts correctly
  on top of it (1 -> 2). Cosmetic today, since the number is only shown in the
  app's readout, but it is unaccounted for and should be chased before anyone
  relies on the count.
- ~~**Cost is unmeasured.**~~ **Measured 2026-09-06, and it inverts the
  assumption this design was built on.**

  One room held live for 22 minutes with an uplink and a viewer, publishing 527
  captions (a dense stream - one every 2.5 s), read back from the GraphQL
  analytics API. Reproduce with `scripts/measure-cost.cjs` then
  `scripts/read-cost.cjs`, which print the exact window to query.

  | per hour of live room | measured |
  |---|---|
  | captions | 1,436 |
  | billed requests | 1,597 |
  | billed duration | **3.83 GB-s** |
  | active time | 30 s |

  An idle hour on the same account was 0.04 GB-s, so essentially all of that is
  the room.

  **That baseline predates the viewer heartbeat, and re-measuring is the only
  way to confirm the heartbeat is free.** Viewers now send `{"type":"ping"}`
  every 20 s. The room hands that exact frame to
  `setWebSocketAutoResponse`, so the runtime answers it without waking the
  object: no request, no duration, and the figures above should barely move
  with a viewer attached.

  If the pair ever stops matching what the page sends — one added space is
  enough — the beat falls through to `webSocketMessage`, which answers a ping
  too. **The viewer still gets its pong either way.** Nothing breaks, no test
  fails, `verify-deploy.cjs` passes, and the only thing that changes is that
  every beat wakes this object and is billed: roughly **180 requests per hour,
  per viewer**, on top of the 1,597 above. Watching a socket receive a pong is
  therefore not evidence of anything, which is what makes this worth writing
  down.

  So the check is the billing, not the behaviour: run `scripts/measure-cost.cjs`
  and `scripts/read-cost.cjs` against a room with one viewer attached for the
  window, and compare billed requests against the 1,597 in the table - plus
  the ~60 an hour the liveness alarm has added since that measurement (see "A
  publisher that vanished"), so about 1,660. Roughly that means the runtime is
  answering. About 1,840 means it is not, and the frames have drifted apart.

  **Hibernation works, and works so well that duration stopped being the
  question.** 3.83 GB-s/hr against the free plan's 13,000 GB-s/day is 3,400
  room-hours a day. The premise - that hosting friends is effectively free - is
  correct.

  **But the binding constraint is requests, not duration.** Every inbound
  WebSocket message on a hibernating object is a billed request, so a caption is
  a request. At 1,597/hr against the free plan's 100,000/day that is **63
  room-hours a day** - two or three people streaming a full evening. Duration
  allows fifty times more. The liveness alarm, added since, costs ~60 an hour
  more while live - about 60 room-hours a day - and alarm invocations count
  as requests on Cloudflare's price list.

  `measure-cost.cjs` sends worded captions only, and until 1.0 a real session
  did not: the app forwarded every wordless final too - one per couple of
  seconds of silence, 3,105 against 657 lines in one measured session - which
  is two to three times the requests above, each doing nothing on the far
  side. Since 1.0 the app sends only lines with words (`forwardsToUplink` in
  `packages/companion`), so the measurement and the traffic now agree. An
  older app still sends them until it updates.

  On the Workers Paid plan the included 1M requests/month is ~626 room-hours,
  and past that the whole cost is about **$0.29 per 1,000 room-hours**. Still
  nothing, but the number to watch is the request count, and the lever that
  would move it is batching or debouncing captions - not anything about
  hibernation.
- **`POST /claim` is rate limited, but loosely - know what that buys.** A
  `[[ratelimits]]` binding, 5 per 60s keyed on `CF-Connecting-IP`, checked
  before any room id is minted so a refused claim wakes no Durable Object.
  An IPv6 caller is counted by its /64 (`claimRateKey`): keyed on the full
  address, one host could send every request from a fresh address in its own
  subnet and never be refused, here or on `/feedback`.

  **Measured against the deployed service on 2026-09-06: the 25th sequential
  claim was the first to be refused.** That is the documented behaviour, not a
  misconfiguration - Cloudflare describes this API as "permissive, eventually
  consistent, and intentionally designed to not be used as an accurate
  accounting system", with counters cached per location and reconciled
  asynchronously. It is also per Cloudflare location, not global.

  So it caps sustained abuse and does **not** stop a burst. That is a
  reasonable trade for rooms that are worthless without their secrets and cost
  nothing idle; it is not a reasonable thing to assume means "five a minute".
  An exact limit would need a Durable Object counter on the claim path, which
  costs an invocation per claim to protect something nearly free.

  Those ~24 rooms from the measurement were never touched by anybody, so the
  sweep below removes them 30 days after they were claimed.
