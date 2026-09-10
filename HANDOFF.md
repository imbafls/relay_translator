# Handoff — Callout Relay

Rewritten 2026-09-10 at v0.8.0. The version before this described the repo at
v0.5.1, a hardening branch that merged long ago, and a VPS that no longer
exists; everything below has been checked against the tree again. Read
`CLAUDE.md` first - it is the orientation document - then `README.md` for the
product and `DESIGN.md` for the UI spec. `docs/OPEN-WORK.md` is the backlog.

## Where things stand

Latest **release** is v0.8.0: saved transcripts, plus everything written for
0.7.0, which was never released on its own. `master` is linear - the repo
merges by **rebase**, so don't add merge commits.

The remote relay is the Cloudflare Worker in `apps/hosted-relay`, answering on
`textrelay.cc` and `relay.supr.systems` with one Durable Object per streamer.
The Hostinger VPS that ran a single-tenant relay was stopped on 2026-09-06.
Nothing needs mirroring to it, and nothing can be.

`ITERATION_LOG.md` is the history of the hardening run: one entry per turn,
what was looked at, what it turned out to be, and how it was proved.
`docs/AUDIT-2026-09-05.md` is the adversarial audit of the whole repo, and
`docs/OPEN-WORK.md` records which of its findings are closed and by what.

### What still needs a person

- **Code signing (B4).** `win.publisherName` plus a certificate. Without it
  electron-updater's signature check returns early, so an update is verified
  only against a hash in the feed's own file. A purchase, not a code change.
- **In-app archive model downloads (B6).** Still reported failing at ~28% on
  one machine and still not reproducible on the dev desktop - see issue 1
  below, and the full investigation in `docs/OPEN-WORK.md`.

## First run on a new machine

```bash
pnpm install
pnpm --filter @callout-relay/shared build   # other packages import its dist/
pnpm build
pnpm typecheck && pnpm typecheck:test && pnpm test
node scripts/check-renderer-ids.mjs && pnpm smoke
```

`pnpm test` is vitest over `<package>/test/`. `pnpm typecheck:test` is separate
because the tests live outside every package's `rootDir` and `pnpm -r typecheck`
cannot see them — it has caught things `pnpm test` alone did not. CI and the
release workflow run all five; a tag can no longer publish with the suite red.

`pnpm --filter @callout-relay/shared build` is not optional: `packages/shared`
is consumed as built `dist/`, so a stale build shows up as phantom "has no
exported member" errors in `apps/standalone`.

Windows-only for the desktop app (Electron + `sherpa-onnx-win-x64`). The relay
server builds on Linux too.

### Secrets and state

- API keys live in `%APPDATA%\callout-relay\config.json`, not in the repo. The
  new machine has its own keys.
- Local models: `%APPDATA%\callout-relay\models\<model-id>\`.
- Saved transcripts: `Documents\Callout Relay\Transcripts\`, one `.jsonl` per
  session, unless `transcriptDir` in `config.json` names another folder.
- Cloudflare: `pnpm deploy:hosted` uses the session `wrangler login` stored on
  the dev desktop. There are no VPS credentials to carry over any more.

## How to verify UI work — this matters

**The browser harness lies about window size.** `dist/harness` is a plain
browser tab; the real Electron window is **964×761**, and a re-entered setup
adds a `✕ CLOSE SETUP` row. A pane that fit at 980×800 in the harness showed
half a row with CONTINUE off-screen in the real app.

Verify in the packaged app over CDP:

```bash
pnpm dist:app
# then launch with a debug port and drive it
"apps/standalone/release/win-unpacked/Callout Relay.exe" --remote-debugging-port=9333
# GET http://127.0.0.1:9333/json/list -> webSocketDebuggerUrl -> Runtime.evaluate
```

Notes that cost real time to learn:

- Handlers fire on hidden elements, so
  `document.getElementById('keysSetup').click()` opens setup without navigating.
- Only one instance runs: an already-running app makes a second one exit 0
  immediately and the debug port refuse. Kill it first.
- Driving the app **writes the real config**. A test that clicked CONTINUE
  changed `stt`; one that cleared a key field dropped its cached validation.
  Read `config.json` back afterwards and restore.
- `ELECTRON_ENABLE_LOGGING=1` puts main-process output on stderr. The worker's
  errors only appear there, never in the UI.

Two layout traps in the renderer: `.ob-actions` uses `margin-top:auto`, so the
step always fills the pane and trimming copy above a list buys nothing; and a
flex child that shrinks below its content **overflows and paints over** its
siblings instead of clipping — use a fixed height for a scrolling list in a
short pane.

## Open work, most useful first

`docs/OPEN-WORK.md` is the full and current list. These are the ones a new
machine is most likely to walk into.

### 1. In-app model downloads are corrupting — not yet fixed

Downloading `local-whisper-tiny-en` inside the app fails at ~28% with
`Error in bzip2: crc32 do not match`. The **identical** download and decompress
succeeds in plain Node (118,071,777 bytes, `bzip2 -t` clean, extracts to the
exact declared sizes), with and without the progress listener. So the archive,
the library and our pipeline are all fine, and something in Electron's network
stack (proxy?) corrupts or truncates the stream.

Per-file downloads from Hugging Face do work in the app — `whisper-small`'s
375 MB arrived byte-exact — so it is not simply "big downloads fail".

Until it is fixed, no new archive model can be installed through the UI.
Leftover `<id>.part` folders are harmless; they are cleared on the next attempt.

**The suggested instrumentation is now in.** `fetchArchive` counts the bytes it
actually receives against `content-length`, so the next failure says either
`the download stopped early: N of M bytes (P%)` or `the archive would not
unpack after all N bytes arrived`. That one line decides which half to chase.

Evidence gathered since, which narrows it but does not settle it: probed
directly, a truncated bz2 stream reports `input stream ended prematurely` or a
`Cannot read properties of undefined` TypeError — **not** the `crc32 do not
match` in the report. That argues against a plain short read. It is not proof:
the probe used a single-block fixture and a real 118 MB archive is many blocks,
where a partly received block can fail its CRC honestly. Get the instrumented
message from a real failure before assuming either way.

### 2. Unverified: the seven archive models

Nobody has run a transcription session with any of them. Download, extraction,
staging and every failure path are well tested with synthetic and real
archives; the earlier session verified decoding for Moonshine, Whisper tiny.en
and Nemotron through the worker. But end-to-end in-app decode is unproven, and
issue 2 currently blocks installing them.

`whisper-turbo` in particular has never been loaded — it is the one the mel-bin
fix targets.

### 3. Cosmetic

- The release workflow warns that its GitHub actions target Node 20.

## Release process

```bash
pnpm version-bump 0.8.1
git add package.json apps/*/package.json packages/*/package.json   # not -a: the tree may hold unrelated edits
git commit -m "Release v0.8.1"
git tag -a v0.8.1 -m "v0.8.1"
git push origin master v0.8.1      # the Release workflow builds and publishes
```

The workflow refuses to build if the tag and `apps/standalone/package.json`
disagree. It publishes the installer, portable exe, `latest.yml`, blockmap,
both relay servers and `SHA256SUMS.txt`, under GitHub's generated notes.

**Then finish it** — the release is not done when the workflow goes green:

```bash
# the release page gets the changelog prose, not a commit list
# (release-notes.mjs reads packages/shared/dist, so build shared first)
node scripts/release-notes.mjs 0.8.1 | gh release edit v0.8.1 --notes-file -
# the hosted relay: textrelay.cc and relay.supr.systems in one deploy
pnpm deploy:hosted
node apps/hosted-relay/scripts/verify-deploy.cjs    https://textrelay.cc   # 14 checks
node apps/hosted-relay/scripts/verify-isolation.cjs https://textrelay.cc   #  9 checks
```

A deploy restarts every Durable Object, so anyone watching reconnects once.
Tag and release notes carry the changelog prose only - no tooling credit and no
emoji; `packages/shared/test/changelog.test.ts` enforces that for the source.

Auto-update reads `latest.yml` from the GitHub release. An install only looks
anywhere else if `updateFeedUrl` is set.

## Audio routing, for testing two sources

The owner's rig is Elgato Wave Link. Only **mixes** become Windows recording
devices — individual Wave Link channels do not. So:

- `Microphone FX` = their voice (source 1).
- `Chat Mix` = their mic going **out** to the people they talk to. Not the
  other voices.
- `Voice chat` = the channel carrying Discord/Riot audio, routed into
  `Personal Mix` alongside Game, Music, Browser and System.
- `Stream Mix` = mic + Browser. Selecting it as source 2 makes both channels
  transcribe the same voice, which reads as "the second source is broken".

To caption the other people cleanly, create a Wave Link mix containing only the
Voice chat channel and select that as the second source.

Speaker roles follow the **slot**, not the device kind: first source is `YOU`,
second is `CHAT`, with system audio overriding as `CHAT` wherever it sits. A
virtual chat mix enumerates as a microphone, so kinds cannot tell the two apart.
