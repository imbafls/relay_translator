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

## Closed by retiring the VPS

The first three blockers in the previous version of this file were all "SSH into
the Hostinger box". **There is no box.** It was stopped on 2026-09-06 and
`relay.supr.systems` is a Cloudflare Worker with one Durable Object per
streamer (`apps/hosted-relay`). Nothing needs mirroring, no tokens need setting
by hand — a room issues its own credentials on `POST /claim`.

The old entries are kept only as a pointer for anyone reading an older log:
mirroring the release to the VPS, setting `RELAY_PUBLISHER_TOKEN` /
`RELAY_VIEWER_TOKEN` on it, and rotating its API keys are all moot.

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

### B5 — A real credential for the local control API (`GET /link`)
**Band: high. Blocked on: Stream Deck hardware to test the property inspector
against.**

Audit finding 3, half fixed. `packages/companion/src/controlServer.ts` carries
an explicit `STILL OPEN` comment on the route:

- `GET /link` returns the unredacted viewer link and does not go through
  `redact()` at all.
- `allowedOrigin` returns true for `origin === "null"` and echoes it back as
  `Access-Control-Allow-Origin: null` — which matches the opaque origin a
  sandboxed iframe on any web page sends.
- `guardPost` checks header **presence**, not a secret, and the OPTIONS
  preflight advertises the header name.

So a page you visit can ask for your viewer link and watch your live captions.

**Fix:** a per-launch token the app writes to `%APPDATA%` and the property
inspector reads, gating reads as well as writes, with the origin allowlist kept
as defence in depth. **What unblocks it:** a Stream Deck to verify the inspector
still works after the change.

### B6 — In-app archive model downloads corrupt at ~28%
**Band: medium. Status: could not be reproduced. Needs a real failure to go
further.**

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
| 8 | An unbounded worker queue and a partial gate that replayed the backlog | *(this commit)* |

Plus the nine fixed in turns 31–41 — see `ITERATION_LOG.md`.

### Still open

| Rank | Band | Finding | Primary location |
|------|------|---------|------------------|
| 3 | high | Control API: no credential and `Origin: null` admitted, so a page you visit can start/stop the session, patch config, and `POST /link/rotate` for an unredacted viewer link. **Partly closed** - `GET /link` deleted (it had no callers); the rest needs a token the property inspector has no testable way to receive. *(Also B5.)* | `packages/companion/src/controlServer.ts` |
| 17 (part) | low | The close is still posted behind the queued audio on the same port. With the deadline scaled to the worker going quiet, that costs a slower STOP rather than a lost caption; moving it out of band means changing the protocol on both sides, and the worker half needs sherpa-onnx to exercise at all. | `packages/relay/src/localSttWorker.ts` |

Each entry in the audit carries a reproduced failure scenario and a suggested
fix — read the numbered section there before starting.

### Found while fixing the above, not in the audit

- **`packages/viewer/public/app.js` still decimates if it is ever fed a rate
  above 16 kHz.** Finding 23 stopped the app *asking* it to resample; the
  worklet has no filter of its own. Only matters if something else starts
  feeding it.
- **Idle rooms on the hosted relay are never reaped.** A room's record is tiny
  and there is no TTL. See `apps/hosted-relay/README.md`.
- **An unexplained viewer socket, seen once** on the hosted relay. Also in that
  README, with the full note.

### Other

- ~~**No guard test over `CLAUDE.md`.**~~ Done — `packages/shared/test/handoff.test.ts`
  now covers `HANDOFF.md`, `CLAUDE.md` and this file: every `pnpm <script>`,
  every code path and every document any of them names has to exist, and none of
  them may describe work blocked on SSH to the retired VPS.
- **`HANDOFF.md` is stale at the top.** It still says the latest release is
  v0.5.1 and describes `ralph/pipeline-hardening` as an unmerged branch; that
  work is in `master`. Its *procedures* for the VPS are now moot (see the top of
  this file); the audio-routing and model-download sections are still good.
- **Cosmetic:** the relay logs `data\relay-state.json` with a backslash on
  Linux. Only the log string is wrong; the file on disk is correct.
