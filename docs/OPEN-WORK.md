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
`textrelay.cc` (and still `relay.supr.systems`) is a Cloudflare Worker with one Durable Object per
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

### B6 — In-app archive model downloads corrupt at ~28%
**Band: medium. Status: still failing for the user, still not reproducible
here. Instrumented 2026-09-07 so the next failure leaves evidence; two
candidate causes fixed the same day, one of them demonstrated end to end.**

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

| Rank | Band | Finding | Primary location |
|------|------|---------|------------------|
| 17 (part) | low | The close is still posted behind the queued audio on the same port. With the deadline scaled to the worker going quiet, that costs a slower STOP rather than a lost caption; moving it out of band means changing the protocol on both sides, and the worker half needs sherpa-onnx to exercise at all. | `packages/relay/src/localSttWorker.ts` |

Each entry in the audit carries a reproduced failure scenario and a suggested
fix — read the numbered section there before starting.

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

- **`packages/viewer/public/app.js` still decimates if it is ever fed a rate
  above 16 kHz.** Finding 23 stopped the app *asking* it to resample; the
  worklet has no filter of its own. Only matters if something else starts
  feeding it.
- ~~**Idle rooms on the hosted relay are never reaped.**~~ Fixed 2026-09-07,
  lopsidedly and on purpose. A room **nobody ever published to** is removed
  after 30 days by a Durable Object alarm. A room **anybody has touched** - by
  publishing, viewing, or reading or rotating its token - is kept for ever: its viewer token may be in somebody's messages, age is not
  evidence it stopped mattering, and an idle room costs nothing because the
  billing is per request. The alarm also declines to fire while a socket is
  open, since `shouldReap` takes a record and cannot see a live connection.
- **An unexplained viewer socket, seen once** on the hosted relay. Also in that
  README, with the full note.
- **The self-hosted relay's `isLive()` still answers ON AIR before any hello
  arrives — the same defect the uplink-liveness fix closed on the hosted
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

### Other

- ~~**No guard test over `CLAUDE.md`.**~~ Done — `packages/shared/test/handoff.test.ts`
  now covers `HANDOFF.md`, `CLAUDE.md` and this file: every `pnpm <script>`,
  every code path and every document any of them names has to exist, and none of
  them may describe work blocked on SSH to the retired VPS.
- **`HANDOFF.md` is stale at the top.** It still says the latest release is
  v0.5.1 and describes `ralph/pipeline-hardening` as an unmerged branch; that
  work is in `master`. Its *procedures* for the VPS are now moot (see the top of
  this file); the audio-routing and model-download sections are still good.
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
- **Cosmetic:** the relay logs `data\relay-state.json` with a backslash on
  Linux. Only the log string is wrong; the file on disk is correct.
