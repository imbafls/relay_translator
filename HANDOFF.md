# Handoff — Callout Relay

Rewritten 2026-09-10 at v0.8.0, and brought up to date for 1.0 on 2026-09-18.
The version before the rewrite described the repo at v0.5.1, a hardening branch
that merged long ago, and a VPS that no longer exists; everything below was
checked against the tree again for 1.0. Read
`CLAUDE.md` first - it is the orientation document - then `README.md` for the
product and `DESIGN.md` for the UI spec. `docs/OPEN-WORK.md` is the backlog.

## Where things stand

Releases are the `v*` tags, and `packages/shared/src/changelog.ts` says what
each one changed for the person streaming, newest first - which is why this
page no longer names the latest one: that sentence sat at v0.8.0 after 0.8.1
shipped. `master` is linear - the repo merges by **rebase**, so don't add merge
commits.

The remote relay is the Cloudflare Worker in `apps/hosted-relay`, answering on
`textrelay.cc` and `relay.supr.systems` with one Durable Object per streamer.
The Hostinger VPS that ran a single-tenant relay was stopped on 2026-09-06.
Nothing needs mirroring to it, and nothing can be.

`ITERATION_LOG.md` is the history of the hardening run: one entry per turn,
what was looked at, what it turned out to be, and how it was proved.
`docs/AUDIT-2026-09-05.md` is the adversarial audit of the whole repo, and
`docs/OPEN-WORK.md` records which of its findings are closed and by what.

### What still needs a person

Everything 1.0 ships with knowingly is listed under `## Known limitations in
1.0` in `docs/OPEN-WORK.md`, and again for users in `README.md`. These two are
the ones that need someone other than a developer:

- **Code signing (B4).** `win.publisherName` plus a certificate. Without it
  electron-updater's signature check returns early, so an update is verified
  only against a hash in the feed's own file. A purchase, not a code change.
- **In-app archive model downloads (B6).** 0.8.1 pins every archive to a
  SHA-256 and retries a failed attempt in a staging folder of its own, which
  closes the one cause that matches the reported symptom. Still never seen to
  fail or succeed on the machine that reports it - see issue 1 below, and the
  full investigation in `docs/OPEN-WORK.md`.

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
release workflow run all six steps; a tag can no longer publish with the suite
red.

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

**The browser harness lies about window size.** `scripts/renderer-harness.mjs`
(port 8791) serves the built renderer in a plain browser tab with a stand-in
bridge; the real Electron window is **964×761**, and a re-entered setup
adds a `✕ CLOSE SETUP` row. A pane that fit at 980×800 in the harness showed
half a row with CONTINUE off-screen in the real app.

Verify in the packaged app over CDP:

```bash
pnpm dist:app
# seed a scratch data dir (see below). cygpath -m gives forward slashes,
# because the JSON seed cannot hold a Windows backslash
d="$(cygpath -m "$LOCALAPPDATA")/Temp/cr-verify"; mkdir -p "$d"; printf '{ "setupDone": true, "transcriptDir": "%s/Transcripts", "updateFeedUrl": "http://127.0.0.1:9/" }\n' "$d" > "$d/config.json"
# then launch against it with a debug port and drive it. The variable is set on
# this line itself: unset or empty, it means the real data dir
CALLOUT_RELAY_DATA="$(cygpath -m "$LOCALAPPDATA")/Temp/cr-verify" "apps/standalone/release/win-unpacked/Callout Relay.exe" --remote-debugging-port=9333
# GET http://127.0.0.1:9333/json/list -> webSocketDebuggerUrl -> Runtime.evaluate
```

Notes that cost real time to learn:

- Handlers fire on hidden elements, so
  `document.getElementById('settingsSetup').click()` opens setup without
  navigating.
- Only one instance runs: an already-running app makes a second one exit 0
  immediately and the debug port refuse. Kill it first. A scratch
  `CALLOUT_RELAY_DATA` does not get round this - the lock is Electron's own,
  on a profile folder the variable does not move.
- **Never launch it against the real data dir.** On 2026-09-10 a plain launch
  and one page reload rewrote `%APPDATA%\callout-relay\config.json` twice in
  six seconds. The uplink connected to the hosted relay with the stored
  `publisherToken` and pulled the room's `viewerToken`
  (`GET /admin/viewer-token` in `apps/standalone/src/main.ts`),
  `lastSeenVersion` was bumped - which suppresses the what's-new panel the
  owner's own install would have shown - and defaults were filled in.
  `ConfigStore.persist()` in `packages/companion/src/config.ts` copies the file
  to `config.json.bak` before every save, so two saves leave neither the
  original file nor the previous `.bak` on disk. Reading `config.json` back
  afterwards cannot restore either, or undo a connection to the hosted relay.
- **Point `CALLOUT_RELAY_DATA` at a scratch dir instead,** as the block above
  does. `defaultDataDir()` in `packages/companion/src/config.ts` honours it,
  and config, models, `relay.log` and the embedded relay's `relay-state.json`
  all live under it. Seeded with `setupDone`, the app opens the stage view with
  no keys and no `relayUrl`, so there is no uplink, and the real data dir
  stayed byte-identical through a full CDP run. Driving the app still writes
  the config it is given - a test that clicked CONTINUE changed `stt`, one
  that cleared a key field dropped its cached validation - so re-seed before
  each run.
- Saved transcripts are not under the data dir. Without the seed's
  `transcriptDir` they default to `Documents\Callout Relay\Transcripts`, where
  the SAVED view lists the real ones, DELETE removes them, EXPORT writes beside
  them, and a session started under test adds its own.
- **Nor is the updater's, and in this build the updater is live.**
  `win-unpacked` ships `resources/app-update.yml`, which is what
  `unsupportedReason()` in `apps/standalone/src/updater.ts` looks for, so
  `Updater.start()` asks GitHub 15 s after launch and every 6 h with nobody
  clicking CHECK. A build behind the latest release - an older commit, or a
  `win-unpacked` nobody re-packaged (the main checkout's was 0.5.0 on
  2026-09-10, and its updater found 0.8.0) - downloads it into
  `%LOCALAPPDATA%\@callout-relaystandalone-updater`, where the installed app
  stages its own updates, clearing out any other version staged there. On a
  clean quit it runs that installer with `--updated /S`, which closes any
  running `Callout Relay.exe` and installs over the owner's per-user copy. The
  seed's `updateFeedUrl` is what stops it: `setFeedURL` replaces the GitHub
  provider outright, `isAllowedUpdateFeed()` in `packages/shared/src/index.ts`
  lets `http:` through for loopback, and Chromium will not dial port 9 at all,
  so every check fails at once and UPDATES reads `NET::ERR_UNSAFE_PORT`. A run
  that tests updating needs a feed of its own.
- `ELECTRON_ENABLE_LOGGING=1` puts main-process output on stderr. The worker's
  errors only appear there, never in the UI.
- On the dev desktop, `npx electron-builder --win --dir` in `apps/standalone`
  fails extracting winCodeSign on a symlink privilege error
  (`Cannot create symbolic link`). Add `-c.win.signAndEditExecutable=false`
  for a verification build: it skips only the exe's icon and version edit.

Two layout traps in the renderer: `.ob-actions` uses `margin-top:auto`, so the
step always fills the pane and trimming copy above a list buys nothing; and a
flex child that shrinks below its content **overflows and paints over** its
siblings instead of clipping — use a fixed height for a scrolling list in a
short pane.

## Open work, most useful first

`docs/OPEN-WORK.md` is the full and current list. These are the ones a new
machine is most likely to walk into.

### 1. In-app archive downloads — pinned and retried, not yet confirmed

Downloading `local-whisper-tiny-en` inside the app fails at ~28% with
`Error in bzip2: crc32 do not match`. The **identical** download and decompress
succeeds in plain Node (118,071,777 bytes, `bzip2 -t` clean, extracts to the
exact declared sizes), with and without the progress listener. So the archive,
the library and our pipeline are all fine, and something in Electron's network
stack (proxy?) corrupts or truncates the stream.

Per-file downloads from Hugging Face do work in the app — `whisper-small`'s
375 MB arrived byte-exact — so it is not simply "big downloads fail".

**What 0.8.1 changed.** Every archive in the catalogue now carries a pinned
SHA-256, hashed over the compressed bytes as they stream and checked before
anything an attempt unpacked is published - so bytes that decoded but are not
the pinned archive are a named failure rather than a model. A failed attempt
is retried up to three times, each in a staging folder of its own (`<id>.part`,
then `<id>.part-2`), because on Windows a scanner holding a failed attempt's
files keeps that folder from being removed, and a leftover held by an earlier
run used to abort the next download before it made its first request. That
last shape fits the report exactly: both reported failures left an EMPTY
`.part` directory behind.

**It is still a hypothesis that fits the evidence, not a reproduction.** No
download has been seen to fail or succeed on the machine that reports this,
on 0.8.1 or any build. Get the instrumented message from a real failure
before calling it closed.

**The suggested instrumentation is now in.** `fetchArchive` counts the bytes it
actually receives against `content-length`, so the next failure says one of
`the download stopped early: N of M bytes (P%)`, `the archive would not
unpack after all N bytes arrived`, or - new in 0.8.1 - `archive checksum
mismatch: expected SHA-256 ..., got ...`. That one line decides which half to
chase, and the third answer is the one the earlier instrumentation could not
give: bytes that arrived whole and were still not the archive.

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
issue 1 currently blocks installing them.

`whisper-turbo` in particular has never been loaded — it is the one the mel-bin
fix targets.

## Release process

```bash
pnpm version-bump 1.0.0
git add package.json apps/*/package.json packages/*/package.json   # not -a: the tree may hold unrelated edits
git commit -m "Release v1.0.0"
git tag -a v1.0.0 -m "v1.0.0"
git push origin master v1.0.0      # the Release workflow builds and publishes
```

The workflow refuses to build if the tag and `apps/standalone/package.json`
disagree. It publishes the installer, portable exe, `latest.yml`, blockmap,
both relay servers and `SHA256SUMS.txt`, under GitHub's generated notes.

**Then finish it** — the release is not done when the workflow goes green:

```bash
# the release page gets the changelog prose, not a commit list
# (release-notes.mjs reads packages/shared/dist, so build shared first)
node scripts/release-notes.mjs 1.0.0 | gh release edit v1.0.0 --notes-file -
# the hosted relay: textrelay.cc and relay.supr.systems in one deploy
pnpm deploy:hosted
node apps/hosted-relay/scripts/verify-deploy.cjs    https://textrelay.cc   # 15 checks
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
