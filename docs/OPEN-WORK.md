# Open work

One place for everything known-but-unfinished, so it stops living in one
person's head. Written 2026-09-05 against v0.5.3; **rewritten 2026-09-06**
after the VPS was retired and a run of audit fixes landed.

Two sources feed this: the findings from [`AUDIT-2026-09-05.md`](AUDIT-2026-09-05.md)
(36 ranked findings) and the operational items that need a person, a credential,
or a piece of hardware.

**On severity:** the audit assigns no severity labels. It ranks its findings by
impact and states the ordering rule itself — "remotely reachable defects on
`relay.supr.systems` first, then code execution on the user's machine, then the
local failure paths." The **rank** column below is the audit's own number and is
the authoritative signal. The **band** column is derived from that rank and from
the audit's stated grouping; it is a reading aid, not a quote.

---

## Known limitations in 1.0

What 1.0 ships with, knowingly, and why none of it holds the release. Every
other open item was fixed before 1.0 was cut; `openWorkCurrent.test.ts` fails
if an open item is left anywhere in this file without either a fix or a line
here.

- **Updates are not code-signed (B4).** It needs a purchased certificate and an
  identity check, not a code change; until then an update is checked against
  the sha512 in the release's own `latest.yml`, and `isAllowedUpdateFeed()`
  refuses any feed that is not `https:` or loopback. Full entry under Blocked.
- **An archive model download may still fail on one reporting machine (B6).**
  It has never been reproduced here, where every archive model installs, and
  0.8.1 already pinned each archive to a SHA-256 and retries a failed attempt in
  a fresh folder - the fix that fits the report - so what remains is waiting for
  the instrumented error from that machine, which cloud speech does not need.
  Full entry under Blocked.
- **With a local model, STOP can take longer than it needs to (audit finding
  17 (part), low).** The close is still posted behind the queued audio on the
  same port, in `packages/relay/src/localSttWorker.ts`. With the deadline scaled
  to the worker going quiet, that costs a slower STOP rather than a lost
  caption; moving it out of band means changing the protocol on both sides, and
  the worker half needs sherpa-onnx to exercise at all. **Why it does not hold
  1.0:** nothing is lost - the last thing said still arrives - and a protocol
  change on both sides of the worker is the wrong thing to land in a release.
- **Nothing says what a second or third capture source costs until the money is
  already going out.** Deepgram bills every channel, so three sources is three
  times the per-minute spend: `packages/relay/src/session.ts` adds
  `seconds * channels` to the cloud counter and nothing at all to it for a
  local model. The app does show the spend - `metaStt` under `02 TRANSCRIBE`
  and the `EST` readout in `apps/standalone/renderer/app.ts` - but both only
  once a session is running, which is after the decision. The pickers that
  triple it are in `01 SOURCE`, three blocks earlier and minutes earlier, and
  they say nothing.
  What is wanted is a rate next to those pickers, shown only for a cloud model:
  local STT is free, and a cost hint over a local model would be worse than no
  hint at all. The exact wording is the owner's call, since it is the first
  place in the product that would quote a price.
  `packages/relay/test/billingPerChannel.test.ts` pins the multiplier this
  entry quotes - three sources bill three times one, a local model bills the
  cloud counter zero - so the number cannot rot between now and someone acting
  on it. Written down here 2026-09-15: it had been the single open item on an
  otherwise-finished multi-source feature, which is exactly how it stayed
  invisible for nine days.
  **Why it does not hold 1.0:** the spend is on screen the moment a session
  runs, the multiplier is pinned by that test, and the first price the product
  ever quotes is the owner's wording to choose, not a release's.
- **textrelay.cc has no mailbox.** Nothing the product ships sends mail or
  shows an address - problem reports go through `POST /feedback` into R2 - so
  the paid mailbox and DKIM are an owner task on the zone, not a release step.
- **The feedback bucket keeps everything for ever.** `callout-relay-feedback`
  has no R2 lifecycle rule, so reports accumulate until someone deletes them,
  and a sender spread across many networks pays the per-address limit once per
  network. One host no longer can - IPv6 is counted by /64 since 2026-09-18 -
  and a report is capped at ~1.5 MB. **Why it does not hold 1.0:** an expiry
  rule is an account setting on the bucket, the owner's to choose (how long a
  report is worth keeping is a policy, not a default), not a code change.

---

## Closed by retiring the VPS

The first three blockers in the previous version of this file were all "SSH into
the Hostinger box". **There is no box.** It was stopped on 2026-09-06 and
`textrelay.cc` (and still `relay.supr.systems`) is a Cloudflare Worker with one Durable Object per
streamer (`apps/hosted-relay`). Nothing needs mirroring, no tokens need setting
by hand — a room issues its own credentials on `POST /claim`.

The old entries are kept only as a pointer for anyone reading an older log:
mirroring the release to the VPS, setting `RELAY_PUBLISHER_TOKEN` /
`RELAY_VIEWER_TOKEN` on it, and rotating its API keys are all moot.

---

## Closed by v0.8.0

Written 2026-09-10. One feature, and the health items still open after 0.7.0.

- ~~**Saved transcripts.**~~ Every finished line and its translation is appended to
  disk while the session runs - `apps/standalone/src/transcripts.ts`, default
  `Documents\Callout Relay\Transcripts` - with a SAVED view to read and export
  them and `SETTINGS → THIS APP → TRANSCRIPTS` to switch it off or move it. The
  design, and the two traps it had to avoid, are in
  `docs/superpowers/specs/2026-09-10-local-transcript-saving-design.md`: the
  obvious tee (`onBroadcast`) is the viewers' masked copy, so the app taps the
  publisher echo through a new `RelayHandle.onTranscript`; and translation emits
  each utterance twice under one id, so records are appended separately and
  merged on read, keyed by the file's own `n` because relay ids restart on every
  reconnect.
- ~~**The self-hosted relay's `isLive()` answered ON AIR on socket presence.**~~
  Fixed in `packages/relay/src/server.ts`: an uplink is live on what its last
  hello or status said (`uplinkLive`), a publisher once its hello has built a
  session, and `stamp()` clears the session clock on a not-live hello - the
  asymmetry recorded below, fixed in the same change as that note asked. Two
  adjacent shapes turned up while fixing it and closed with it: a replacing
  uplink inherited the old one's word, and a publisher counted as live before
  its hello had said anything.
- ~~**The relay's Linux banner printed `data\relay-state.json`.**~~ Now built with
  `path.join`, the way `config.ts` writes the file.
- ~~**The capture worklet decimated with no anti-alias filter above 16 kHz.**~~ The
  entry below pointed at `packages/viewer/public/app.js`, which has no audio path
  at all; the resampler is `packages/companion/src/capture/workletSource.ts`. It
  now low-passes (a 63-tap Hann-windowed sinc) whenever it has to decimate, and
  leaves the 16 kHz path every session actually takes bit-for-bit unchanged. Run
  against the real processor source, a 12 kHz tone at 48 kHz went from full
  strength to under 5% (-26 dB), the bound the test holds it to.
- ~~**`HANDOFF.md` and `CLAUDE.md` described v0.5.1 and v0.5.3.**~~ Both rewritten
  against the tree; `docs/GUIDE.md` and `README.md` cover saved transcripts.

Each fix above shipped with a test that goes red when the fix is reverted, and
each revert was run.

**Found while shipping it, and since fixed:** `packages/shared/test/speakerTag.test.ts`
checked only the *first* `type: "subtitle"` text in each hop file. A type alias
placed above the relay's real uplink hop made the guard check the alias and
stop checking the hop; the alias was moved to `packages/shared` and the guard
went back to the hop, but only by accident of ordering - any earlier
`type: "subtitle"` text, a comment included, would have blinded it the same way.
Closed as this entry proposed: the scan now blanks comments, reads **every**
`type: "subtitle"` literal that carries a `source` field, and asserts the count
per file so that adding one forces somebody to look at it. A fixture holds the
scan to it - a complete literal above a hop that drops `color`, which reported
nothing before.

---

## Closed by the last build (v0.7.0)

Written 2026-09-08. Nine tasks, chosen against one fact: after 0.7.0 ships,
this product runs for weeks with nobody watching. All nine, plus the fix
rounds a whole-branch review afterward closed, shipped in **v0.8.0** on
2026-09-10. 0.7.0 itself was never tagged: its changelog entry ships inside
0.8.0's release, and a user updating from 0.6.0 is shown both.

- ~~**The speech pipeline no longer gives up for the session.**~~ The reopen
  ladder used to exhaust four attempts in ~12 s (`STT_REOPEN_DELAYS_MS`,
  `packages/relay/src/session.ts`) and stop for good, so one bad connection
  permanently ended captions. It now falls onto an endless 30 s retry tail
  (`STT_REOPEN_TAIL_MS`) once the fast ladder is spent, and narrates the
  transition into that tail once - not every attempt after, which would have
  filled `relay.log` on a week offline. `1e65dc8`, `8857de6`, `ecf4b2d`.
- ~~**The app stops claiming ON AIR when speech is dead.**~~ `sttLive` now
  reaches the desktop app; the topbar reads `ON AIR · NO SPEECH`
  (`apps/standalone/renderer/app.ts`) and the tray tooltip reads
  `live, no speech` (`apps/standalone/src/main.ts`). `8e57ca9`, `32c9959`.
- ~~**The hosted room stops treating "a hello arrived" as "somebody is
  streaming."**~~ The uplink hello now carries `live`, and `room.ts` on the
  hosted relay honours it instead of marking the room live unconditionally on
  every hello, every reconnect and every idle settings change. `ad8bd97`,
  `fb93f57`, `597a21e`. This closes the *hosted* half of the liveness problem
  only - the self-hosted relay's `isLive()` gap and the connected `stamp()`
  asymmetry, both below in "Not blocked", are a different code path
  (`packages/relay/src/server.ts`) and were explicitly out of this task's
  scope. Checked against what shipped: both notes still read correctly and
  neither has changed, so they are not duplicated here.
- ~~**Latency reads the current stream, not the whole session.**~~ Fixed in
  `84d9118`: `currentStreamWallStart` (`packages/relay/src/session.ts`) now
  resets on every STT reopen, not just once at session start, so a latency
  figure after a reconnect no longer measures against a stream that no
  longer exists.
- ~~**A quiet session stops paying for silence.**~~ A locally-measured peak
  detector (`SILENCE_PEAK_FLOOR`, `packages/relay/src/session.ts`) stops
  forwarding audio - to Deepgram or a local model alike - after
  `idleBillingStopMinutes` (default 60) of nothing clearing the floor, and
  resumes on the first chunk that does. Deepgram's socket is held open with
  `KeepAlive` meanwhile so it does not idle-close and flap the session.
  `4b1cbac`, `d1cb164`, `2141329`, `4121197`, `d30befc`, `c7a9b7b`, `837f116`,
  `e971c6e`.
- ~~**A way to send a problem report exists, and it is redacted before
  anything leaves the machine.**~~ `redactLog()` in `packages/shared/src/index.ts`
  strips keys, relay tokens, `/watch/` links, LAN IPs and the Windows account
  name. `9a54b4c`, `83f4519`, `237d31f`, `3ad32c5`.
- ~~**`POST /feedback`**~~ on the hosted Worker (`apps/hosted-relay/src/index.ts`)
  writes a rate-limited, size-capped report to a new R2 bucket
  (`callout-relay-feedback`), storing nothing that identifies a machine.
  `de5208b`, `d107abe`.
- ~~**SEND FEEDBACK in the app**~~ (`apps/standalone/renderer/app.ts`,
  `apps/standalone/src/main.ts`) previews exactly what will leave before
  anything is sent, and sends only on a press of SEND. The POST runs in the
  main process, not the renderer: the Worker answers no `Access-Control-*`
  headers on any route, by design, so a renderer `fetch()` is blocked by
  CORS. `e6f1cd8`, `ff23f12`.

Reading the bucket back is deliberately an operator task - there is no read
route on the Worker, so no visitor can ever reach it.
`apps/hosted-relay/scripts/read-feedback.cjs` lists what has accumulated and
downloads it, authenticated the same way `read-cost.cjs` is:
`CLOUDFLARE_API_TOKEN` if set, otherwise the OAuth token `wrangler login`
already stored on this machine - the same credential `wrangler r2 object get
--remote` itself resolves to, exercised against the real bucket while the
script was written.

The full entry is version `0.7.0` in `packages/shared/src/changelog.ts`;
`node scripts/release-notes.mjs 0.7.0` renders it.

---

## Blocked

### B4 — Code signing
**Band: high. Blocked on: a Windows code-signing certificate (a purchase and an
identity check, not an engineering task).**

`apps/standalone/package.json`'s `win` block sets no `publisherName` and the
build ships no certificate, so electron-updater's `NsisUpdater.verifySignature`
returns early (`if (publisherName == null) return null`). The **only** integrity
proof for an update is the sha512 in `latest.yml`.

`isAllowedUpdateFeed()` in `packages/shared/src/index.ts` bounds the blast
radius until then: `https:` only, with `http:` allowed solely for loopback, and
an unset feed meaning the packaged GitHub feed. That closes the drive-by and the
LAN-MITM paths; it does not make an update cryptographically verified.

**What unblocks it:** obtain a certificate, then set `win.publisherName` and
wire signing into `electron-builder`.

### B6 — In-app archive model downloads corrupt at ~28%
**Band: medium. Status: re-scoped by v0.8.1, still never reproduced here and
still never retried there. Instrumented 2026-09-07; two candidate causes fixed
the same day, one demonstrated end to end. v0.8.1 then pinned every archive to
a SHA-256 and gave each retry a staging folder of its own.**

> **What v0.8.1 closed, and what it did not.** `516247f` hashes the compressed
> bytes as they stream and refuses to publish anything whose digest is not the
> pinned one, so an archive that decoded and is still not the right bytes is now
> a named failure (`archive checksum mismatch`) instead of a model. It also
> retries three times, each attempt in its own numbered staging folder, because
> a leftover folder the scanner still held used to abort the next download
> **before its first request** - which is exactly the shape of the report below:
> both failures left an EMPTY `.part` directory and no model. That makes the
> leftover-abort a plausible whole explanation for the reported symptom.
>
> It is not a reproduction. The original ~28% corruption has never been seen on
> this machine, and no download has been attempted on the reporting machine on
> 0.8.1 or on any build since 0.5.12. Treat this as a hypothesis that fits the
> evidence until the instrumented message comes back from a real 0.8.1 failure.

> **Untested since the fix, as of 2026-09-08 - said plainly here so nobody
> re-derives it.** B6 has never been retried on a build that contains the
> aliasing fix. The failure in the owner's `relay.log` below is timestamped
> `2026-09-07T21:29:53Z`, eight seconds after the app restarted into
> **0.5.12** - the version whose resume-download rework is exactly what
> `f3f3d98` ("Stop handing the decoder bytes the socket is about to
> overwrite") fixed. That fix shipped in **0.5.13**. So the failure recorded
> just below was the aliasing regression, already fixed - but no model
> download has been attempted since, on 0.5.13 or any later build, so B6's
> original ~28% corruption symptom (first reported before 0.5.12's resume
> support existed, and not explained by the aliasing bug) remains untested on
> a build that has the fix.

> **Reported again 2026-09-07**, on `local-nemotron-streaming` and
> `local-whisper-turbo` - the two largest archives. Both left an EMPTY `.part`
> directory in `%APPDATA%\callout-relay\models`. Driving the same
> `local-nemotron-streaming` download through the real `ModelStore` in a real
> Electron main process on the pinned runtime succeeded: 475 MB, 68 s, model
> ready. So it is not the model, not the size, and not the archive path in
> isolation - it is something about the running app that a bare main process
> does not reproduce.
>
> **Why it stayed dark for so long.** The app's `log()` wrote to stdout and
> nowhere else, and a packaged Electron app has no console - so
> `models.ts` recording "model download failed: <id> - <message>" went
> straight into the void. The renderer put the message in a `title` tooltip
> that vanishes on the next render, and the chain strip replaced it with the
> constant `DOWNLOAD FAILED`. The reason existed the whole time and could not
> be read.
>
> Both are fixed: the app writes `relay.log` next to `config.json` in the data
> dir, and the strip shows the reason. **The next failure will say what it
> was.** Ask for that file.

**Run on this machine 2026-09-07, on the pinned runtime the app ships**
(Electron 33.4.11, Node 20.18.3, Chrome 130), driving the real `ModelStore`
from a real Electron main process:

| Model | Size | Result |
|-------|------|--------|
| `local-zipformer-en` | 310 MB archive | installed, 49 s |
| `local-whisper-tiny-en` | 118 MB archive + VAD | installed, 23 s |

`local-whisper-tiny-en` is the model the report names. Both unpacked through
bz2 and tar and published cleanly, and the installed whisper model then passed
the worker's probe against the real sherpa-onnx engine - so **the archive path
works end to end here**, which the note above said had never been shown.

That is not the same as fixed. It was reported on a different machine and
network, and this path has changed since: finding 25's `.part` collision fix
and the single-flight keyed by destination path both landed in it. If it
recurs, finding 26's rework means the message will now name the right half
instead of blaming the transport for a decode failure.

> **Correction 2026-09-07: the `.part` reading below was wrong, twice.** It said
> `local-nemotron-streaming.part` and `local-whisper-turbo.part` were "per-file
> models ... neither goes near the bz2 path". Both models carry an `archive:`
> block in the catalogue, so both go through bz2 and tar and nothing else. And
> the per-file path cannot produce a folder like that: it writes `<dest>.part`
> as a FILE inside the model directory, while `models/<id>.part` as a DIRECTORY
> is created in exactly one place - `fetchArchive`. Those were archive staging
> folders. They were evidence about the archive path, and were filed as
> evidence that the archive path was untouched.
>
> What is still true from that note: sherpa-onnx loads on this machine, and
> `local-sense-voice` (per-file, 240 MB) downloads, probes and transcribes
> correctly here, so the local engine can be exercised end to end.

**Two candidate causes found 2026-09-07, one demonstrated.**

1. **The publish had a 900 ms budget.** A model is published by renaming its
   staging folder into place, and on Windows a directory cannot be renamed
   while any file inside it is open - which is what Defender does while it
   scans freshly written files. Four attempts at 150/300/450 ms. It fits the
   split exactly (99 MB and 68 MB install; 651 MB and 989 MB do not) and it
   explains the empty `.part` folders: the cleanup deletes the files but cannot
   remove a directory whose handles are held. Now ~32 s of backoff, for the
   four codes that mean something else holds the file.
2. **A dropped connection restarted from byte zero, and was reported as a
   corrupt archive.** Proved end to end: a proxy in front of the real GitHub
   asset, killing the socket once at 40% of the 118 MB Whisper Tiny archive,
   makes the shipped code lose 47 MB and say "the archive would not unpack
   (47241984 bytes read) - terminated". The archive was perfect. Downloads now
   resume with `Range: bytes=<received>-`, and the give-up error says it is a
   transport failure instead of being guessed at from an errno it does not
   carry. The same proxy against the new code unpacks byte-exact across two
   connections.

   Parallel range chunks were asked for and not built: the pipeline decodes bz2
   and untars *while* downloading, so out-of-order chunks would mean buffering
   the whole archive to disk first (Whisper Turbo: 989 MB to about 1.55 GB) and
   would add an assembly failure mode to the path already suspected of being
   the broken one.

**Neither is confirmed.** Both failing models downloaded cleanly into the real
models directory on this machine with Defender live (71 s and 95 s). What will
settle it is `relay.log` from a real failure - ask for it.

> **The two `.part` folders in the models dir were never evidence of this.**
> `local-nemotron-streaming.part` is empty and `local-whisper-turbo.part` holds
> one complete 57 MB file - both are **per-file** models, abandoned when the app
> was closed mid-download, and neither goes near the bz2 path. That reading was
> what made findings 8 and 17 look blocked; they were not. sherpa-onnx loads on
> this machine, and `local-sense-voice` (per-file, 240 MB) downloads, probes and
> transcribes correctly here, so the local engine can now be exercised end to
> end. B6 itself is still untested: it needs an **archive** model, and that is
> still the path that has never completed.

Reported in `HANDOFF.md`, **taken on report — not reproduced here.**
Downloading `local-whisper-tiny-en` in the app fails with
`Error in bzip2: crc32 do not match`. The identical download succeeds in plain
Node, and per-file Hugging Face downloads work in the app, so it is not simply
"big downloads fail" — something in Electron's network stack is suspected.

**Finding 26 is fixed, so this is now diagnosable.** The instrumentation used
to compare bytes pulled from a demand-driven body, so every decode failure read
as a truncated download — a 512 KB archive that arrived perfectly and simply was
not bz2 reported *"the download stopped early: 28672 of 524288 bytes (5%)"*.
That is the message that has been pointing at the wrong half. The next real
failure will name which half it was.

Two of the seven archive models have now been installed and one of them run;
the rest are untried but there is no longer a reason to think they cannot be.

---

## Not blocked

Anyone can pick these up. Ordered by the audit's rank.

### Fixed since the audit

| Rank | Finding | Fixed by |
|------|---------|----------|
| 6 | A failed relay restart bricks the app and reports success | `13e744b` |
| 7 | A stale second-source device id traps the user | `137109e` |
| 9 | Viewer reconnect kicks the healthy socket | `3e23561` |
| 10 | A kicked OBS overlay paints ENDED onto the broadcast | `ce74eaf` |
| 11 | STT death never surfaced *(partly — see below)* | `0bb3be5` |
| 20 | The tray and Stream Deck hand out the `?obs=1` URL as the phone link | `885a4e0` |
| 21 | A capture device lost mid-session leaves a silent, still-billing session | `15424e9` |
| 22 | Translation failures are logged once and never reach the user | `58d80dd` |
| 23 | The 48 kHz → 16 kHz downsample has no anti-alias filter | `3fe8db5` |
| 11b | No reconnect for a dropped speech socket | `4fbaec5` |
| 15 | A STOP during `start()` is silently undone; devices stay captured | `44de691` |
| 19 | Re-entered setup rejects a working key and locks step 1 | `cad0d83` (v0.5.4) |
| 26 | An archive failure always blames the transport | *(this commit)* |
| 29 | `audioEndSec` double-counts `msg.start`, pinning latency at 0 | `71ffe88` (v0.5.4) |
| 31 | Any save re-syncs LINK MODE and discards the unsaved pick | `680d528` (v0.5.4) |
| 24 | The uplink fights a 4409 kick for ever; the 4401 branch was dead | `7aef02c` |
| — | A phone that loads a dead link retried for ever instead of saying so *(found here, not in the audit)* | `0585354` |
| 33 | `runtime:prepare` rotates the viewer link before checking the relay | `afd2156` |
| 25 | Two concurrent model downloads collide on the shared VAD | `f3ee3a9` |
| 11c | The heartbeat pinged and dropped nothing, so a half-open peer held on | `3a45667` |
| 35 | Ghost interim rows that never resolve | `47d7ade` |
| 36 | The session clock subtracts the streamer's epoch from the viewer's | `4ec491c` |
| 30 | A late key verdict repaints the live console as a setup placeholder | `ace475d` |
| 32 | The error overlay printed straight through the transcript underneath it | `71c320e` |
| 3 (part) | The unauthenticated `GET /link` route, which had no callers | `6931abd` |
| 28 | A busy control-API port took the tray and the window down with it | `dd6e9c6` |
| 34 | A passing local-STT probe thrown away because the session had stopped | `3b2d21f` |
| 27 | A changed update feed that did nothing until the app was restarted | `5fec896` |
| 17 | The flat 4 s kill timer that threw away the last thing said before STOP | `ffa8156` |
| 8 | An unbounded worker queue and a partial gate that replayed the backlog | `7c634ae` |
| 3 | The control API a page you visit could drive - deleted with its only consumer | *(this commit)* |

Plus the nine fixed in turns 31–41 — see `ITERATION_LOG.md`.

### Still open

None. The one part of an audit finding left open - 17, the close queued
behind audio - moved to `## Known limitations in 1.0` at the top of this file
when 1.0 was cut.

Each entry in the audit carries a reproduced failure scenario and a suggested
fix — read the numbered section there before starting.

### Found in the v0.8.1 release review, not in the audit

All three were confirmed against the source by independent verification and
are **pre-existing** - none is a regression from the eight commits in v0.8.1.
They were recorded rather than fixed because each needs a guard test of its own,
and a release commit is the wrong place to write one. **All three are now
fixed**, the last two on 2026-09-15.

- ~~**The desktop's own caption stage renders empty finals.**~~ Fixed
  2026-09-15. `onSubtitle` in `apps/standalone/renderer/app.ts` was the third
  consumer of a recogniser final and the one nothing guarded, so a quiet channel
  - one every couple of seconds - evicted all twelve real captions (`MAX_ROWS`)
  and left blank timestamped rows carrying a `...` that never resolved, because
  0.8.1 correctly stops translating them. A shared `wordless()` predicate now
  guards both consumers: `logSubtitle` returns early, and `onSubtitle` retires
  the channel's open interim and returns without building a row.
  **The advice this entry used to give - guard the wiring point, not the two
  consumers separately - turned out to be half wrong, and the half that was
  wrong mattered.** It is right about `logSubtitle`, which shares the same
  capped LOG buffer. It is wrong about `onSubtitle`, because the wordless final
  is the *only* thing that consumes a channel's open interim: dropping it before
  `onSubtitle` ran would have stranded the half-caption on the stage, and
  `trimRows` excludes `.interim` from the row budget deliberately, so nothing
  would have aged it out until the next speech on that channel or STOP. That is
  precisely the bug the empty final was introduced to prevent on the viewer
  (`packages/relay/src/deepgram.ts`). The guard has to retire, then return.
  Two things fell out of the same change: the `.latest` highlight no longer
  lands on an empty row, and `AVG STT` stops averaging how fast the engine
  transcribes silence - `recentStt` is a twelve-sample window, so a quiet
  channel used to fill it completely. Present at v0.8.0 and before; `85c4531`
  only changed the blank row's translation column from an invented callout to a
  permanent `...`.

- ~~**File-based local models have no integrity check at all.**~~ Fixed in two
  steps. `2329673` took the cheap half this entry described - the catalogue
  already carried each file's exact `size`, compared against the downloaded
  part before the rename - which closes truncation but accepts any file of the
  right length. `2ca6207` closed substitution: **every catalogue file that
  crosses the network now carries a pinned `sha256`, hashed as it arrives and
  verified before the rename**, which is what the archive path has done since
  `516247f`.
  Worth keeping, because it is why the digest was refused the first time: the
  files were fetched from `resolve/main`, and pinning content to a pointer that
  is allowed to move is meaningless. `90b27e5` pinned the revision, which
  removed the reason. Seven of the digests came from Hugging Face's tree API,
  where `lfs.oid` IS the sha256, so the 652 MB encoder never had to be
  downloaded to learn what it should be.
  `packages/shared/test/catalogue.test.ts` fails if a file with a `url` has no
  64-hex digest, and it turned up an eleventh file the change had not set out to
  cover - the shared VAD, which is the file audit finding 25 damaged.

- ~~**Every silent final forces a Durable Object storage write.**~~ Fixed
  2026-09-15 in `5fbb61f`, the way this entry asked: `room.ts` advances
  `lastSegId` only when the line carries words, so a silent tick no longer
  reaches storage. The broadcast is unchanged - remote viewers still get the
  empty final that retires their interim row - and the room now writes only
  when the record it would write differs from the one already there. (That
  reason was wrong for this hop: partials never travel the uplink, so no
  remote viewer has an interim row. Since 2026-09-18 the app stops sending the
  wordless finals at all - see the entry below.)

### Found while fixing the above, not in the audit

- ~~**The landing page's ON AIR badge can never light.**~~ Fixed 2026-09-07. It
  reports whether the SERVICE is answering - `ONLINE` / `OFFLINE` - which is a
  thing a tokenless `/health` can actually know. It used to read `live`, which
  is fixed `false` on a multi-tenant Worker, so it said STANDBY however many
  people were streaming.
- ~~**`home.html` said "drop the local one into an OBS browser source".**~~
  Fixed 2026-09-07; it no longer refers to a link a visitor does not have.

- ~~**The viewer page deployed on the hosted relay is stale.**~~ Fixed
  2026-09-07. It had gone out from a dirty tree and was missing four viewer
  fixes; a `wrangler deploy` from a clean tree uploaded exactly one asset,
  `/app.js`, and the deployed copy is now byte-identical to the tree by sha256.
  `verify-deploy.cjs` 14/14 and `verify-isolation.cjs` 9/9 afterwards.
- ~~**A kicked viewer is told the wrong reason.**~~ Fixed 2026-09-07. The
  reason now reaches the panel: another device reads as such and says TRY AGAIN
  takes it back, a rotated link says a new one was made, and no reason at all
  falls back without inventing a cause.
- ~~**Nothing warns about the one-viewer limit before it bites.**~~ Fixed
  2026-09-07. `04 OUTPUT` now reads `THIS NETWORK ONLY` / `ONE DEVICE AT A TIME`
  while the link is local, in the same words SETTINGS uses.
- ~~**`NEW` is unconfirmed and immediately destructive.**~~ Fixed 2026-09-07. It
  arms to `SURE?` for five seconds when somebody is reading, and still fires on
  one press when nobody is.
- ~~**The SHOW toggle on the API-key fields never resets.**~~ Fixed 2026-09-07.
  Every secret goes back behind its dots on any view change, and on a
  twenty-second timer, for all five `[data-show]` fields.

- ~~**`packages/viewer/public/app.js` still decimates if it is ever fed a rate
  above 16 kHz.**~~ Fixed 2026-09-10 in v0.8.0 - and the pointer was wrong: the
  worklet is `packages/companion/src/capture/workletSource.ts`. See "Closed by
  v0.8.0" above.
- ~~**Idle rooms on the hosted relay are never reaped.**~~ Fixed 2026-09-07,
  lopsidedly and on purpose. A room **nobody ever published to** is removed
  after 30 days by a Durable Object alarm. A room **anybody has touched** - by
  publishing, viewing, or reading or rotating its token - is kept for ever: its viewer token may be in somebody's messages, age is not
  evidence it stopped mattering, and an idle room costs nothing because the
  billing is per request. The alarm also declines to fire while a socket is
  open, since `shouldReap` takes a record and cannot see a live connection.
- ~~**An unexplained viewer socket, seen once** on the hosted relay.~~ Closed
  2026-09-18. Never proven - the room it was seen in is gone - but it can no
  longer happen whatever caused it: `liveViewers()` drops a socket silent for
  70 s and, since `dcaaded`, never counts one the room has closed. The full
  note is in `apps/hosted-relay/README.md`.
- ~~The self-hosted relay's `isLive()` answered ON AIR before any hello~~ -
  **fixed 2026-09-10 in v0.8.0, together with the `stamp()` asymmetry below, as
  this note asked; see "Closed by v0.8.0" above.** The original note follows.
  **It answered ON AIR before any hello arrived — the same defect the uplink-liveness fix closed on the hosted
  Worker, one layer earlier, on the path someone would use running
  `packages/relay`'s own binary as their remote relay instead of
  `textrelay.cc`.** `isLive()` in `packages/relay/src/server.ts` is
  `(publisher !== null && sttLive) || uplink !== null` — true from
  socket-accept, before any hello says whether a session is actually running.
  `onViewer`'s greeting, its `sync` reply, and `GET /health` all read
  `isLive()` directly; the fan-out through `toViewers` (and so the fixed
  `live: msg.live !== false` on the uplink hello) does not.

  Concretely: the app boots idle with an uplink connected to a self-hosted
  relay (a publisher works the same way). A viewer already attached is
  correctly told `live: false` once the boot hello arrives. A **second**
  viewer who opens the same link in that same idle window — via the initial
  `hello` `onViewer` sends the moment its socket is accepted, or via `sync` —
  is told `live: true`, because `isLive()` only needs the uplink socket to
  exist, not a hello to have said anything. Two viewers, same relay, same
  moment, two different answers — harder to diagnose than the one consistent
  lie this task's fix replaced on the hosted path.

  Not fixed as part of that task: it needs persistent last-hello state
  `isLive()` does not have, on a path (the self-hosted relay, not the hosted
  Worker) with no behavioural coverage of this specific defect, and the task
  was scoped to the uplink hello handler alone.

  **A connected asymmetry, found while tracing the above and not currently
  reachable:** `stamp()` in the same file sets `liveSince` when a `hello` or
  `status` message says `live: true`, but only the `status` branch clears it
  when `live` is `false` — the `hello` branch never does. Every path that can
  currently deliver a `live: false` uplink **hello** (app boot with no
  session, or an idle settings change forwarded by `bridgeBroadcasts` in
  `apps/standalone/src/main.ts`) already finds `liveSince` `undefined`,
  because a genuine session stop clears it through the `status` message path,
  not through a hello — so this asymmetry has no observable effect today.
  **If `isLive()` above is ever rewritten to track last-hello state instead
  of socket presence, this stops being inert:** a `false` hello that never
  clears `liveSince` would leave a stale session clock running under a fixed
  liveness check. Worth fixing in the same change that fixes `isLive()`, not
  before — nothing exploits it while `isLive()` ignores `liveSince` from a
  hello in the first place.

### Found on the way to 1.0

- ~~**A replaced publisher's close ended the stream it had been replaced
  in.**~~ Fixed 2026-09-18. The hosted room allows one uplink and closes the old
  one when a new one connects - every network blip, embedded-relay restart and
  idle settings change - and `webSocketClose` in `apps/hosted-relay/src/room.ts`
  treated that close as the publisher leaving: room marked not live, every
  viewer told "stream ended", under a publisher still streaming. It now returns
  early while another uplink is attached **and OPEN**. The second half matters:
  `getWebSockets` keeps returning a socket the takeover closed until its peer
  answers, and a peer that has gone never does, so counting CLOSING sockets
  would have left a room on ON AIR for good once the real publisher left.
  Guarded in `apps/hosted-relay/test/viewerReap.test.ts`.
- ~~**A half-open viewer is "dropped" again on every caption.**~~ Fixed
  2026-09-18: the sweep now skips any socket that is not OPEN, so a closed one
  is neither counted nor dropped twice. Same runtime
  fact, other tag: `liveViewers()` in `apps/hosted-relay/src/room.ts` closes a
  silent viewer and counts it dropped, but a socket whose peer vanished stays in
  `getWebSockets("viewer")` as CLOSING, so every later broadcast closes it again,
  counts it again, and sends the uplink a fresh `viewers` message - one per
  caption for as long as the runtime holds it. The count itself stays right;
  the chatter and the wasted work are what is wrong.

- ~~**A relay restart under a live session was read as a takeover.**~~ Fixed
  2026-09-18, found by the 1.0 discovery pass. GET AN ADDRESS - and any other
  relay setting - restarts the embedded relay, and `close()` dropped the
  publisher with 4409, the code for "a newer publisher took over", which the
  publisher client accepts as final. Captions stopped for good under ON AIR.
  The shutdown now says 1001, as it already did to the uplink and the viewers,
  and the client reconnects to the relay that comes back
  (`packages/relay/test/restartKeepsPublisher.test.ts`).

- ~~**A session whose stream had ended went on saying ON AIR.**~~ Fixed
  2026-09-18, the other half of the entry above. `recomputeState()` in
  `apps/standalone/renderer/app.ts` could only promote, so a publisher that
  reached its terminal `error` left the topbar on ON AIR, the clock running,
  the mic captured and every chunk dropped. It now stops the session and says
  why, under a heading that no longer claims a session that ran "could not
  start" - the every-source-lost path had the same heading and gets the same
  fix. A retrying (`disconnected`) publisher stays live, and a client the
  session has already moved on from is ignored: a review of the first version
  found that an orphan from a START/STOP/START inside one slow prepare would
  otherwise end the good session that replaced it.

- ~~**A STOP pressed while a session was still preparing was undone.**~~
  Fixed 2026-09-18, found by the 1.0 discovery pass. `startSession()` awaits
  `prepareSession()` - with a hosted room, a network call to rotate the link -
  under a button reading STOP, and a stop in that window had nothing to tear
  down, so the start carried on and went ON AIR. A start now takes a token
  that every stop and every newer start moves on, and checks it after the
  wait, on success and on failure. The same gap let START, STOP and START
  build two publishers; the first is no longer built.

- ~~**A restarted session's late output landed in the transcript viewers had
  just cleared.**~~ Fixed 2026-09-18, found by the 1.0 discovery pass. A
  settings change while live opens a new publisher socket, the relay mints a
  new epoch and viewers clear; the old session's last translation or a local
  model's flush final then arrived with no epoch of its own, came back as the
  newest line and held the row the new session's id needed. `buildSession()`
  in `packages/relay/src/server.ts` now drops a session's viewer output once
  the epoch has moved - at the source, so OBS and the hosted room are covered
  too. After a plain STOP nothing moves the epoch, so the last words still
  arrive, and the saved transcript is fed from the publisher path and keeps
  everything (`packages/relay/test/lateOutputAfterRestart.test.ts`).

- ~~**The viewer page decided the relay was gone and then waited a minute to
  say so.**~~ Fixed 2026-09-18, found by the 1.0 discovery pass. Its heartbeat
  gave up by calling `close()` and left the RECONNECTING display and the
  retry to `onclose` - which a real browser holds back until the peer's Close
  frame arrives or the closing handshake times out, 60 s in Chromium, and a
  silent peer never sends the frame. The page now lets go of the socket, says
  RECONNECTING and arms the retry at the moment it gives up.

- ~~**The uplink's heartbeat gave up, then waited out a close the dead relay
  would never finish.**~~ Fixed 2026-09-18, the viewer fix's adjacent shape.
  `packages/companion/src/uplinkClient.ts` called `close()` and left the
  retry to `onclose`, which the `ws` package Electron main runs holds for 30 s
  when the peer never answers - 30 s more of internet viewers without
  captions. It now lets go of the socket, terminates it and retries at once.
  A review found the fix's own trap: the dropped socket's late close stopped
  the client's one shared heartbeat before asking whether that socket was
  current, switching off dead-relay detection on the healthy connection -
  latent on Electron 33, live on the standard WebSocket the next Electron
  moves to. Fixed and held on both implementations.

- ~~**A line whose translation failed kept its "…" for good.**~~ Fixed
  2026-09-18, found by the 1.0 discovery pass; audit finding 22 had named the
  symptom and fixed only the report to the app. The relay now answers every
  failed translation with `target: ""` - documented on `ServerToViewer` as
  "not coming" - and the viewer page drops the placeholder and shows the
  original even where the reader hid originals, so an OBS overlay no longer
  puts a lone "…" on air. The desktop stage's own placeholder is a separate
  card: its signal would also feed the saved transcript.

- ~~**A late translation brought back a line the viewer had already
  trimmed.**~~ Fixed 2026-09-18, found by the 1.0 discovery pass. Gemini's
  retries put a translation 5-22 s behind its line, and on a fast stream the
  row was gone by then; the page took the translation for a new line, put the
  old sentence up as the newest caption and deleted the half-caption being
  spoken. The page now remembers the ids it let go of and ignores a
  translation for one - by identity, not by numbering, because a line a viewer
  never received (a join, a reconnect, an uplink gap) can be older than what
  is on screen and still has to build. The desktop stage's version is a card.

- ~~**The viewer's screens took their height from `100dvh` alone.**~~ Fixed
  2026-09-18, found by the 1.0 discovery pass. A browser without `dvh` - OBS
  28-30's browser source is Chromium 103; Safari before 15.4 - dropped the only
  height rule, so the overlay's caption sat at the top of the source and an
  older phone's newest lines fell below a fold nothing could scroll to. A
  `100vh` fallback now sits ahead of it, and a guard reads every stylesheet,
  `<style>` and `style=""` the package serves for a dynamic viewport unit
  with nothing under it.

- ~~**With two voices talking over each other, the second one's finished line
  never reached the OBS overlay.**~~ Fixed 2026-09-18, found by the 1.0
  discovery pass. The overlay shows one line, and any open interim took it -
  so the moment a teammate's callout finished while the streamer was
  mid-sentence, the streamer's older interim took the line back, and the
  callout and its translation were never on the broadcast. An interim now
  takes the line only if it began after the newest finished line, or once that
  line has had 3 s to be read (again from when its translation lands). The
  hold came from review: without it, one voice's 15-18 s local-engine segment
  would have left the person the audience can hear uncaptioned that long.

- ~~**With "Show original" off, every speaker tag disappeared.**~~ Fixed
  2026-09-18, found by the 1.0 discovery pass. The tag is drawn inside the
  original's element and the setting hid that whole element, so on a
  translated two-source stream - phone page and overlay - two people's lines
  looked the same, against DESIGN.md's "every caption row carries" the tag.
  The setting now hides the original's words, not who said them. Seen in a
  real browser on both surfaces against the mock relay.

- ~~**A row clicked in SETTINGS mid-stream could end the broadcast.**~~ Fixed
  2026-09-18, found by the 1.0 discovery pass. Picking a local model there
  switches the engine at once, live or not, and a row is a big target: a
  streamer clicking a not-yet-downloaded model's name while meaning DOWNLOAD
  restarted the session onto it and ended in ERROR. That one pick is now
  refused while live, and the models field says why in amber for a few
  seconds; a downloaded model still switches live and keeps the viewer link,
  which SETTINGS is the only way to do. Re-picking the model in use is a no-op.

- ~~**During a download, the model list's buttons often ignored clicks.**~~
  Fixed 2026-09-18, found by the 1.0 discovery pass. Status arrives about four
  times a second while a model downloads, and every push rebuilt the list in
  SETTINGS and on setup step 1 - so a click pressed on CANCEL (or another
  row's DOWNLOAD or REMOVE) was often released on a replacement, and Chromium
  drops a click whose pressed element was removed. A push that only moves a
  percentage now moves it in place.

- ~~**A relay address ending in "/" left internet viewers on OFF AIR for
  good.**~~ Fixed 2026-09-18, found twice by the 1.0 discovery pass. The app
  accepts `wss://host/` and every other use of it strips the slash, but the
  uplink appended `/ws/uplink` as it was and dialled `//ws/uplink`, which no
  relay accepts - retried for ever under a SETTINGS panel reading SET. The
  address is now built by `uplinkUrlFor` in `packages/shared`, taking off the
  same one slash the claim and the phone link accept, so an address works
  everywhere or visibly nowhere.

- ~~**NEW said "old links are dead" when the internet link had not
  changed.**~~ Fixed 2026-09-18, found by the 1.0 discovery pass. NEW rotates
  the LAN link in-process and asks the internet relay to rotate its own; when
  that request failed - a 500, a publish key the relay no longer knows, a
  captive portal's 200, no network - main logged at most a line (a non-2xx not
  even that) and the renderer said the old links were dead while the old phone
  link went on working, for whoever the streamer was trying to shut out. A START
  in the default link mode rotated the same way and said nothing, and the tray's
  Rotate viewer link opened the old link as though it were new. Each outcome is
  now only what the relay confirmed: both relays replace the link before they
  answer, so a request that failed after it may have been acted on is followed
  by asking the relay which link it admits now - `unchanged` if the old one,
  `unknown` if it cannot be asked, `refused` for a key it turned away. The
  request lives in `packages/companion/src/rotateLink.ts`, the outcome in
  `apps/standalone/src/linkRotation.ts` (tested under plain Node against real
  relays), the wording in one `rotationNotice` for the window and the tray, and
  a warning stays in 04 OUTPUT - the log is hidden on the stage, where NEW is.

- ~~**A START that could not start still replaced the link.**~~ Fixed
  2026-09-18, found while fixing the entry above. In the default link mode
  preparing a session rotates the link, disconnecting everyone reading, and
  the renderer checked for a Deepgram key or a downloaded model only after
  that - so a START with neither kicked every phone off and then refused.
  Main already refused to rotate before its own relay check, for exactly this
  reason; the renderer's half of the rule now runs before the session is
  prepared as well as after.

- ~~**A hosted room stayed ON AIR for good when its publisher vanished.**~~
  Fixed 2026-09-18, found by the 1.0 discovery pass. A PC that loses power or
  drops off the network never closes its uplink, and nothing else could end a
  stream: viewers watching kept a running clock over nothing and every late
  joiner was greeted as live. The uplink has always beaten with the frame the
  runtime auto-answers, so the room now reads it - an uplink silent for 70 s
  is closed and viewers are told the stream ended, checked on every wake-up
  that happens anyway, and by a minute alarm while a session is declared live.
  An app from before 0.8, whose hello only implies live, never starts that
  alarm. `apps/hosted-relay/README.md` has the cost; `uplinkGone.test.ts` and
  `viewerPing.test.ts` hold it.

- ~~**The footer's link ignored OUTPUT after boot.**~~ Fixed 2026-09-18, found
  by the 1.0 discovery pass. Which link the footer shows, and COPY copies, was
  worked out from OUTPUT once at startup - so a user who picked OBS in setup
  started their first session with COPY handing their OBS browser source the
  phone page, audit finding 20 again, until a restart. It now follows OUTPUT
  whenever OUTPUT changes, and a pick made in the footer's own switch stands
  until then.

- ~~**A reconnecting uplink was never told who was watching.**~~ Fixed
  2026-09-18, found by the 1.0 discovery pass. The app reconnects to the
  hosted room on every blip and every start and zeroes its count each time,
  and the room sent one only when a viewer came or went - so the app read 0
  watching over readers, and NEW, which asks SURE? only when someone is,
  ended the link on every phone in one press. The room now sends the count
  right after `ready`, as the self-hosted relay always has, and
  `verify-deploy.cjs` checks it against the real runtime.

- ~~**A guard test that could not fail.**~~ Fixed 2026-09-18, found while
  editing its neighbour. `renderer.test.ts` asserted the footer's PHONE/OBS
  switcher does not ship hidden, with `\bhidden\b` in its regex - but a shell
  had turned both `\b` into backspace bytes in `901956f`, so the lookahead
  could never match and the test passed with `hidden` in the markup (checked).
  The regex is restored and goes red on that markup, and
  `packages/shared/test/lineEndings.test.ts` now fails on any control byte in
  a tracked text file. Its row parser was taking the path from the wrong
  column, which the new check's first draft inherited and so opened no files
  at all; both use the TAB git puts before the path now.

- ~~**A sole source unplugged at launch was "removed" and put straight
  back.**~~ Fixed 2026-09-18, found by the 1.0 discovery pass. Audit finding
  7's fix drops a source whose device is gone, which works while one
  survives. With a USB headset as the only source, the app saved an empty
  list, the config store read that as "fall back to the legacy pair" - which
  was the last list's mirror - and the dead id came back, the picker blank
  and every START failing on it. The app now falls back to the default
  microphone and says so, and the store resolves a list a patch names from
  that list alone, so an emptied one means the default everywhere.

- ~~**Every wordless final went up the uplink.**~~ Fixed 2026-09-18, found by
  the 1.0 discovery pass. A quiet channel emits one every couple of seconds,
  and each was an inbound message the hosted relay bills as a request - its
  binding limit - for a frame that does nothing there: it exists to retire an
  interim row, and partials never cross the uplink. `forwardsToUplink` in
  `packages/companion` now sends a subtitle only when it has words, the app's
  tee goes through it, and a viewer test holds the premise on both surfaces.

- ~~**Anyone could put terminal escapes into the maintainer's terminal.**~~
  Fixed 2026-09-18, found by the 1.0 discovery pass. `POST /feedback` takes
  no token and rejected no control character, and `read-feedback.cjs` - the
  one way to read a report - printed the version and a preview of the message
  raw, JSON-parsed back into real ESC and BEL: OSC 52 to write the clipboard,
  cursor codes to hide other reports, OSC 8 to disguise a link. The Worker
  now strips control characters (a message and log keep tabs and line
  breaks), and the script prints every field through `printable()`, since
  records stored before this are still in the bucket.

- ~~**One IPv6 host was never rate limited.**~~ Fixed 2026-09-18, found by the
  1.0 discovery pass. Both limits keyed on the full `CF-Connecting-IP`, and an
  ordinary IPv6 host holds a /64 - it could send every `/claim` and every
  `/feedback` (two R2 objects, up to ~1.5 MB) from a fresh address and never
  meet a full bucket. `claimRateKey` now counts an IPv6 caller by its /64,
  however the address is written, and an IPv4 address written as IPv6 as the
  IPv4 address. The bucket's lack of an expiry rule is under Known
  limitations.

- ~~**RUN SETUP AGAIN deleted a third audio source.**~~ Fixed 2026-09-18,
  found by the 1.0 discovery pass. Setup's last step has two source pickers
  and OPEN CONSOLE saved exactly those two as the whole list, so rerunning
  setup to switch engine silently dropped the third. It now keeps any slot
  setup does not show. Testing it turned up a gap between the test DOM and
  Chromium: an option marked selected before it is appended is honoured by
  one and not the other, so `fillSelect` now sets the value outright.

- ~~**A removed source's name and colour went to the device after it.**~~
  Fixed 2026-09-18, found by the 1.0 discovery pass. Speaker names and
  colours are stored per slot, and the source list is compacted when a slot
  is emptied or a device is gone at launch - so the next device moved up and
  took the removed one's name: the coach tagged TEAM in TEAM's colour, to
  viewers and in the saved transcript. `ConfigStore` now re-lays both to
  follow their devices whenever the list changes shape; a device swapped in
  place keeps its slot's name, and a patch that sets names itself still wins.

- ~~**The desktop stage kept its "…" under a failed translation for good.**~~
  Fixed 2026-09-18, the desktop half of the viewer fix above. The relay told
  viewers a failed translation is not coming and told the streamer's own app
  nothing, so the one screen belonging to the person who could fix the key or
  the quota kept a column of placeholders. The relay now sends it to the app
  too; the stage takes the "…" down, the log prints no blank line for it, the
  saved transcript writes nothing for it, and a "not coming" for a line the
  stage has already trimmed is ignored rather than put back over the
  half-caption being spoken.

- ~~**A late translation on the desktop stage took over the half-caption
  being spoken.**~~ Fixed 2026-09-18, the desktop half of the viewer fix. A
  translation lands 5-22 s behind its line while Gemini retries; if the line
  had been trimmed meanwhile, the stage turned the channel's open
  half-caption into it - the old sentence back as the newest caption, the one
  being spoken gone. The stage now remembers the lines it let go of, as the
  viewer page does, and forgets them when a new session starts.

- ~~**A half-caption that came to nothing left the OBS overlay blank.**~~
  Fixed 2026-09-18, found by the review of the two-voice overlay fix. The
  wordless final that retires the on-air half-caption returned before the
  overlay chose a line again, so nothing was on air over a finished line it
  could show - until the next caption, or for good with "hide after" at
  never. It now chooses again whenever it retires one.

- ~~**GET AN ADDRESS waited with no deadline once headers arrived.**~~ Fixed
  2026-09-18, found by the review of the NEW fix. `claimHostedRoom` cleared
  its timeout when the headers came in, so a relay or proxy that sent `200`
  and stalled mid-body held the button indefinitely. The deadline now runs to
  the last byte, and a body cut off by it says the relay did not answer in
  time rather than that the address is wrong - the shape `rotateLink.ts` got
  in the same pass.

- ~~**The text-size slider had no name a screen reader could say.**~~ Fixed
  2026-09-18, found by the 1.0 discovery pass. Announced as a bare "slider,
  18", its visible "Size" tied to nothing - and the three colour swatches
  turned out nameless too, their names in a `title` on the label, where they
  name nothing. The slider now takes its name from the "Size" on screen, the
  swatches carry their own, and a test walks every control in DISPLAY so the
  next one cannot ship without one.

- ~~**Keyboard focus was invisible on seven of DISPLAY's controls.**~~ Fixed
  2026-09-18, found by the 1.0 discovery pass. The four pickers and three
  colour swatches are real controls laid over what the reader sees at
  `opacity: 0`, which took the browser's focus ring with them; tabbing
  through the panel changed nothing on screen. The element around each now
  shows keyboard focus - `:focus-visible` only, so a tap draws nothing - and
  a test discovers every invisible control from the stylesheet and requires
  a ring on its container. Checked with real Tab presses in Chromium.

- ~~**The overlay's active theme button had no readable label.**~~ Fixed
  2026-09-18, found by the 1.0 discovery pass. It is drawn inverted, ink
  behind and the page background in front, and on OBS clear - the overlay's
  default, and where RESET lands - that background is `transparent`: a cream
  block with no "OBS clear" on it. The label now takes the colour the
  background was chosen as, which is opaque on every theme; a test checks the
  active button on all four themes on both surfaces, and Chromium draws it
  black on cream.

- ~~**On the overlay, the DISPLAY preview was always empty.**~~ Fixed
  2026-09-18, found by the 1.0 discovery pass. The overlay draws only the row
  marked as on air, and the preview's row never was, so every change a
  streamer made in OBS's Interact window - size, font, colour, alignment -
  happened against an empty box. On the overlay the preview is now the
  on-air line, drawn the way it airs, and a quiet stretch no longer fades it.
  The phone page's preview is unchanged.

- ~~**A screen reader re-read every partial.**~~ Fixed 2026-09-18, found by
  the 1.0 discovery pass. The half-caption sat inside the polite live region
  `#lines`, and each partial rebuilt its text, so VoiceOver and TalkBack
  queued the whole sentence so far several times a second, with the
  translation last. The half-caption is now `aria-hidden` - it is for eyes -
  and the finished line, which arrives as a row of its own, is read as before.

- ~~**The hosted relay's session clock ran on the phone's clock.**~~ Fixed
  2026-09-18, found by the 1.0 discovery pass - audit finding 36 on the path
  most internet readers are on. The room sent only `since`, the streamer's
  timestamp, so a phone a minute behind showed the clock frozen at 00:00:00.
  It now works out `elapsedMs` on the Worker's clock and sends it wherever it
  sends `since` - the greeting, the relayed hello, every status, the sync
  reply - and the page, which already prefers it, counts from its own clock.

- ~~**Per-room /health answered any well-formed token.**~~ Fixed 2026-09-18,
  found by the 1.0 discovery pass. The room read the secret and never compared
  it, so a room id from a link NEW had rotated away, plus any 32 hex digits,
  still told a reader whether the stream was on and how many watched. It now
  answers the publish key and the current viewer link and nothing else. The
  count it gives also no longer drops a silent viewer without telling the app.

- ~~**GET AN ADDRESS discarded a key typed but not yet saved.**~~ Fixed
  2026-09-18, found by the 1.0 discovery pass. A claim re-filled every field
  in SETTINGS from the stored config, so a Deepgram or Gemini key pasted but
  not saved vanished behind the dots and SAVE wrote the old one. It now
  refreshes only the relay address and publish key it changed.

- ~~**INCLUDE MY LOG sent the log as it was when the box was ticked.**~~ Fixed
  2026-09-18, found by the 1.0 discovery pass. Somebody who ticked it, went
  back to reproduce the failure and returned to send, sent a log that ended
  before the failure the report described. SETTINGS now reads the log again
  whenever it opens with the box ticked, so the preview is still exactly
  what is sent.

- ~~**A key typed in SETTINGS made a rejected saved key read KEY OK.**~~
  Fixed 2026-09-18, found by the 1.0 discovery pass. The saved key's check
  and the typed key's check shared one verdict per provider, so typing (or
  CLEAR) evicted the saved key's KEY INVALID and the chain read the empty
  slot as OK. Verdicts are now kept per string, and the saved key's is never
  the one let go.

- ~~**A key check that failed only because the PC was offline at boot was
  final.**~~ Fixed 2026-09-18, found by the 1.0 discovery pass. RUN SETUP
  AGAIN reused the boot-time "no connection", so CONTINUE stayed dead and
  SKIP - translation off - was the way through step 2, and the chain said
  KEY ? all run. Setup now asks again about a key that could not be checked,
  and so does the network coming back.

- ~~**Setup moved past a step whose save failed.**~~ Fixed 2026-09-18, found
  by the 1.0 discovery pass. Saving a key restarts the relay; with its port
  held the restart fails and main puts the old key back, but every setup
  button ignored the failure, ticked the step and moved on with the key gone.
  A step that cannot save now stays put and says why, on screen - setup
  hides the LOG where SETTINGS reports it.

- ~~**Leaving setup while a step saved drew setup over the console.**~~
  Fixed 2026-09-18, found by the 1.0 discovery pass. A reopened setup can be
  closed while CONTINUE or SKIP is still saving, and the late step change
  repainted setup's chain strip over the live console - greyed blocks, no
  translate toggle. The step change now draws only while setup is showing.

- ~~**A renderer test failed once in a full run.**~~ Fixed 2026-09-18. Not the
  app: each renderer test re-imports the page and the previous instance kept
  its timers and its document/window listeners, all writing into the next
  test's document. A revealed link's 20 s re-hide blanked a later test's
  brand field; an Escape closed a later test's setup. The harness now
  cancels a finished test's timeouts and takes its listeners off.

- ~~**Three offline-boot tests proved less than they said.**~~ Fixed
  2026-09-18, found by an independent review. Their wait for `KEY ?` was
  written as `/KEY ?/` - a backslash lost in a heredoc - which matches KEY OK,
  so with the offline boot taken away three still passed. Escaped, and each
  now fails at that wait when the boot never goes offline.

- ~~**A fresh install whose relay port was taken could not finish setup.**~~
  Fixed 2026-09-18, found by an independent review; a regression from
  902aad8. Saving a key restarts the relay, a held port fails that, main
  put the empty key back, and setup - which stays on a step whose save
  failed - could not get past step 1, with the port in SETTINGS out of
  reach. Main now keeps a save when the relay was not running before it
  either, and setup moves on when what it saved is what is stored.

- ~~**A provider error read as a rejected key.**~~ Fixed 2026-09-18, found by
  an independent review. A 429 or 503 from Deepgram or Gemini came back as
  `deepgram http 503` and showed KEY INVALID for a good key, with setup's
  CONTINUE dead for the run. Only "key rejected" - 401/403, Gemini's 400 - is
  a verdict now; any other status reads KEY ? and is asked again.

- ~~**The network coming back did not reach an open setup.**~~ Fixed
  2026-09-18, found by an independent review. Setup keeps its own answers
  for the keys in its fields, and only the chain's were re-asked, so a setup
  open through the outage kept COULD NOT REACH with CONTINUE dead - on a
  first run, with no way to close it - and a typed key was never re-asked.
  It is now, and an older check that hung can no longer land over a newer
  answer for the same key.

- ~~**The triage rule still let open work hide in two places.**~~ Fixed
  2026-09-18, found by an independent review. A `Closed by` section counted as
  triaged by its heading, so an open item written into one passed; and under
  Blocked only headings that already had a B-number were asked to be named.
  The Closed-by records are struck through now like every other closed item,
  and everything under Blocked must sit under a `### B<n>`.

- ~~**A setup step's result could land in the wrong place.**~~ Fixed
  2026-09-18, found by an independent review. A save that came back after
  setup was opened again moved the new run on to the next step, or opened
  it on the old run's COULD NOT SAVE; and ADD GEMINI KEY carried step 3's
  failure back to step 2. What a save or a step change comes back with now
  belongs to the run and the step it was made in.

- ~~**DOM tests fetched from another project's dev server's port.**~~ Fixed
  2026-09-18, found by an independent review. vitest puts happy-dom's page on
  `http://localhost:3000` and happy-dom fetched every stylesheet and iframe a
  page links to - from whatever listens on 3000, which here is another
  project. Loading is off now and the page sits on the discard port.

- ~~**Two harness guards tested nothing when run alone.**~~ Fixed 2026-09-18,
  found by an independent review. Each was a pair of tests relying on file
  order, so run alone or shuffled it passed without testing anything. Each
  is one test now that arms the leftover, proves it is armed, cleans up the
  way afterEach does and boots again.

- ~~**Four self-undoing timers were run by no test.**~~ Fixed 2026-09-18,
  found by an independent review. The link's 20 s re-hide, a revealed key's
  20 s re-hide, and the 5 s disarm of NEW's and DELETE's SURE? used to fire
  in whatever test came later; once the harness cancelled leftovers, nothing
  ran them. Each has a fake-timer test now, before and after its deadline.

### Other

- ~~**No guard test over `CLAUDE.md`.**~~ Done — `packages/shared/test/handoff.test.ts`
  now covers `HANDOFF.md`, `CLAUDE.md` and this file: every `pnpm <script>`,
  every code path and every document any of them names has to exist, and none of
  them may describe work blocked on SSH to the retired VPS.
- ~~**`HANDOFF.md` is stale at the top.**~~ Rewritten 2026-09-10 for v0.8.0,
  along with `CLAUDE.md`.
- ~~**The bundled fonts ship without their licence.**~~ Done —
  `packages/viewer/public/fonts/OFL.txt` carries the OFL 1.1 text with both
  copyright lines, taken verbatim from the upstream repositories. Worth keeping
  the reason it was not written from memory: upstream says Archivo is **2020**
  and Martian Mono **2021**, and both guesses were a year out. Neither font
  declares a Reserved Font Name, so nothing has to be renamed.
  One inherited oddity, recorded so nobody "fixes" it: Martian Mono contradicts
  itself upstream and Google Fonts carried it through - `ofl/martianmono/OFL.txt`
  says 2021 while the shipped binary's name table (nameID 0) says 2020. What is
  being reproduced here is the licence file, so the licence file's year is the
  one carried; editing another project's copyright notice would be worse than
  inheriting its inconsistency.
  `packages/shared/test/license.test.ts` now fails if a `.woff2` appears in that
  directory with no notice covering it.
- ~~**Cosmetic:** the relay logs `data\relay-state.json` with a backslash on
  Linux.~~ Fixed 2026-09-10 in v0.8.0.
- ~~**CLAUDE.md's copy of the release workflow's tag guard is abridged in the one
  place the paragraph under it depends on.**~~ Fixed 2026-09-18 by the 1.0 loop,
  which the owner authorised to clear this backlog: the block now quotes the
  workflow word for word, and `handoff.test.ts` holds it there - red when the
  quote drifts and red when the workflow does. The original note follows. It shows

      tag="$GITHUB_REF_NAME"

  and `.github/workflows/release.yml` actually reads

      tag="${{ github.event.inputs.tag || github.ref_name }}"

  The middle and last lines match, and the logic it describes - a tag that is
  not `v` + the app version fails the job before it builds - is correct. But the
  dropped half is exactly what the next sentence relies on: *"To exercise the
  workflow, use `workflow_dispatch` with an existing tag."* Under the quoted
  version a `workflow_dispatch` run would compare a **branch name** against the
  version and always fail, so the snippet and the advice beneath it contradict
  each other. Anyone trusting the snippet would conclude the documented
  workaround cannot work, or "fix" the workflow to match the page.

  Left for the owner rather than corrected, because the release process in
  `CLAUDE.md` is explicitly not the improvement loop's to edit
  (`docs/RALPH-IMPROVEMENT-LOOP.md`, "Things that are not yours to decide"). It
  is a one-line change to the quotation and needs no change to the workflow.
  Found 2026-09-15 while guarding the file's *other* quoted block; that one, the
  `startUplink()` gate, does match its source and `handoff.test.ts` now holds it
  there.
