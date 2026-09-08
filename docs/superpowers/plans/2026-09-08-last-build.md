# 0.7.0 Last Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app survive weeks unattended — captions heal after a network drop, nothing claims to be working when it isn't, a forgotten session stops costing money — and give the owner a way to get evidence back when nobody is there to collect it.

**Architecture:** Four targeted fixes in the embedded relay and the desktop app, plus one new subsystem: a user-pressed feedback path whose redaction runs client-side and whose endpoint is a new `POST /feedback` route on the hosted Worker backed by a new R2 bucket.

**Tech Stack:** pnpm monorepo, TypeScript strict, Node >= 20, vitest + happy-dom, Electron (Windows-only), Cloudflare Workers + Durable Objects + R2.

**Spec:** `docs/superpowers/specs/2026-09-08-last-build-design.md` — binding. Read it before any task.

## Global Constraints

- **The two public promises stay true.** `home.html` says "No account, no telemetry"; the 0.5.11 changelog says of `relay.log` "Nothing in it leaves your PC on its own". **Nothing may upload without a person pressing send.** No scheduler, no retry queue, no crash auto-send, no opt-in toggle. If any change would make an upload automatic, stop and escalate — the site copy would have to change in the same commit.
- **No account, no identifier.** No install id, no fingerprint, no counter that identifies a machine across sends.
- **Redaction runs client-side, before the upload.** Server-side redaction would mean the secret already left the machine.
- **A redaction test asserts the secret is ABSENT from the output** — never merely that a replacement string appeared. A redactor tested only for its replacement is the vacuous-guard shape this repo has been bitten by four times.
- **`apps/hosted-relay` takes no npm dependencies** and may not import `@callout-relay/shared`. Local copies with a comment saying why. A platform binding (R2) is not a dependency.
- **Watch every new test fail before writing the code that satisfies it.** Three separate guards in the 0.6.0 branch turned out to assert less than they appeared to.
- **No `vi.mock`** — zero test files in this repo use it. Tests stand up real sockets and real markup.
- **Every id referenced from `app.ts` / `app.js` must exist literally in its markup**, or `node scripts/check-renderer-ids.mjs` fails the gate.
- **CRLF:** several files are CRLF. Patching with `\n`-anchored patterns is a known trap.
- **Commit messages:** short imperative subject naming the effect, body explaining the failure and why the change is right, `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. No conventional-commit prefixes.
- **The git index is shared.** `git add` exactly the listed paths. Never `git add -A`, never `git commit -a`. The tree holds an uncommitted `.gitignore` edit and an untracked `IDEA.md` that are not this branch's work.
- **Full gate:** `pnpm -r build`, `pnpm -r typecheck`, `pnpm typecheck:test`, `pnpm test`, `node scripts/check-renderer-ids.mjs`, `pnpm smoke`.
- **Do not bump the version and do not tag.** The release is the owner's call.

**Infrastructure already provisioned:** R2 bucket `callout-relay-feedback` exists on account `c9b5a04c1a901e52c8d99c576ee55f90`. Do not create it.

---

### Task 1: The speech pipeline stops giving up

**Files:**
- Modify: `packages/relay/src/session.ts`
- Test: `packages/relay/test/session.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: a session that keeps attempting reopens indefinitely, and an `error`-level log line when it enters the degraded state.

**Background.** `STT_REOPEN_DELAYS_MS = [300, 1000, 3000, 8000]` at `session.ts:70`. `sttReopens` resets only in `onOpen` (`:265`), so four consecutive failures exhaust the ladder permanently. When the machine is offline the attempts do not wait — `new WebSocket(...)` fails on DNS in milliseconds — so the whole budget burns in ~12.3 s. The `delay === undefined` branch (`:356`) emits `onSttError` and `return`s, arming no timer. Nothing else calls `openStt()`.

- [ ] **Step 1: Write the failing tests**

Two tests in `packages/relay/test/session.test.ts`, following the file's existing `makeStt` seam and fake-clock idiom (read the four reconnect tests at `:546-601` first — they already build what you need):

1. **It keeps trying after the ladder is spent.** Close the stream more times than `STT_REOPEN_DELAYS_MS` is long, advance the clock past the new tail interval, and assert another `makeStt` call happened. Against current code this fails: the fifth reopen never comes.
2. **The give-up reaches disk.** Assert `deps.log` was called at `error` level with a message naming the outcome. Against current code only `onSttError` fires.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/relay/test/session.test.ts -t "keeps trying"`
Expected: FAIL — no further `makeStt` call after the ladder is exhausted.

- [ ] **Step 3: Give the ladder an endless tail**

Add beside the existing constant:

```ts
/**
 * After the fast ladder is spent we keep trying, for ever, at this interval.
 * A captioning tool that has already lost captions has nothing left to protect
 * by staying down, and the thing that ends a session is a person pressing STOP.
 * Before this, four failures inside ~12 s - which is what an offline machine
 * produces, since the connect fails on DNS in milliseconds rather than waiting -
 * ended captions permanently for that session.
 */
const STT_REOPEN_TAIL_MS = 30_000;
```

In the `delay === undefined` branch: log at `error` level, call `onSttError` as it does today, then **re-arm at `STT_REOPEN_TAIL_MS` instead of returning**. Keep the attempt counter climbing so the message can say how many attempts have been made, but never stop.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/relay` — expected PASS, and the existing reconnect tests still green.

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/session.ts packages/relay/test/session.test.ts
git commit -m "Keep trying to reopen speech instead of giving up for the session"
```

---

### Task 2: The app stops saying ON AIR when speech is dead

**Files:**
- Modify: `packages/shared/src/index.ts`, `packages/relay/src/server.ts`, `apps/standalone/src/main.ts`, `apps/standalone/renderer/app.ts`
- Test: `apps/standalone/test/renderer.test.ts`

**Interfaces:**
- Consumes: Task 1's degraded state.
- Produces: `ControlStatus.relay.sttLive?: boolean`.

**Background.** `recomputeState()` (`app.ts:653-657`) derives `live` from `relayClient?.state === "connected" && capture.capturing` — a loopback socket and a running microphone. Neither observes STT. The relay's own `isLive()` does go false and viewers *are* told "speech pipeline lost"; only the streamer's own app lies. The give-up message reaches the renderer as a publisher `error` frame whose only handler appends to the LOG view — a screen the user is not on.

- [ ] **Step 1: Write the failing test**

In `apps/standalone/test/renderer.test.ts`, using that file's own `bootWith` / `pushStatus` / `settle` helpers: boot into a live session, push a status whose `relay.sttLive` is `false`, and assert the topbar does **not** read `ON AIR`. Read how the existing topbar tests read that element before writing the assertion.

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL — the topbar still reads ON AIR.

- [ ] **Step 3: Carry `sttLive` through the status**

`packages/shared/src/index.ts`, in `ControlStatus.relay` (~`:1074`), beside `uplinkState`:

```ts
    /** whether the speech pipeline is currently connected; absent on a remote relay */
    sttLive?: boolean;
```

`packages/relay/src/server.ts`: report it from the session's existing STT liveness. `apps/standalone/src/main.ts`: pass it through into the status it pushes.

- [ ] **Step 4: Render it**

`apps/standalone/renderer/app.ts`: when the session is live but `sttLive === false`, the topbar reads **`ON AIR · NO SPEECH`**. Follow the existing topbar rendering; do not invent a new element. `sttLive === undefined` must behave exactly as today — a remote relay does not report it, and an absent field must not read as dead.

- [ ] **Step 5: Run the tests and the id guard**

Run: `npx vitest run apps/standalone && node scripts/check-renderer-ids.mjs && pnpm -r typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/index.ts packages/relay/src/server.ts apps/standalone/src/main.ts apps/standalone/renderer/app.ts apps/standalone/test/renderer.test.ts
git commit -m "Stop showing ON AIR when the speech pipeline is down"
```

---

### Task 3: The hosted room learns when the app is actually live

**Files:**
- Modify: `packages/shared/src/index.ts`, `packages/companion/src/uplinkClient.ts`, `apps/standalone/src/main.ts`, `apps/hosted-relay/src/room.ts`, `packages/relay/src/server.ts`
- Test: `packages/companion/test/uplinkClient.test.ts`, `apps/hosted-relay/test/room.test.ts`, `packages/shared/test/speakerTag.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `live?: boolean` on the `UplinkToServer` hello.

**Background.** `startUplink()` runs at app boot with no session gate. The Worker's hello handler has no `live` field to read, so `room.ts:304-305` does `room.live = true` unconditionally — **a hello is the liveness signal**. The room is re-marked live on every uplink reconnect, every relay restart, and every settings change while idle (`main.ts:460-468`). Anyone holding the link sees ON AIR and a clock counting from the app's launch.

- [ ] **Step 1: Write the failing tests**

1. `packages/companion/test/uplinkClient.test.ts` — an uplink that connects with `live: false` puts that on the wire. (The frame-recording harness added in 0.6.0 is already there.)
2. `apps/hosted-relay/test/room.test.ts` — a hello with `live: false` leaves a viewer joining afterwards told `live: false`. That file already drives the real `Room.webSocketMessage` against a hand-written `DurableObjectState`; extend it, do not rewrite it.

- [ ] **Step 2: Run them and watch them fail**

Expected: FAIL — the room reports `live: true` regardless.

- [ ] **Step 3: Carry it**

`UplinkToServer`'s hello gains `live?: boolean`. `uplinkClient.ts` puts it on the hello it opens with and on `sendHello`. `main.ts`'s `startUplink()` sets it from whether a session is running (`sessionStartedAt !== undefined`), and the `applyConfig` re-hello path does the same. `room.ts` uses `room.live = msg.live === true`. `server.ts`'s uplink hello handler does the same for a self-hosted relay.

- [ ] **Step 4: Extend the hop guard — carefully**

**This step has a trap. Read it fully before touching the guard.**

`packages/shared/test/speakerTag.test.ts` checks `BRAND_FIELDS = ["brandName", "brandColor"]` against **every** hello literal in `HELLO_HOPS`. **Do not add `"live"` to `BRAND_FIELDS`** — the publisher hello in `relayClient.ts` has no liveness concept and would fail, and `ServerToViewer` hellos already carry `live` for an unrelated reason, so a broad check would pass trivially on some hops and break others.

Add instead a **narrow** check over the uplink hello specifically: the literals in `uplinkClient.ts` and the call sites in `main.ts` that build an uplink hello must name `live`. Follow the existing call-site-discovery block (the one covering `main.ts`'s `uplink.connect(` / `uplink.sendHello(`) rather than the `type: "hello"` literal block.

**Watch it fail:** remove `live` from one uplink hello, confirm the guard goes red naming that hop, restore.

- [ ] **Step 5: Run everything**

Run: `npx vitest run && pnpm -r typecheck`

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/index.ts packages/companion/src/uplinkClient.ts apps/standalone/src/main.ts apps/hosted-relay/src/room.ts packages/relay/src/server.ts packages/companion/test/uplinkClient.test.ts apps/hosted-relay/test/room.test.ts packages/shared/test/speakerTag.test.ts
git commit -m "Tell the room whether anybody is actually streaming"
```

---

### Task 4: Latency reads the current stream

**Files:**
- Modify: `packages/relay/src/session.ts`
- Test: `packages/relay/test/session.test.ts`

**Background.** `streamWallStart` is stamped once on the first audio frame (`:426`) and never reset, but `audioEndSec` restarts at zero on every new speech socket. So from the first reconnect on, every caption's latency reads the wall-clock age of the session — reproduced at 603000 ms ten minutes in. `silentMs` cannot compensate: `audio()` advances `lastAudioAt` on every chunk whether or not the socket accepted it.

- [ ] **Step 1: Write the failing test**

Force a close, let the ladder reopen, feed a final whose `audioEndSec` restarts near zero, and assert the reported stt latency is small — not roughly the session age. Note `session.test.ts:172-197` already covers the adjacent MUTE case; do not duplicate it.

- [ ] **Step 2: Run it and watch it fail** — expected: the badge reads ~the session age.

- [ ] **Step 3: Stamp per stream**

Set a per-stream wall start in the `onOpen` handler at `:262`, which already runs on every reopen, and subtract that instead of `streamWallStart`. Keep `silentMs` — it exists for the mute case and still earns its place. Leave `streamWallStart` if other call sites need it; only the latency arithmetic changes.

- [ ] **Step 4: Run the tests** — `npx vitest run packages/relay`, including the existing latency guards.

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/session.ts packages/relay/test/session.test.ts
git commit -m "Measure latency against the stream in hand, not the whole session"
```

---

### Task 5: A quiet session stops paying for silence

**Files:**
- Modify: `packages/shared/src/index.ts`, `packages/relay/src/session.ts`
- Test: `packages/relay/test/session.test.ts`

**Background.** `audio()` bills every chunk the socket accepted, times the channel count. Silence is indistinguishable from speech, both here and at Deepgram, which bills streamed audio rather than recognised words. The only automatic stop is `capture.onSourceLost` at zero live sources — and a loopback / Stereo Mix source does not disappear when the game closes; it streams digital silence at 32 kB/s per channel for ever. `powerSaveBlocker` holds the machine awake to do it. At $0.0043/min that is ~$43/week on one channel.

**Scope discipline.** Bound the *spend*, not the session. A streamer who stepped away for lunch must not come back to a dead link and no explanation. Do **not** stop the session, do not tear down capture, do not touch `powerSaveBlocker`.

**A trap the plan originally walked into, ruled before dispatch.** The obvious
design — stop forwarding after a period with no *final transcript*, resume on the
next final — **deadlocks**: if no audio is forwarded, no transcript can be
produced, so no final can ever arrive and the session is wedged silent for ever.
Task 1 sharpens it, since after Task 1 the pipeline reopens indefinitely and a
dead-pipeline hour would trip the bound and never release it.

**So the gate is locally-measured audio level, not finals.** `audio()` already
receives raw 16-bit PCM, so a peak/RMS per chunk costs nothing and needs no help
from the paid engine. The detector runs whether or not forwarding is on, which is
what makes recovery possible. It also targets the real failure mode more
precisely: a loopback source streaming digital silence after the game closed.

The "no final" signal is dropped deliberately — a streamer speaking a language the
engine is failing to transcribe is still producing audio worth paying for.

- [ ] **Step 1: Write the failing tests**

1. Feed chunks that are **all below the silence floor** for longer than the quiet period on a fake clock, and assert (a) no further audio reaches the STT seam, and (b) `deps.log` was called at `error` level naming the elapsed time and the reason.
2. Then feed a chunk **above the floor** and assert forwarding resumes immediately. This is the test that would have caught the deadlock.
3. Feed normal speech-level audio for longer than the period and assert nothing is ever cut off.

- [ ] **Step 2: Run them and watch them fail** — audio keeps flowing for ever today.

- [ ] **Step 3: Add the bound**

`packages/shared/src/index.ts`: `AppConfig` gains

```ts
  /** minutes of unbroken silence before the relay stops paying to transcribe it; 0 disables */
  idleBillingStopMinutes?: number;
```

with a default of `60` beside the other defaults. `session.ts`: compute a cheap peak per chunk, track when audio was last above a silence floor, and once the configured period passes with everything below it, stop forwarding to the paid engine and log at `error` level. **Resume the instant a chunk rises above the floor.** `0` disables the bound entirely.

Make the floor a named constant with a comment explaining the number — a floor set too high clips a very quiet speaker, and that is the failure mode worth documenting for whoever tunes it later.

- [ ] **Step 4: Run the tests** — `npx vitest run packages/relay packages/shared && pnpm -r typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/index.ts packages/relay/src/session.ts packages/relay/test/session.test.ts
git commit -m "Stop paying to transcribe an hour of silence"
```

---

### Task 6: Redaction, before anything leaves the machine

**Files:**
- Create: `packages/shared/test/redact.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `export function redactLog(text: string): string`.

**Background.** `grep -rn "redact"` across `packages/*/src` and `apps/*/src` returns **nothing** — this is a new component. A real `relay.log` inspected on 2026-09-08 carried a LAN IP (`192.168.8.187`) and the Windows account name in update paths (`C:\Users\omert\AppData\Local\...`). `CLAUDE.md` records a past redaction that "masked the token field and left the token in the URL", which is why query parameters get their own rule.

**This is the security-critical component of the build.** It is what makes "keys never leave your machine" true for a log the user chooses to send.

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/redact.test.ts`. For **each** pattern below, the test asserts the secret string is **absent from the output** — `expect(out).not.toContain(secret)` — never merely that a replacement appeared:

| Pattern | Example input |
|---|---|
| Deepgram-shaped key (40 hex) | `"key=" + "a".repeat(40)` |
| Gemini-shaped key | `AIzaSyD-0123456789abcdefghijklmnopqrstu` |
| Relay token (32 hex — `generateToken()` is 16 random bytes) | a 32-char hex string |
| `token=` / `key=` query parameter | `wss://textrelay.cc/ws?token=<32 hex>` |
| RFC1918 address | `http://192.168.8.187:8787`, plus `10.` and `172.16-31.` cases |
| Windows account name | `C:\Users\omert\AppData\Local\...` |

Plus **one test that ordinary lines survive unchanged** — a log with no secrets must come back byte-identical, so redaction is not quietly mangling normal output. Use real lines from the sample in the spec.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/shared/test/redact.test.ts`
Expected: FAIL — `redactLog` is not exported.

- [ ] **Step 3: Write `redactLog`**

In `packages/shared/src/index.ts`. Order matters: redact query parameters **before** bare-token patterns, or a token inside a URL gets partially replaced and the URL rule then no longer matches it. Each replacement is a fixed marker (`<redacted>`, `<user>`, `<lan-ip>`) — never a partial mask, since a partial mask of a 32-hex token still leaks most of it.

- [ ] **Step 4: Run the tests** — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/index.ts packages/shared/test/redact.test.ts
git commit -m "Take the secrets out of a log before anybody can send one"
```

---

### Task 7: The Worker accepts a feedback report

**Files:**
- Modify: `apps/hosted-relay/wrangler.toml`, `apps/hosted-relay/src/index.ts`, `apps/hosted-relay/src/routes.ts`
- Test: `apps/hosted-relay/test/routes.test.ts` (extend), plus a new endpoint test alongside the existing ones

**Interfaces:**
- Consumes: nothing from other packages — this Worker takes no dependencies.
- Produces: `POST /feedback`.

**Infrastructure:** the R2 bucket `callout-relay-feedback` **already exists** on account `c9b5a04c1a901e52c8d99c576ee55f90`. Bind it, do not create it.

- [ ] **Step 1: Write the failing tests**

- An oversized `Content-Length` is refused **413 before the body is read**.
- A non-JSON content type is refused **415**.
- A well-formed report returns a short reference id.
- Over the rate limit → **429**.

Follow `apps/hosted-relay/test/`'s existing shape. `room.test.ts` shows how to drive Worker code against hand-written platform bindings with no `vi.mock`; do the same for an R2 stub (an object with `put`).

- [ ] **Step 2: Run them and watch them fail** — the route does not exist.

- [ ] **Step 3: Bind the bucket**

`wrangler.toml`:

```toml
# Feedback a person chose to send: a message, and optionally their own log
# after it has been redacted on their machine. Written once, read rarely, up
# to 1.5 MB - which is R2's shape and not KV's or D1's. This is the first
# storage this Worker has ever had; the no-dependencies rule is about npm
# packages, and a platform binding is not one.
[[r2_buckets]]
binding = "FEEDBACK"
bucket_name = "callout-relay-feedback"
```

and a second rate-limit namespace beside `CLAIM_LIMIT` (its own `namespace_id`), with a comment explaining the chosen limit the way `CLAIM_LIMIT`'s does.

- [ ] **Step 4: Add the route**

`routes.ts` gains a `feedback` kind for `POST /feedback`. `index.ts` handles it:

1. Rate-limit check **first** — the `claim` handler's comment explains why a refused request must cost nothing before any object is addressed. Follow it.
2. Refuse on `Content-Length` over the cap **before reading the body**: message ≤ 8 KB, log ≤ 1.5 MB.
3. Require a JSON content type; otherwise 415.
4. Write `YYYY/MM/DD/<id>.json` (message, app version, timestamp) and, when a log is attached, `YYYY/MM/DD/<id>.log`.
5. Return the id.

**Store nothing that identifies a machine.** No IP, no user agent, no install id. The id is generated per send.

- [ ] **Step 5: Run the tests** — `npx vitest run apps/hosted-relay && pnpm --filter @callout-relay/hosted-relay typecheck`

- [ ] **Step 6: Commit**

```bash
git add apps/hosted-relay/wrangler.toml apps/hosted-relay/src/index.ts apps/hosted-relay/src/routes.ts apps/hosted-relay/test/
git commit -m "Take a problem report from somebody who chose to send one"
```

---

### Task 8: The app sends it, and shows exactly what it will send

**Files:**
- Modify: `apps/standalone/renderer/index.html`, `apps/standalone/renderer/app.ts`, `apps/standalone/src/main.ts`, `apps/standalone/src/preload.ts`
- Test: `apps/standalone/test/renderer.test.ts`

**Interfaces:**
- Consumes: `redactLog` from Task 6, `POST /feedback` from Task 7.

**Background.** The spec's strongest promise is that **a person sees exactly what will leave** before it leaves. That preview is not decoration — it is the mechanism that makes the privacy claim checkable by the user rather than trusted.

- [ ] **Step 1: Write the failing tests**

1. With a log containing a secret, the preview shown in the UI **does not contain the secret**.
2. Nothing is sent until the send control is pressed — assert the IPC send was not called on open, on typing, or on ticking the checkbox.
3. With the checkbox unticked, the payload carries no log at all.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Add the markup**

In `apps/standalone/renderer/index.html`, inside the `data-group="app"` group (this is about the app, not about viewers): a `SEND FEEDBACK` field with a message textarea, an *include my log* checkbox, a preview area, and a send button. New ids must be distinct from every existing one; `check-renderer-ids.mjs` covers them.

- [ ] **Step 4: Wire it**

Renderer reads the log through a new IPC call, runs `redactLog` on it, shows the result in the preview, and posts to the Worker only on the send press. `main.ts` exposes reading `relay.log` and nothing else. `preload.ts` carries the new bridge method.

**Never send an unredacted log.** Redaction happens before the preview, and the previewed text is the text that is sent — the same string, not a re-read.

- [ ] **Step 5: Run everything** — `npx vitest run apps/standalone && node scripts/check-renderer-ids.mjs && pnpm -r typecheck`

- [ ] **Step 6: Commit**

```bash
git add apps/standalone/renderer/index.html apps/standalone/renderer/app.ts apps/standalone/src/main.ts apps/standalone/src/preload.ts apps/standalone/test/renderer.test.ts
git commit -m "Let somebody send a problem report, after showing them what is in it"
```

---

### Task 9: Read what arrives, and say what changed

**Files:**
- Create: `apps/hosted-relay/scripts/read-feedback.cjs`
- Modify: `packages/shared/src/changelog.ts`, `docs/OPEN-WORK.md`

- [ ] **Step 1: The reader**

`read-feedback.cjs`, in the same shape as the existing `verify-deploy.cjs` and `read-cost.cjs` (read both first): lists what has accumulated in the bucket and downloads it. Usage line printed when run with no arguments, like its siblings.

- [ ] **Step 2: The changelog entry**

At the head of `CHANGELOG` in `packages/shared/src/changelog.ts`, version `0.7.0`, dated the day it is cut. Written for the streamer, per the file's own rule about not inventing significance. What actually changed for them:

- captions come back on their own after the internet drops, instead of stopping for good until they restart the session;
- the app says so when speech is down, instead of showing ON AIR;
- the phone link stops saying ON AIR when nothing is streaming;
- a session left running stops quietly paying to transcribe silence;
- there is a way to send a problem report with the log attached — after seeing exactly what it contains.

**No AI attribution, no emoji** anywhere in this file's strings. **Verify every claim against the code before writing it** — the 0.6.0 review caught a changelog line asserting a property the code did not have.

- [ ] **Step 3: Update the backlog**

`docs/OPEN-WORK.md`: record what this build closed, and — importantly for whoever reads it next — that **B6 (model download) has never been retried on a build containing the aliasing fix**. The failure in the owner's `relay.log` dated 2026-09-07T21:29:53 was on 0.5.12, eight seconds after that version installed; `f3f3d98` shipped in 0.5.13. Say that plainly so nobody re-derives it.

- [ ] **Step 4: Full gate, then hand back**

```bash
pnpm -r build && pnpm -r typecheck && pnpm typecheck:test && pnpm test && node scripts/check-renderer-ids.mjs && pnpm smoke
```

**Stop here.** The version bump, the tag and the deploy are the owner's call.

---

## Notes for whoever executes this

- **Tasks 1, 4 and 5 all modify `session.ts`.** They are ordered so each lands on the previous one's tree; do not run them in parallel, and re-read the file at the start of each rather than trusting a line number from this plan.
- **Both halves are needed again.** The endpoint reaches users on the next Worker deploy, the app half on the next release. The feedback path does nothing until both are out.
- **Line numbers here were correct on 2026-09-08.** Anchor on symbol names — `STT_REOPEN_DELAYS_MS`, `recomputeState`, `startUplink`, `streamWallStart`, `RoomState` — which do not drift.
- **If a test passes the first time you run it, assume it did not run** before assuming the code was already right. That happened four times in one session in `ITERATION_LOG.md`, and three more times in the branch that produced 0.6.0.
