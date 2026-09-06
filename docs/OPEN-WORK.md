# Open work

One place for everything known-but-unfinished, so it stops living in one
person's head. Written 2026-09-05 against v0.5.3.

Two sources feed this: the 27 unaddressed findings from
[`AUDIT-2026-09-05.md`](AUDIT-2026-09-05.md) (36 ranked findings, 9 fixed in
turns 31–41 — see `ITERATION_LOG.md`), and the operational items that need a
person, a credential, or a piece of hardware.

**On severity:** the audit assigns no severity labels. It ranks its findings by
impact, and states the ordering rule itself — "remotely reachable defects on
`relay.supr.systems` first, then code execution on the user's machine, then the
local failure paths." The **rank** column below is the audit's own number and is
the authoritative signal. The **band** column is derived from that rank and from
the audit's stated grouping; it is a reading aid, not a quote.

---

## Blocked

### B1 — Mirror the VPS relay to v0.5.3
**Band: high. Blocked on: SSH credentials that are not on this machine.**

`relay.supr.systems` was last mirrored at **v0.5.1**. Verified directly:
`https://relay.supr.systems/updates/latest.yml` returns `version: 0.5.1`.

**18 commits touching `packages/relay/src` or `packages/shared/src` have landed
since** (`git log v0.5.1..v0.5.3 -- packages/relay/src packages/shared/src`).
Six of them are crash-or-serving class and are the reason this matters:

| Commit | What the running binary still does wrong |
|--------|------------------------------------------|
| `c48c718` | `GET //%25` exits the relay process. No credentials, one line of curl, repeatable. |
| `9d015e3` | A four-byte WebSocket text frame `null` dereferences past the parse guard and exits the process. |
| `e584934` | A malformed publisher `hello` takes the relay down. |
| `9afbb05` | A half-written `relay-state.json` wedges the relay on boot. |
| `5f99053` | Every abandoned installer download strands a file descriptor (measured: 25 aborts, 25 undestroyed streams). |
| `c12cc75` | A suffix range request (`bytes=-100`) serves the *first* 101 bytes under a `Content-Range` claiming otherwise. |

**Corroborating symptom, verified today:** `https://relay.supr.systems/health`
returns `{"ok":true,"live":true,"viewers":0}` while nothing is publishing — a
stale publisher session, which is consistent with the missing session-churn
fixes. A relay restart clears it.

**What unblocks it:** the Hostinger VPS root password, via either
`VPS_PASSWORD` in the environment or the file
`F:\Ai\_projects\_secrets\hostinger_vps.txt` that `scripts/vps.mjs` reads.
Neither exists here — `VPS_PASSWORD` is unset and the `F:` drive is not present
on this machine at all. `VPS_SECRETS_FILE` can point at an alternative path.

Once credentials exist, the procedure is in `HANDOFF.md` under "Release
process" (download assets, verify checksums, upload installer + blockmap,
upload `latest.yml` **last**, swap the Linux binary, restart, re-check
`/health`). Check `viewers` before restarting so a live session is not cut.

### B2 — Set `RELAY_PUBLISHER_TOKEN` / `RELAY_VIEWER_TOKEN` on the VPS, then point the laptop at it
**Band: high. Blocked on: the same SSH credentials as B1.**

The VPS was provisioned before `vps.env.example` named these variables, so its
env sets neither. `loadState()` therefore fell through to `generateToken()` and
wrote a random pair into the relay's own `relay-state.json`. Consequences:

- The publisher token exists **only on that box**. The desktop app cannot be
  pointed at the relay without SSHing in to read it.
- Wiping the data directory mints a new pair and invalidates every viewer link
  already handed out.

`85706ca` and `9f0c393` fixed the documentation half — the example env file now
explains both variables and how to generate one, and the app's KEYS placeholder
now names `RELAY_PUBLISHER_TOKEN` rather than the `RELAY_PUBLISH_TOKEN` spelling
that appears in no file. **The deployed env itself is still unset.**

*(The local, gitignored `packages/relay/sea/vps.env` on this machine sets only
`DEEPGRAM_API_KEY`, `GEMINI_API_KEY` and `RELAY_PORT` — verified by variable
name, values not read. The copy actually deployed on the VPS could not be
inspected from here.)*

**What unblocks it:** B1's credentials. Then write both tokens into
`/opt/callout-relay/.env`, restart, and paste the publisher token into the
desktop app's KEYS pane alongside `wss://relay.supr.systems`.

### B3 — The VPS `.env` still holds the pre-rotation API keys
**Band: high. Blocked on: the same SSH credentials as B1.**

Reported in `HANDOFF.md`: the Deepgram and Gemini keys were rotated during an
earlier session and `/opt/callout-relay/.env` was never updated. **Taken on
report — not verifiable from this machine.** Fold this into the same SSH session
as B1 and B2; all three are one visit to the box.

### B4 — Code signing
**Band: high. Blocked on: a Windows code-signing certificate (a purchase and an
identity check, not an engineering task).**

`apps/standalone/package.json`'s `win` block sets no `publisherName` and the
build ships no certificate, so electron-updater's `NsisUpdater.verifySignature`
returns early (`if (publisherName == null) return null`). The **only** integrity
proof for an update is the sha512 in `latest.yml`.

`isAllowedUpdateFeed()` in `packages/shared/src/index.ts` exists to bound the
blast radius until then: `https:` only, with `http:` allowed solely for loopback
(`localhost`, `127.0.0.1`, `[::1]`, `::1`), and an unset feed meaning the
packaged GitHub feed. That closes the drive-by and the LAN-MITM paths; it does
not make an update cryptographically verified.

**What unblocks it:** obtain a certificate, then set `win.publisherName` and
wire signing into `electron-builder`.

### B5 — A real credential for the local control API (`GET /link`)
**Band: high. Blocked on: Stream Deck hardware to test the property inspector
against.**

Audit finding 3, half fixed in turn 33. `packages/companion/src/controlServer.ts`
carries the explicit `STILL OPEN` comment on the route. As it stands:

- `GET /link` returns the unredacted viewer link and does not go through
  `redact()` at all.
- `allowedOrigin` returns true for `origin === "null"` and echoes it back as
  `Access-Control-Allow-Origin: null` — which matches the opaque origin a
  sandboxed iframe on any web page sends.
- `guardPost` checks header **presence**, not a secret, and the OPTIONS
  preflight advertises the header name.

So a page you visit can ask for your viewer link and watch your live captions.
`b767273` stopped the API keys leaking and turn 33 masked the token in
`/status`; this route is what is left.

**Fix:** a per-launch token the app writes to `%APPDATA%` and the property
inspector reads, gating reads as well as writes, with the origin allowlist kept
as defence in depth. **What unblocks it:** a Stream Deck to verify the inspector
still works after the change — the audit notes this could not be wired or tested
from the machine it ran on.

### B6 — In-app archive model downloads corrupt at ~28%
**Band: medium. Blocked on: a real failure with the new instrumentation.**

Reported in `HANDOFF.md`, **taken on report — not reproduced here.**
Downloading `local-whisper-tiny-en` in the app fails with
`Error in bzip2: crc32 do not match`. The identical download succeeds in plain
Node, and per-file Hugging Face downloads work in the app, so it is not simply
"big downloads fail" — something in Electron's network stack is suspected.

The instrumentation that decides which half to chase is already shipped
(`fetchArchive` counts received bytes against `content-length`). **But audit
finding 26 says that counter is unsound** — it compares bytes pulled from a
demand-driven body, so a decode failure always reads as a truncated download.
Fix 26 first, or the next real failure message will point at the wrong half.

Until this is resolved no new archive model can be installed through the UI.
Consequently **the seven archive models have never been run end-to-end in-app**;
`whisper-turbo` in particular has never been loaded, and it is the one the
mel-bin fix targets.

---

## Not blocked

Anyone can pick these up. Ordered by the audit's rank.

### From the audit — 27 unaddressed findings

| Rank | Band | Finding | Primary location |
|------|------|---------|------------------|
| 3 | high | Control API: no credential, `Origin: null` admitted, `GET /link` still returns the viewer link unredacted. *(Also B5 — the fix needs a Stream Deck to verify.)* | `packages/companion/src/controlServer.ts` |
| 6 | high | A failed embedded-relay restart leaves the app permanently dead **and reports success**: the bad port is persisted before the restart is attempted, the working relay is torn down with no rollback, and the renderer logs "keys & relay saved". | `apps/standalone/src/main.ts:405` |
| 7 | high | A stale second-source device id traps the user — the select shows "No second source" while config still holds the dead id, so START fails every time with a bare `OverconstrainedError`. | `apps/standalone/renderer/app.ts:614` |
| 8 | high | Offline local STT has no backpressure and can never catch up: partials are gated on buffered samples rather than wall clock, and the worker queue is unbounded. | `packages/relay/src/localSttWorker.ts:288` |
| 9 | high | Viewer reconnect opens a second socket; the relay's kick then closes the **healthy** one, so a live session shows "THIS LINK HAS ENDED" until a full reload. | `packages/viewer/public/app.js:333` |
| 10 | high | A kicked OBS overlay paints the ENDED panel onto the broadcast — the `kicked` handler has no `?obs=1` guard. | `packages/viewer/public/app.js:377` |
| 11 | high | STT death is never surfaced: no Deepgram reconnect, `onClose` never calls `onSttError`, `/health` keeps reporting live, and billed seconds keep accruing for audio that never left the process. | `packages/relay/src/deepgram.ts:90` |
| 15 | medium | A STOP landing during `start()` is silently undone — devices stay captured and the mic indicator stays lit while the UI says idle. | `packages/companion/src/capture/index.ts:162` |
| 17 | medium | The flat 4 s kill timer discards the local STT worker's flush finals, so the last utterance before STOP never reaches viewers. | `packages/relay/src/localStt.ts:149` |
| 19 | medium | Re-entered setup rejects a working key and locks step 1 — the verdict cache is keyed by provider, not by the value that was validated. | `apps/standalone/renderer/app.ts:1242` |
| 20 | medium | The tray and Stream Deck hand out the `?obs=1` overlay URL as the phone link, so the recipient gets the transparent single-line OBS variant. | `apps/standalone/src/main.ts:138` |
| 21 | medium | A capture device lost mid-session leaves a silent, still-billing session marked LIVE — no `track.onended` listener exists anywhere in the package. | `packages/companion/src/capture/index.ts:106` |
| 22 | medium | Translation failures are logged once, latched for the life of the session, and never reach the user; viewers sit on the "…" placeholder forever. | `packages/relay/src/session.ts:199` |
| 23 | medium | The 48 kHz → 16 kHz downsample has no anti-alias filter — measured, a 12 kHz tone comes out at 4 kHz with **0 dB** attenuation, on every session. **One-line fix** (`new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })`). | `packages/companion/src/capture/index.ts:112` |
| 24 | medium | The uplink fights a 4409 kick forever at ~1 s intervals, and its 4401 branch is unreachable dead code, so "RELAY ERROR · CHECK KEYS" can never fire. | `packages/companion/src/uplinkClient.ts:119` |
| 25 | medium | Two concurrent model downloads collide on the shared VAD `.part` file; the loser shows FAILED and downloads nothing, and a cancel can leave a zero hole in the published VAD. | `apps/standalone/src/models.ts:62` |
| 26 | medium | An archive failure always blames the transport, never the archive — the byte counter is compared against `content-length` on a demand-pulled body. **Blocks diagnosing B6.** | `apps/standalone/src/models.ts:201` |
| 27 | low | Changing `updateFeedUrl` has no effect until restart: `setFeedURL` sits below a cached early return. | `apps/standalone/src/updater.ts:65` |
| 28 | low | An unguarded `await startControl()` aborts startup before the tray and window exist if anything holds 47477 — no window, no tray, and the single-instance lock may linger. | `apps/standalone/src/main.ts:693` |
| 29 | low | `audioEndSec` double-counts `msg.start`, pinning reported STT latency at 0 for the rest of the session; the local engine reports correctly, so the two engines disagree. | `packages/relay/src/deepgram.ts:78` |
| 30 | low | The Deepgram key validator repaints the live console as a setup placeholder if it resolves after setup closed. | `apps/standalone/renderer/app.ts:1570` |
| 31 | low | Any save re-syncs LINK MODE and discards the unsaved pick, so SAVE can write `"unique"` and rotate a link already shared. | `apps/standalone/renderer/app.ts:654` |
| 32 | low | The error overlay paints on top of the previous transcript, making the error itself unreadable. | `apps/standalone/renderer/app.ts:447` |
| 33 | low | `runtime:prepare` rotates the viewer link **before** checking the relay, so every failed START in `unique` mode still invalidates the link and kicks phone viewers. | `apps/standalone/src/main.ts:439` |
| 34 | low | A successful local-STT probe is discarded when the session already stopped, so the per-process cache never populates and the next start pays the full probe again. | `packages/relay/src/localStt.ts:207` |
| 35 | low | Ghost interim rows that never resolve — the `hello` branch does not clear interims, and an empty final never reaches `onFinal` to release the reserved id. | `packages/viewer/public/app.js:352` |
| 36 | low | The session clock subtracts the streamer's epoch from the viewer's, so clock skew displays as duration error and negative skew freezes at 00:00:00. | `packages/viewer/public/app.js:190` |

Each entry in the audit carries a reproduced failure scenario and a suggested
fix — read the numbered section there before starting.

### Other

- **No guard test over `CLAUDE.md`.** `packages/shared/test/handoff.test.ts`
  checks that every `pnpm` script, file and doc `HANDOFF.md` names actually
  exists. `CLAUDE.md` is now the file a session reads first and has no
  equivalent. Extending that test to cover both files is small and in the spirit
  of the existing convention.
- **`HANDOFF.md` is stale at the top.** It still says the latest release is
  v0.5.1 and describes `ralph/pipeline-hardening` as an unmerged branch; that
  work is in `master` and v0.5.3 is tagged and published. Its procedures are
  still accurate. Either refresh the "Where things stand" section or point it at
  this file.
- **Cosmetic:** the relay logs `data\relay-state.json` with a backslash on
  Linux. Only the log string is wrong; the file on disk is correct.

### Recently closed — do not re-open

- *"The release workflow warns its actions target Node 20"* (`HANDOFF.md`
  cosmetic list) — fixed by `cb29d73`, which moved both workflows to
  checkout@v5, setup-node@v5, pnpm/action-setup@v5, upload-artifact@v7 and
  download-artifact@v8.
- *"The relay is never run on Linux"* — CI gained a `linux-relay` job, and
  `f1e55d3` gated the release's Linux binary on Linux tests before `postject`
  stamps it. v0.5.3 was the first tag built that way. *(That the job has since
  run green is reported, not verified from this machine — checking GitHub
  Actions needs credentials this session does not have.)*
