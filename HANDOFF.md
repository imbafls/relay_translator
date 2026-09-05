# Handoff — Callout Relay

Written 2026-09-05 for a session continuing on another machine from a zip of this
folder. Everything below is verified, not assumed. Read `DESIGN.md` for the UI
spec and `README.md` for the product.

## Where things stand

Latest **release** is v0.5.1 (tagged, published, mirrored to the VPS).

`master` has since taken the local-model crash guard described below (PR #5).
**That fix is not in any installer yet** — v0.5.1 predates it. If you want it on
a machine, cut **v0.5.2** using the release steps at the bottom.

PRs #2–#5 are merged; the repo merges by **rebase**, so history is linear —
don't add merge commits.

## First run on a new machine

```bash
pnpm install
pnpm --filter @callout-relay/shared build   # other packages import its dist/
pnpm build
pnpm typecheck && node scripts/check-renderer-ids.mjs && pnpm smoke
```

`pnpm --filter @callout-relay/shared build` is not optional: `packages/shared`
is consumed as built `dist/`, so a stale build shows up as phantom "has no
exported member" errors in `apps/standalone`.

Windows-only for the desktop app (Electron + `sherpa-onnx-win-x64`). The relay
server builds on Linux too.

### Secrets and state

- API keys live in `%APPDATA%\callout-relay\config.json`, not in the repo. The
  new machine has its own keys.
- Local models: `%APPDATA%\callout-relay\models\<model-id>\`.
- VPS credentials: `F:\Ai\_projects\_secrets\hostinger_vps.txt` (or
  `VPS_PASSWORD`). That file is **not** in the zip — copy it over or the deploy
  script will not run.

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

### 1. Ship the crash guard (merged, unreleased)

Root cause, fully traced: **sherpa-onnx aborts the process** while constructing
the `OfflineRecognizer` for `local-whisper-small`. It is a native `exit()`, not
a throwable error, and local STT runs in a `worker_thread`, so it took the whole
app down with no message.

Ruled out, with evidence: file corruption (bytes match Hugging Face exactly),
configuration (language on/off, `tailPaddings` −1/0/absent, 1 vs 2 threads all
abort identically), and the engine itself (whisper **tiny.en** loads and decodes
on the same build).

The fix loads every local model once in a throwaway child process first
(`localSttWorker.js --probe '<init json>'`), caches the result per model, and
turns a non-zero exit into "could not be loaded on this PC". It drops
whisper-small from the catalogue, moves mel bins into the catalogue (whisper
large-v3 turbo is 128-bin and was loaded as 80), and falls back to the last
cloud model when config names a model that no longer exists.

Verified in the packaged app: probe exits 127 on whisper-small, 0 on zipformer,
and a real two-source local session still transcribes both channels.

### 2. In-app model downloads are corrupting — not yet fixed

Downloading `local-whisper-tiny-en` inside the app fails at ~28% with
`Error in bzip2: crc32 do not match`. The **identical** download and decompress
succeeds in plain Node (118,071,777 bytes, `bzip2 -t` clean, extracts to the
exact declared sizes), with and without the progress listener. So the archive,
the library and our pipeline are all fine, and something in Electron's network
stack (proxy?) corrupts or truncates the stream.

Per-file downloads from Hugging Face do work in the app — `whisper-small`'s
375 MB arrived byte-exact — so it is not simply "big downloads fail".

Not investigated further. Until it is fixed, no new archive model can be
installed through the UI. Leftover `<id>.part` folders are harmless; they are
cleared on the next attempt.

Suggested next step: instrument `fetchArchive` to log bytes received vs
`content-length` on failure, to separate truncation from corruption.

### 3. Unverified: the seven archive models

Nobody has run a transcription session with any of them. Download, extraction,
staging and every failure path are well tested with synthetic and real
archives; the earlier session verified decoding for Moonshine, Whisper tiny.en
and Nemotron through the worker. But end-to-end in-app decode is unproven, and
issue 2 currently blocks installing them.

`whisper-turbo` in particular has never been loaded — it is the one the mel-bin
fix targets.

### 4. Cosmetic

- The release workflow warns that its GitHub actions target Node 20.
- The relay server logs `data\relay-state.json` with a backslash on Linux. Only
  the log string is wrong; the file on disk is correct.

## Release process

```bash
pnpm version-bump 0.5.2
git commit -am "Release v0.5.2" && git tag -a v0.5.2 -m "v0.5.2"
git push origin master v0.5.2      # the Release workflow builds and publishes
```

The workflow refuses to build if the tag and `apps/standalone/package.json`
disagree. It publishes the installer, portable exe, `latest.yml`, blockmap,
both relay servers and `SHA256SUMS.txt`.

**Then mirror to the VPS** — the release is not finished without it:

```bash
export MSYS_NO_PATHCONV=1   # or run from PowerShell; MSYS mangles /opt paths
gh release download v0.5.2 -D <dir> -p "CalloutRelay-Setup-*.exe" -p "*.blockmap" \
  -p latest.yml -p callout-relay-server-linux -p SHA256SUMS.txt
sha256sum -c <(grep -iE "Setup|server-linux" SHA256SUMS.txt | tr 'A-F' 'a-f')

node scripts/vps.mjs put <installer>  /opt/callout-relay/data/updates/<installer>
node scripts/vps.mjs put <blockmap>   /opt/callout-relay/data/updates/<blockmap>
# verify the uploaded installer's sha256 BEFORE publishing the manifest
node scripts/vps.mjs put latest.yml   /opt/callout-relay/data/updates/latest.yml   # last
node scripts/vps.mjs put <linux-server> /opt/callout-relay/callout-relay-server.new
node scripts/vps.mjs exec "cd /opt/callout-relay && cp -f callout-relay-server callout-relay-server.bak \
  && chmod +x callout-relay-server.new && mv -f callout-relay-server.new callout-relay-server \
  && systemctl restart callout-relay && sleep 3 && systemctl is-active callout-relay"
```

Check `https://relay.supr.systems/health` and
`https://relay.supr.systems/updates/latest.yml` afterwards. Upload `latest.yml`
**last** so the manifest never points at a file that is not there yet, and check
whether anyone is attached (`viewers`) before restarting.

Auto-update defaults to the GitHub feed; the VPS feed only serves installs that
set `updateFeedUrl`.

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
