# 0.7.0 — the last build before the app runs unattended

Date: 2026-09-08. This is the final planned release. After it ships, active
development stops and the app runs with nobody watching for an extended period.

That single fact sets every priority below. The question is not "what features
are missing" — `docs/OPEN-WORK.md` is nearly exhausted — it is **what breaks,
degrades, lies, or costs money when this runs for weeks with nobody watching,
and what would leave no evidence when it did.**

Four of the five items come from an adversarial audit run on 2026-09-08 (four
independent lenses, 25 findings raised, 19 refuted, 6 confirmed; two pairs were
the same defect found twice by different lenses, which is why they lead). The
fifth was asked for directly: a way to get data back when nobody is here to
collect it.

## Goals

1. **A transient network event must not permanently end the product's function.**
2. **The app must not claim to be working when it is not** — neither to the
   streamer nor to a viewer holding a link.
3. **An unattended session must not run up a bill.**
4. **When something does go wrong, evidence must survive** — on disk, and
   reachable by a person who is not at that keyboard.

Non-goals, each decided rather than deferred:

- **No background telemetry.** Decided with the owner. See Assumption A.
- **No new accounts, identifiers, or fingerprints.** The product's whole shape
  is accountless; a feedback path must not smuggle one in.
- **No code signing.** `OPEN-WORK.md` B4 is blocked on buying a certificate, not
  on engineering. Out of scope.
- **No parallel range downloads for models.** Already argued and rejected in
  `OPEN-WORK.md` B6; the decode is streaming, so out-of-order chunks would mean
  buffering ~1.55 GB to disk and adding an assembly failure mode to the path
  already suspected of being broken.

## Assumptions

**A. Two public promises constrain the feedback design, and both stay true.**
`home.html` says *"No account, no telemetry"* and *"Keys never leave your
machine, and neither does your audio"*. The 0.5.11 changelog says of `relay.log`:
*"Nothing in it leaves your PC on its own."* The owner chose the user-pressed
design specifically so that no copy has to change: a person pressing SEND is not
the file leaving "on its own", and a button is not telemetry. **If any later
change makes an upload automatic, the site copy must change in the same commit.**

**B. There is no redaction anywhere in this codebase.** `grep -rn "redact"`
across `packages/*/src` and `apps/*/src` returns nothing. A real `relay.log`
inspected on 2026-09-08 carried a LAN IP (`192.168.8.187`), the Windows account
name in update paths (`C:\Users\omert\AppData\Local\...`), model and config
choices, and the user's own channel labels. No API key appeared in that sample,
but nothing in the code prevents one — and `CLAUDE.md` records a past redaction
that "masked the token field and left the token in the URL". Redaction is
therefore a new component, it runs **client-side before the upload**, and it is
the security-critical part of this work.

**C. The Worker has no storage binding today.** `wrangler.toml` binds only
`ASSETS`, the `ROOM` Durable Object, and a rate limiter. There is no R2, KV or
D1. Accepting a log means adding the first one.

**D. `relay.log` is already bounded.** `fileLog.ts` caps at 1 MB and rotates in
place. So an upload has a known worst case and the endpoint can cap hard.

**E. The streamer-side view of STT health does not exist.** `recomputeState()`
derives `live` from `relayClient.state === "connected" && capture.capturing` —
a loopback socket and a running microphone. Neither observes STT. The relay's own
`isLive()` *does* go false and viewers *are* correctly told "speech pipeline
lost" (audit finding 11 fixed that half). Only the streamer's own app lies.

---

## A. Captions survive a network blip

**Severity: critical.** The single most on-target finding for an unattended run.

`STT_REOPEN_DELAYS_MS = [300, 1000, 3000, 8000]` (`session.ts:70`) and
`sttReopens` resets only inside `onOpen` (`:265`). So four consecutive failed
reopens exhaust the ladder **permanently for that session**. When the machine is
offline the attempts do not even wait — `new WebSocket(...)` fails on DNS in
milliseconds — so the whole budget is spent in ~12.3 s. The `delay === undefined`
branch (`:356`) emits one message and `return`s, arming no timer. Nothing else
calls `openStt()`.

Meanwhile the app shows ON AIR with a running clock, capture keeps going, and
`powerSaveBlocker` keeps the machine awake. The give-up message reaches the
renderer as a publisher `error` frame whose only handler appends a line to the
LOG view — a screen the user is not on.

Triggers: sleep/wake, a router reboot, an ISP re-dial, Deepgram credit
exhaustion, or any Wi-Fi drop longer than about fifteen seconds. Over weeks,
close to certain.

**The fix, three parts:**

1. **The ladder never terminates.** After the four fast attempts, keep retrying
   on a long capped tail (30 s, indefinitely) so the session heals itself the
   moment the network returns. A live captioning tool that has already lost
   captions has nothing left to protect by staying down.
2. **The outcome reaches disk.** The give-up/degraded transition calls
   `this.deps.log("error", …)`, not only `onSttError`. `relay.log` is the only
   thing a person can read afterwards.
3. **The app stops claiming ON AIR.** The relay reports STT health in its status
   (`sttLive`), and the topbar reflects it. A session whose speech pipeline is
   down reads **ON AIR · NO SPEECH**, not ON AIR.

Part 3 is what makes the difference between a self-healing outage and a silent
one, so it is not optional.

## B. The uplink reports real liveness

**Severity: important.**

`startUplink()` runs from `startEmbeddedRelay()` at boot, with no session gate.
On the Worker side the hello handler has no `live` field to read, so it does
`room.live = true` unconditionally (`room.ts:304-305`). **A hello is the
liveness signal.** The room is therefore marked live by an app that is merely
running, and re-marked on every uplink reconnect, every embedded-relay restart,
and every settings change while idle (`main.ts:460-468`).

Anyone holding the internet link sees ON AIR and a session clock counting up
from the app's launch time — for as long as the app sits in the tray.
`GET /health?token=…` agrees with the lie, so the one diagnostic endpoint
confirms it.

**The fix:** carry liveness explicitly. `live` joins the uplink hello payload
(the app knows: `sessionStartedAt !== undefined`), and `room.ts` uses
`room.live = msg.live === true`. The same change applies to the self-hosted
relay's uplink handler in `server.ts`.

**This is finding B's shape again** — a field that has to travel every hop or it
silently does nothing. The hello-hop guard added in 0.6.0
(`packages/shared/test/speakerTag.test.ts`) already reads these literals; the new
field must be added to what it checks, or the guard will pass while the field
goes missing.

## C. An unattended session stops billing for silence

**Severity: important.** The only failure here that costs real money.

`PublisherSession.audio()` bills every chunk the socket accepted, times the
channel count. Silence is indistinguishable from speech both here and at
Deepgram, which bills streamed audio rather than recognised words. The only
automatic stop is `capture.onSourceLost` when the live source count hits zero —
and a loopback / Stereo Mix source does not disappear when the game closes. It
streams digital silence at 32 kB/s per channel, forever. `powerSaveBlocker` holds
the machine awake to do it.

At the app's own estimate of $0.0043/min (`server.ts:966`) that is **~$6.20/day,
~$43/week** on one channel; two channels double it.

**The fix, deliberately the smaller half of what the audit proposed:** an idle
session is *bounded and logged*, not silently killed. After a configurable
quiet period with no final transcript (default 60 minutes), the session stops
forwarding audio to the paid engine, writes an `error`-level line to `relay.log`
naming why, and surfaces the reason in the app.

Stopping the whole session outright is rejected: a streamer who stepped away for
lunch would come back to a dead link and no explanation. Stopping the *spend*
and saying so is recoverable; ending the session is not.

## D. Latency reads the current stream, not the session

**Severity: minor. Ride-along.**

`streamWallStart` is stamped once on the first audio frame and never reset
(`session.ts:426`), but `audioEndSec` restarts at zero on every new speech
socket. So from the first reconnect onward, every caption's latency badge reads
roughly the wall-clock age of the session — reproduced at **603000 ms** ten
minutes in. `silentMs` cannot compensate, because `audio()` advances
`lastAudioAt` on every chunk whether or not the socket accepted it.

Nothing acts on the number, which is why this is minor. But it is the one
instrument that would show a real latency problem, and it becomes permanently
absurd exactly when nobody is watching closely enough to know it lies.

**The fix:** a per-stream wall start, set in the `onOpen` handler that already
runs on every reopen, subtracted instead of `streamWallStart`. `silentMs` stays,
for the mute case it was written for.

## E. Feedback and logs, sent only when a person presses send

**Severity: the reason the other four are worth fixing** — without it, the next
failure is as invisible as the last one was.

### The shape

A **SEND FEEDBACK** affordance in the desktop app: a message box, an optional
*include my log* checkbox, and a send button. Nothing is uploaded unless a
person presses it. There is no toggle, no scheduler, no retry queue, and no
identifier that survives between sends.

### Redaction runs on the client, before the upload

This is the load-bearing decision. Redacting server-side would mean the secret
had already left the machine, and *"keys never leave your machine"* would be
false in the only sense that matters.

`redactLog(text)` lives in `packages/shared` and removes:

| What | Why |
|---|---|
| Deepgram-shaped keys (40 hex) | the paid credential |
| Gemini-shaped keys (`AIza…`) | the paid credential |
| Relay tokens (32 hex — `generateToken()` is 16 random bytes) | grants publish or view on a room |
| `token=` / `key=` query parameters | `CLAUDE.md`: a past redaction "masked the token field and left the token in the URL" |
| RFC1918 addresses | the streamer's home network |
| `C:\Users\<name>` → `C:\Users\<user>` | the Windows account name |

Each pattern gets a test asserting the secret is **absent from the output**, not
merely that a replacement appeared. A redactor tested only for its replacement
string is the exact vacuous-guard shape this repo has been bitten by.

The redacted text is what the UI shows in a preview before sending. **A person
sees exactly what will leave.** That is a stronger promise than any policy, and
it is cheap.

### The endpoint

`POST /feedback` on the hosted Worker.

- **Rate limited** by IP, reusing the `[[ratelimits]]` binding pattern already
  in `wrangler.toml` for `CLAIM_LIMIT`, under its own namespace.
- **Size capped before the body is read**: `Content-Length` over the limit is
  refused with 413. Message ≤ 8 KB, log ≤ 1.5 MB (`relay.log` caps at 1 MB, so
  this has headroom without being unbounded).
- **Accepts JSON only.** Anything else is 415.
- **Returns a short reference id** the user can quote. It is generated per send
  and stored with the record; it is not a device id and does not persist.

### Storage

A new R2 bucket, bound as `FEEDBACK`. Objects are keyed
`YYYY/MM/DD/<id>.json` for the record and `YYYY/MM/DD/<id>.log` for an attached
log, so a month's worth sorts and lists naturally.

R2 rather than KV or D1: the payload is a blob up to 1.5 MB, it is written once
and read rarely, and R2 is the only one of the three whose pricing suits that.

**This is the first storage binding this Worker has ever had.** The
`apps/hosted-relay` no-dependencies rule still applies to npm packages; a
platform binding is not a dependency.

### Getting the data back

`apps/hosted-relay/scripts/read-feedback.cjs` lists and downloads what has
accumulated, so the data is usable without clicking through a dashboard. Written
in the same shape as the existing `verify-deploy.cjs` and `read-cost.cjs`.

### What is deliberately not built

- No automatic sending, on any schedule or trigger.
- No crash handler that sends without asking.
- No persistent install id, no fingerprint, no counter that identifies a machine
  across sends.
- No read endpoint on the Worker. Retrieval is an authenticated operator task
  through R2's own API, not a route a visitor could ever reach.

## Testing

Every guard is watched failing before the code that satisfies it, per the
repo's convention — and this repo's own lesson applies with force: three
separate guards in the 0.6.0 branch turned out to assert less than they
appeared to.

1. **The ladder heals.** Drive a session's STT closed more times than the
   ladder is long, and assert a reopen is still attempted afterwards. This is
   the test that would have caught A.
2. **The give-up reaches disk.** Assert the degraded transition writes an
   `error`-level line, not only an `onSttError` callback.
3. **The app stops saying ON AIR.** With `sttLive` false, the topbar must not
   read ON AIR.
4. **An idle app is not live.** Connect an uplink with no session; a viewer
   joining afterwards is told `live: false`.
5. **The hop guard covers the new field.** `live` joins what the hello-hop guard
   checks, and the guard is watched failing with it removed from one hop.
6. **A quiet session stops spending.** After the quiet period with no final, no
   further audio reaches the paid engine, and `relay.log` says why.
7. **Latency after a reconnect.** Force a close, let the ladder reopen, feed a
   final whose `audioEndSec` restarts near zero, and assert the badge is small
   rather than the session age.
8. **Redaction removes the secret.** For each pattern: the secret string is
   **not present** in the output. Plus a test that a log with no secrets is
   unchanged, so redaction is not quietly mangling ordinary lines.
9. **The endpoint refuses what it should.** Oversized `Content-Length` → 413;
   non-JSON → 415; over the rate limit → 429.

## Release

Ships as 0.7.0. Both halves are needed again, as in 0.6.0: the endpoint reaches
users on the next Worker deploy, the app half on the next release, and the
feedback path does nothing until both are out.

The changelog entry is written for the streamer, per `changelog.ts`'s own rule
about not inventing significance: captions now come back on their own after the
internet drops, the phone link stops saying ON AIR when nothing is streaming, a
forgotten session stops quietly costing money, and there is now a way to send a
problem report with the log attached — after seeing exactly what it contains.
