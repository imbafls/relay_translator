# Hosted relay

A multi-tenant relay on Cloudflare Workers, so users can get internet-reachable
phone viewers without running a server. One Durable Object per streamer.

## Why this exists

`packages/relay` is single-tenant by construction. It holds one publisher
(`server.ts:207`), one flat viewer map and one global `currentLanguages`, and a
second streamer connecting evicts the first (`server.ts:556`, "publisher
replaced by new connection"). So `relay.supr.systems` serves exactly one person
at a time and cannot be offered to users at all — not for want of credentials,
but because the program cannot do it.

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
| stops retrying on close `4401` (`uplinkClient.ts:119`) | 4401 on a bad secret, sent **after** upgrading — an HTTP rejection would be retried forever |
| retries other close codes | `4409` when a second publisher takes the room |
| `${relayUrl}/ws/uplink?token=…` (`main.ts:186`) | `/ws/uplink?token=` |
| `Authorization: Bearer <publisherToken>` → `{viewerToken}` (`main.ts:213`) | same, Bearer first, query fallback |
| `/health` → `{ok, live, viewers}` | same payload; `docs/OPEN-WORK.md` diagnoses production with exactly those fields |

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

    node scripts/verify-deploy.cjs    https://<your-worker>   # 14 checks
    node scripts/verify-isolation.cjs https://<your-worker>   #  9 checks

`verify-deploy` covers the uplink handshake, a viewer joining mid-stream and
receiving the state it missed, captions arriving with their segment id intact,
the viewer count reaching the uplink, per-room `/health`, 4401 on a bad
credential for either role, and rotation actually killing the old link (4410 to
the connected viewers, then 4401 when the dead link is retried). It claims its
own room each run - reusing a fixture makes a successful rotation look like a
failure, which is exactly how it misled me once.

`verify-isolation` runs two streamers at once, which the single-tenant relay
could not do at all: both uplinks stay up, each viewer gets its own room's
languages, neither room's captions reach the other, one room's secret cannot
open another, and each room counts only its own viewers.

Both passed against the live deployment on 2026-09-06 (14/14 and 9/9):
https://callout-relay-hosted.omertaji.workers.dev

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

## Still open

- No abuse control on `POST /claim`. Anyone can mint rooms. Rooms are worthless
  without their secrets and idle ones cost nothing, but a rate limit belongs
  here before the endpoint is public.
- Idle rooms are never reaped. A room's record is tiny, but there is no TTL.
- **An unexplained viewer socket.** The room the desktop app is attached to
  reports one viewer with nothing watching. It is not the app (which holds a
  single Cloudflare connection, the uplink), not a browser tab, and not a tag
  bug - a fresh room with only an uplink correctly reports zero, and captions
  do not echo back to the uplink. A real viewer joining still counts correctly
  on top of it (1 -> 2). Cosmetic today, since the number is only shown in the
  app's readout, but it is unaccounted for and should be chased before anyone
  relies on the count.
- **The URL carries the account name.** `<worker>.<account-subdomain>.workers.dev`
  - the subdomain is account-wide and changeable only in the dashboard, under
  Workers & Pages, not through wrangler or the API. A custom domain would need
  the zone on Cloudflare; `supr.systems` is on Hostinger nameservers and served
  by Vercel, so that is a migration rather than a setting.
