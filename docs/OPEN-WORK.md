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
**Band: medium. Blocked on: a real failure with the new instrumentation.**

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

Until this is resolved no new archive model can be installed through the UI, so
**the seven archive models have never been run end-to-end in-app**.

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

Plus the nine fixed in turns 31–41 — see `ITERATION_LOG.md`.

### Still open

| Rank | Band | Finding | Primary location |
|------|------|---------|------------------|
| 3 | high | Control API: no credential, `Origin: null` admitted, `GET /link` unredacted. *(Also B5.)* | `packages/companion/src/controlServer.ts` |
| 8 | high | Offline local STT has no backpressure and can never catch up: partials are gated on buffered samples rather than wall clock, and the worker queue is unbounded. **Cannot be verified on this machine** - both archive models in the models dir are `.part` files, which is B6's symptom, so the local engine has never run here. | `packages/relay/src/localSttWorker.ts` |
| 11c | medium | **The last of finding 11.** The heartbeat pings without tracking pongs or calling `terminate()`, so a half-open publisher holds a session for minutes. The reconnect half is done. | `packages/relay/src/server.ts` |
| 17 | medium | The flat 4 s kill timer discards the local STT worker's flush finals, so the last utterance before STOP never reaches viewers. | `packages/relay/src/localStt.ts` |
| 24 | medium | The uplink fights a 4409 kick forever at ~1 s intervals, and its 4401 branch is unreachable dead code. | `packages/companion/src/uplinkClient.ts` |
| 25 | medium | Two concurrent model downloads collide on the shared VAD `.part` file. | `apps/standalone/src/models.ts` |
| 27 | low | Changing `updateFeedUrl` has no effect until restart. | `apps/standalone/src/updater.ts` |
| 28 | low | An unguarded `await startControl()` aborts startup before the tray and window exist. | `apps/standalone/src/main.ts` |
| 30 | low | The Deepgram key validator repaints the live console as a setup placeholder. | `apps/standalone/renderer/app.ts` |
| 32 | low | The error overlay paints on top of the previous transcript. | `apps/standalone/renderer/app.ts` |
| 33 | low | `runtime:prepare` rotates the viewer link **before** checking the relay. | `apps/standalone/src/main.ts` |
| 34 | low | A successful local-STT probe is discarded when the session already stopped. | `packages/relay/src/localStt.ts` |
| 35 | low | Ghost interim rows that never resolve. | `packages/viewer/public/app.js` |
| 36 | low | The session clock subtracts the streamer's epoch from the viewer's. | `packages/viewer/public/app.js` |

Each entry in the audit carries a reproduced failure scenario and a suggested
fix — read the numbered section there before starting.

### Found while fixing the above, not in the audit

- **A phone viewer that *loads* a dead link sits on `RECONNECTING` forever.**
  A rejected socket is a different path from a `kicked` message, so the ENDED
  panel never appears. Noticed while verifying finding 10; adjacent to 9 but not
  the same defect.
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
