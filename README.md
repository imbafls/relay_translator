# Callout Relay

Live captions of what is being said, on someone else's phone. Capture your mic,
the system audio, or up to three sources at once; transcribe in the cloud
(Deepgram) or on your own PC (local sherpa-onnx models); optionally translate
with Gemini. Whoever you send the link to reads it in a browser, or you put it
on a stream as a transparent OBS overlay.

Two things people use it for:

- **Reading rather than listening.** Someone who is deaf or hard of hearing,
  or in another room, or on a call they cannot hear well - they open a link on
  a phone and read what is being said. No app, no account, no install on their
  side.
- **Translated game comms.** Your callouts in English, your friend reading
  Vietnamese, neither of you leaving the game.

**If you just want to use it, read [`docs/GUIDE.md`](docs/GUIDE.md).** It walks
through the first run and getting a link onto someone else's phone, without
assuming you know what a relay is. The rest of this file is for working on the
code.

```
 up to 3 audio sources (PCM 16 kHz, interleaved 1-3 channels)
        │  WebSocket (token-authed)
        ▼
┌───────────────────┐      ┌──────────────────────────────┐
│  relay server     │      │  viewer page (phone / OBS)   │
│  Deepgram nova-3  │      │  dual subtitles:             │
│   or local model  │─────▶│    YOU / CHAT tag            │
│  Gemini Flash     │  WS  │    EN callout (dim)          │
└───────────────────┘      │    VI translation (big)      │
        ▲                  └──────────────────────────────┘
        │
┌───────┴───────────┐
│  companion        │      claims a room on the hosted relay
│  (standalone app) │      capture, tray, settings, updates
└───────────────────┘
```

## Repo layout

```
apps/standalone/     Electron app: settings UI, audio picker, copy-link, tray
apps/hosted-relay/   Cloudflare Worker: one room per user, pure caption fan-out
packages/companion/  shared capture + relay client + hosted-room claim
packages/relay/      the relay: audio in -> Deepgram or local sherpa-onnx ->
                     Gemini -> WS out, and serves the viewer page
packages/viewer/     phone page, token-gated, OBS transparent mode
packages/shared/     types, config schema, wire protocol
```

## Latency budget

| Stage | Target |
| --- | --- |
| Deepgram streaming (endpointing 300 ms) | ~300 ms |
| Gemini 3.1 Flash-Lite (thinkingBudget 0) | ~400–900 ms |
| Network + render | ~300 ms |
| **Total (utterance end -> subtitle)** | **< 1.5 s** |

Source text is broadcast the instant Deepgram finalizes; the translation
patches the same segment id when Gemini returns.

## Setup

### Ready-made executables (no toolchain needed)

Every release attaches its own binaries:
**[github.com/imbafls/relay_translator/releases/latest](https://github.com/imbafls/relay_translator/releases/latest)**

| Asset | What it is |
| --- | --- |
| `CalloutRelay-Setup-<version>.exe` | Windows installer (desktop + Start Menu shortcuts, updates itself) |
| `CalloutRelay-Portable-<version>.exe` | Portable single exe - run from anywhere, nothing installed |
| `callout-relay-server.exe` | Standalone relay server, Windows |
| `callout-relay-server-linux` | The same relay, Linux |
| `latest.yml` | Update feed the installed app reads |
| `*.blockmap` | Lets an update download only the changed bytes |
| `SHA256SUMS.txt` | Checksums for the binaries |

Windows will warn about an unknown publisher: the installer is not code-signed
yet. The sha512 in `latest.yml` is what the app checks before applying an
update.

The desktop apps embed the relay, the viewer page and the
local speech engine - there are no dev servers, no Node.js install, no terminal.
Install (or run the portable exe), pick cloud or local speech in the setup, and
you're done. The relay server exe is cloud-only (no local models).

### Build the executables yourself

```powershell
pnpm install
pnpm dist        # installer + portable -> apps/standalone/release/
                 # relay server exe     -> packages/relay/sea/
```

API keys - either put them in `.env` at the repo root (gitignored, dev only):

```
DEEPGRAM_API_KEY=...
GEMINI_API_KEY=...
```

or paste them into the desktop app once (**SETTINGS** in the app footer, or
Ctrl and comma). Keys are stored in `%APPDATA%\callout-relay\config.json` on
Windows.

## Updates

The installed app checks for a new version 15 seconds after launch and every six
hours after that, downloads it in the background, and installs it on the next
restart - a live session is never interrupted. `SETTINGS → UPDATES` shows the
running version, the last check, a manual **CHECK**, and a switch to turn the
background checks off. When an update is staged, an amber chip appears in the footer and in
the tray menu; clicking it restarts into the new version.

The portable exe cannot replace itself, so it reports "portable build" and links
to the releases page instead.

The app reads the GitHub release for each tag. The repo is public, so that feed
answers without a token and needs no configuration.

To host builds yourself instead, set `updateFeedUrl` under
`SETTINGS → ADVANCED` to any static directory serving `latest.yml` next to the
installer. The relay can be that directory: it serves `<dataDir>/updates` at
`/updates/`, and `/download` redirects to whatever `latest.yml` names, which
gives you one stable link to hand out. Only `https:` is accepted, or `http:` on
loopback - the installer is unsigned, so the feed is the only thing deciding
which binary runs.

## Releasing

Tagging is the whole release process - the `Release` workflow builds the
installers, the update feed and both relay-server binaries, then attaches them to
the GitHub release:

Write the changelog entry **first** - `packages/shared/src/changelog.ts`, newest
first, with a `version` matching the tag. A guard test fails the gate without
it, and the same entry becomes both the in-app "what's new" panel and the
GitHub release notes, so the two cannot drift.

```powershell
pnpm version-bump 0.5.7
git commit -am "Release v0.5.7"
git tag -a v0.5.7 -m "v0.5.7"
git push origin master v0.5.7
```

The workflow refuses to build when the tag and `apps/standalone/package.json`
disagree, which is what `pnpm version-bump` keeps in step - so an `rc` tag can
never build, and `workflow_dispatch` is the way to re-run one.

`CI` runs the whole gate on every push and pull request: `pnpm -r build`,
`pnpm -r typecheck`, `pnpm typecheck:test`, `pnpm test`,
`node scripts/check-renderer-ids.mjs` and `pnpm smoke`, plus a second job that
builds and tests the Linux relay binary on Linux.

The publish job attaches a bare compare link as the release notes. Replace it
with the prose from the changelog:

```powershell
node scripts/release-notes.mjs 0.5.7 | gh release edit v0.5.7 --notes-file -
```

## Run

### Desktop app (the normal way)

Launch **Callout Relay** (Start Menu, desktop icon, or the portable exe).

The window is a caption console: the live transcript is the whole stage, and
every control sits in one signal-chain strip underneath it
(`01 SOURCE -> 02 TRANSCRIBE -> 03 TRANSLATE -> 04 OUTPUT`).

- **First run** walks you through three steps: how Relay hears you (**Cloud**
  = a Deepgram key, checked as you paste; **Local** = pick a model and download
  it), a Gemini key (optional - skip it for English-only captions), and your
  audio source(s) plus where captions go. Run it again any time from
  `SETTINGS → RUN SETUP AGAIN` or the tray menu.
- **01 SOURCE** picks `Default microphone` or `System audio (game + comms)`
  (system audio uses Windows loopback capture - no stereo mix fiddling). The
  `+` rows add a second and third source: mic + system audio captions your own
  voice *and* everyone else's. Each source is transcribed on its own channel -
  with Deepgram that is `multichannel=true` and every channel is billed. While
  live the block turns into an input level meter.

  With two or more sources every caption carries a tag: `YOU` and `CHAT` by
  default, and `CH3` for a third. Rename them and pick their colours under
  `SETTINGS → SPEAKER NAMES` - useful when the sources are two people rather
  than you and the room.
- **02 TRANSCRIBE** lists the cloud models and the local ones. Local models run
  on your CPU through sherpa-onnx, cost nothing, and never send audio anywhere;
  pick one and hit `DOWNLOAD` in the meta line (or manage them under
  `SETTINGS → LOCAL SPEECH MODELS`). Models live in
  `%APPDATA%\callout-relay\models\<model-id>\`.
- **03 TRANSLATE** holds the language pair and the on/off toggle. It starts
  **off** - a fresh install captions what it hears and nothing else. Add a Gemini
  key and switch it on to get a second column; with no key it greys out and the
  stage stays a single caption column.
- **04 OUTPUT** chooses Phone, OBS, or Both. OBS is served entirely from this PC
  and never needs a relay; phone links need one to leave your network - see
  **Sending someone the link** below.
- Hit **START SESSION**, then **COPY** the link in the footer and send it to
  whoever is reading. The link is masked on screen - click it to read it - and
  COPY still copies the real one. `unique` link mode mints a fresh link per
  session; **Fixed** keeps one alive, which is what an OBS browser source
  needs. **NEW** rotates it and kicks whoever is on the old one.
- **SETTINGS** (or Ctrl and comma) opens everything you can change, **LOG**
  shows the detailed session log with per-line latency. `Esc` returns to the
  stage.
- **SAVED** lists every session this PC has kept. Each finished line and its
  translation is written to `Documents\Callout Relay\Transcripts` while the
  session runs, so a crash or a dropped connection does not take it with it.
  The newest session opens first; `EXPORT .TXT` and `EXPORT .SRT` write a
  readable copy beside it. Switch saving off, or move it, under
  `SETTINGS → THIS APP → TRANSCRIPTS`. Nothing in these files leaves the PC.
- Closing the window hides to tray - capture keeps running mid-game. The tray
  menu can start/stop and rotate the link without opening the app.
- Settings changes (model / language / audio source) apply live: the session
  restarts but the viewer link survives.

The phone viewer and the OBS overlay share the app's design; `DESIGN.md` is the
spec they are built against.

### Sending someone the link

**A fresh install is LAN-only by construction.** The app runs its own relay on
port 8787; that serves anyone on the same wifi, and an OBS browser source on the
same PC. A phone on mobile data cannot reach it. That is the default, not a
misconfiguration.

To get a link that opens anywhere:

> `SETTINGS` → **WHO CAN OPEN IT** → **GET AN ADDRESS THAT WORKS ANYWHERE**

One press. It claims a private room on the hosted relay, stores the address and
token for you, and the chip changes from `THIS NETWORK ONLY` to `ANYONE WITH THE
LINK`. Nothing to type, no account, and the button disappears afterwards -
claiming a second room would orphan a link you may already have sent.

The person reading needs nothing at all: they open the URL in a phone browser.
No app, no install, no sign-in. They can set their own text size, font, colours
and theme with the `AA` button; those belong to their device, so your OBS overlay
and their phone can look completely different.

**What the hosted relay is.** A Cloudflare Worker, one room per user, in
`apps/hosted-relay/`. It does **no transcription and no translation** and holds
no API keys - the transcript is made on your PC, and the relay only passes
finished captions on to whoever holds the link. One publisher per room: a second
copy of the app on the same token evicts the first.

**The link is the only credential.** Anyone who has it can read the captions -
no password, no expiry, no device check. Treat it like one. The app masks it on
screen for that reason; click it to read it, or use COPY. **NEW** mints a fresh
link and disconnects everyone on the old one.

**On the local relay only one device can watch at a time.** The viewer socket map
is keyed by the token, so a second device opening the same link kicks the first
(`another device opened this link`). The OBS browser source counts as a viewer on
that same token, so a phone and an overlay fight each other on a LAN-only setup.
Claiming a room fixes it: the hosted relay broadcasts to as many viewers as you
like, so phones go there while OBS keeps the local link to itself.

### Running your own relay

Optional. The app already carries a relay, and the button above covers the remote
case - this is for pointing the app at a relay you control instead.

`packages/relay` is that server, shipped as `callout-relay-server.exe` and
`callout-relay-server-linux` on every release. Unlike the hosted Worker it does
the real work, so it needs the keys:

- Set `DEEPGRAM_API_KEY` and `GEMINI_API_KEY` in its environment, plus
  `RELAY_PUBLISHER_TOKEN` and `RELAY_VIEWER_TOKEN`. Without those last two it
  mints random tokens that exist only on that machine, and you cannot point the
  app at it without reading them off the box.
- Open `RELAY_PORT` (default 8787).
- In the app, `SETTINGS → ADVANCED`: **RELAY URL** `ws://your-server:8787` and
  **PUBLISH TOKEN** to match. `Public base URL` is for tunnels
  (`ngrok` / `cloudflared`).
- It serves exactly ONE streamer - a second publisher evicts the first - so it
  cannot be shared. `apps/hosted-relay` is the multi-tenant answer, and is what
  the button uses.

Tokens persist in `relay-state.json` in its data dir (`%APPDATA%\callout-relay\`
on Windows, next to the exe otherwise), so the viewer link survives restarts.

Rotate the viewer link remotely on either relay:
`POST /admin/rotate-viewer-token` with `Authorization: Bearer <publisher token>`.

To deploy the hosted relay yourself (it is pinned to one Cloudflare account):

```powershell
pnpm deploy:hosted
node apps/hosted-relay/scripts/verify-deploy.cjs https://textrelay.cc
node apps/hosted-relay/scripts/verify-isolation.cjs https://textrelay.cc
```

Run both verify scripts after any deploy. The Worker serves the viewer page from
`packages/viewer/public`, so deploying from a dirty tree publishes whatever is
in it - which is how the live page once ended up four fixes behind the repo.

## Viewer page

`http://<lan-ip>:8787/watch/<token>`

- Mobile-friendly dark UI with the last few callout lines.
- `?obs=1` - transparent background, only the latest subtitle pair, sized for
  OBS browser sources (add it as a Browser source, 1920x1080). The OBS link is
  the same token with this appended.
- `?settings=1` - pins the display-settings bar, which in OBS otherwise only
  appears on hover. This is what `SETTINGS → OPEN CAPTION VIEW` uses. Add
  `&bar=0` to drop the amber marker.
- The link is the token: whoever has it can watch, and there is nothing else
  checked. **NEW** rotates it and kicks everyone on the old one.
- On the app's own relay only one device can be connected at a time; the
  hosted relay has no such limit. See **Sending someone the link**.

## Config schema

```json
{
  "stt": "deepgram-nova-3",
  "translation": "gemini-3.1-flash-lite",
  "sources": ["default-mic", "system-loopback"],
  "sourceLabels": ["", ""],
  "sourceColors": ["#e0a43a", "#7fb6d9"],
  "languages": { "source": "en", "target": "vi" },
  "translationEnabled": false,
  "profanityFilter": true,
  "showLatency": true,
  "linkMode": "unique",
  "output": "phone",
  "autoUpdate": true,
  "saveTranscripts": true,
  "relayPort": 8787,
  "setupDone": true
}
```

`sources` is the authoritative list, up to three entries; `audioSource` and
`audioSource2` still exist for older configs and are deprecated. `relayUrl`,
`publisherToken`, `publicBaseUrl` and `updateFeedUrl` are only present once set.
`profanityFilter` masks the source line for viewers, not the translation, and
its word list is English only - it is a courtesy, not a guarantee.
`saveTranscripts` keeps a copy of every finished line on this PC and is on by
default, including for a config written before the key existed.
`transcriptDir` is only present once a folder has been chosen; absent (or `""`)
means `Documents\Callout Relay\Transcripts`. The saved copy is not masked by
`profanityFilter` - it is the streamer's own record.

Notes on models:
- `deepgram-nova-3` - fastest, best for English comms.
- `deepgram-nova-3-multi` - multilingual (en/es/fr/de/pt/it/...).
- `deepgram-nova-2` - widest language support (incl. Vietnamese STT).
- `gemini-3.1-flash-lite` - cheapest translation with a big free quota.

Local models (`local-*`, sherpa-onnx int8 exports from the `csukuangfj/*`
Hugging Face mirrors, downloaded file by file by the app):

| id | what | size |
| --- | --- | --- |
| `local-zipformer-en-20m` | streaming English, word-by-word partials, lowest latency | 44 MB |
| `local-zipformer-en` | streaming English, larger | 68 MB |
| `local-nemotron-streaming` | Nemotron streaming 0.6B - live words, heavy | 651 MB |
| `local-moonshine-tiny` | English utterances, very small | 118 MB |
| `local-moonshine-base` | English utterances, more accurate | 274 MB |
| `local-whisper-tiny-en` | Whisper Tiny, English | 99 MB |
| `local-whisper-turbo` | Whisper Turbo - ~100 languages, slowest | 989 MB |
| `local-sense-voice` | SenseVoice Small - zh / en / ja / ko / yue | 240 MB |
| `local-parakeet-tdt-0.6b-v3` | NVIDIA Parakeet TDT 0.6B v3 - best accuracy, English + 24 European languages | 670 MB |
| `local-parakeet-tdt-0.6b-v2` | the previous Parakeet | 631 MB |

The app groups these into LIGHT / MEDIUM / HEAVY and recommends a tier from the
machine it is running on. `packages/shared/src/index.ts` is the catalogue of
record - the table above will drift before that does.

Streaming models decode as you speak; the others segment speech with silero
VAD (1 MB, fetched alongside) and decode each utterance, re-decoding the open
one every ~1.2 s for a partial. Everything runs in a worker thread so the relay
never stalls. Parakeet decodes a 6 s utterance in ~0.6 s on a desktop CPU.

## Testing

```powershell
pnpm -r build                      # do this first on a clean checkout - shared
                                   # emits the .d.ts everything else reads
pnpm test                          # the whole suite
pnpm typecheck:test                # tests live outside each package's rootDir,
                                   # so `pnpm -r typecheck` does not see them
node scripts/check-renderer-ids.mjs
pnpm smoke                         # full relay e2e without API keys
```

Those six, in that order, are what CI runs and what a release has to pass.

Deeper, against real services or a real model:

```powershell
node packages/relay/scripts/real-pipeline.mjs <wav>   # real Deepgram + Gemini
node packages/relay/scripts/local-stt-test.mjs local-parakeet-tdt-0.6b-v3 <16k-mono.wav> --stereo
                # local model through the worker; --stereo fakes a second source
```

The relay tests stand up a real `startRelay` on an ephemeral port and talk to it
over real WebSockets; the renderer and viewer tests run under happy-dom against
the real markup. Nothing mocks the relay or the translation state machine, and
it is worth keeping that way.

## Troubleshooting

- **They can't open the link** - on the same wifi, check Windows Firewall for
  the Node/Electron inbound rule on port 8787. On a different network the LAN
  link cannot reach them at all: `SETTINGS → WHO CAN OPEN IT → GET AN ADDRESS
  THAT WORKS ANYWHERE`, then send the new link.
- **Two people can't watch at once** - on the app's own relay only one device
  can, and the second kicks the first. Claim an address (above); the hosted
  relay has no such limit.
- **The OBS overlay went blank after a restart** - the default link mode mints
  a new link on every START, which kicks the browser source. `SETTINGS →
  VIEWER LINK → Fixed` keeps one link alive. The overlay deliberately shows
  nothing rather than painting THIS LINK HAS ENDED onto a broadcast.
- **No system audio option works** - loopback capture needs the Electron app
  running on Windows; it auto-approves the capture prompt. Loopback follows the
  *default* output device, so route the voice chat there (or to the device you
  also game on) if you want it captioned.
- **Local model won't start** - `02 TRANSCRIBE` says `NOT DOWNLOADED` until
  every file is on disk; a failed download shows `DOWNLOAD FAILED`, retry from
  `SETTINGS → LOCAL SPEECH MODELS`. The standalone relay server exe has no
  local engine - local models only work in the desktop app.
- **`replaced by another session`** - a second publisher (e.g. a second app
  instance) took over; only one publisher connection is allowed.
- **Kicked viewers** - someone opened the same link on another device, or the
  link was rotated. Send them the fresh link.

## The other docs

- `docs/GUIDE.md` - the user guide. Start there if you are setting this up for
  somebody rather than working on it.
- `CLAUDE.md` - architecture, commands, the release process, and the traps.
  Read it before debugging anything network-shaped.
- `docs/OPEN-WORK.md` - the consolidated backlog, including the known-open
  risk: the installer is unsigned, so the sha512 in `latest.yml` is the only
  integrity proof an update has.
- `ITERATION_LOG.md` - what was found and fixed, and how each fix was proved.
- `apps/hosted-relay/README.md` - the Worker, what it costs, and what it does
  not do.
- `DESIGN.md` - the UI spec the app and the phone page are built against. It
  predates the SETTINGS rework, so read it as intent.

## License

MIT - see `LICENSE`. The copyright holder is the project name rather than a
person, which is also what `apps/standalone` already carries as its `author`.

That covers the code in this repo and nothing else. Deepgram and Gemini are
reached with your own keys under their own terms; none of their software is
included here and none of it is relicensed by this file. The two fonts in
`packages/viewer/public/fonts/` - Archivo and Martian Mono, self-hosted from
Google Fonts - are redistributed under the SIL Open Font License, not this one.
That licence asks for its text and the copyright notices to travel with the
files, so they sit in `packages/viewer/public/fonts/OFL.txt`, which the Worker
serves at `/fonts/OFL.txt` and the build copies wherever it copies the fonts.

`packages/shared/test/license.test.ts` keeps this honest: the LICENSE file is
the fact, every `license` field is a statement about it, and they have to
agree. The landing page may say MIT only while that file does.

## Done when

Someone who cannot hear what is being said reads it on their phone, a few
hundred milliseconds later, without installing anything - and whoever is
talking never leaves what they were doing.
