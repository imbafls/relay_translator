# Callout Relay

Real-time translated comms for games. Capture your mic (or the game audio itself),
transcribe it with Deepgram, translate it with Gemini, and your friend reads the
subtitles on their phone or as a transparent OBS overlay - while you never leave
the game.

```
 mic / game audio (PCM 16 kHz)
        │  WebSocket (token-authed)
        ▼
┌───────────────────┐      ┌──────────────────────────────┐
│  relay server     │      │  viewer page (phone / OBS)   │
│  Deepgram nova-3  │─────▶│  dual subtitles:             │
│  Gemini 2.5 Flash │  WS  │    EN callout (dim)          │
└───────────────────┘      │    VI translation (big)      │
        ▲                  └──────────────────────────────┘
        │
┌───────┴───────────┐
│  companion        │◀──── Stream Deck plugin (toggle key + PI wizard)
│  (standalone app) │      local control API on 127.0.0.1:47477
└───────────────────┘
```

## Repo layout

```
apps/standalone/     Electron app: settings UI, audio picker, copy-link, tray
apps/streamdeck/     @elgato/streamdeck plugin: toggle key + 3-step PI wizard
packages/companion/  shared capture + relay client + local control API
packages/relay/      Node server: audio in -> Deepgram -> Gemini -> WS out
packages/viewer/     phone page, token-gated, OBS transparent mode
packages/shared/     types, config schema, wire protocol
```

## Latency budget

| Stage | Target |
| --- | --- |
| Deepgram streaming (endpointing 300 ms) | ~300 ms |
| Gemini 2.5 Flash (thinkingBudget 0) | ~400–900 ms |
| Network + render | ~300 ms |
| **Total (utterance end -> subtitle)** | **< 1.5 s** |

Source text is broadcast the instant Deepgram finalizes; the translation
patches the same segment id when Gemini returns.

## Setup

### Ready-made executables (no toolchain needed)

Prebuilt installers live in `release/`:

| File | What it is |
| --- | --- |
| `CalloutRelay-Setup-0.3.0.exe` | Windows installer (desktop + Start Menu shortcuts, updates itself) |
| `CalloutRelay-Portable-0.3.0.exe` | Portable single exe - run from anywhere, nothing installed |
| `callout-relay-server.exe` | Standalone relay server (for a VPS / second PC) |
| `latest.yml` | Update feed the installed app reads - keep it next to the installer |
| `SHA256SUMS.txt` | Checksums for the above |

The desktop apps embed the relay, the viewer page, and the control API - there
are no dev servers, no Node.js install, no terminal. Install (or run the
portable exe), paste your API keys once in Settings, and you're done.

### Build the executables yourself

```powershell
pnpm install
pnpm dist        # -> release/ (installer + portable + callout-relay-server.exe)
```

API keys - either put them in `.env` at the repo root (gitignored, dev only):

```
DEEPGRAM_API_KEY=...
GEMINI_API_KEY=...
```

or paste them into the desktop app once (KEYS in the app footer). Keys are
stored in `%APPDATA%\callout-relay\config.json` on Windows.

## Updates

The installed app checks for a new version 15 seconds after launch and every six
hours after that, downloads it in the background, and installs it on the next
restart - a live session is never interrupted. `KEYS → UPDATES` shows the running
version, the last check, a manual **CHECK**, and a switch to turn the background
checks off. When an update is staged, an amber chip appears in the footer and in
the tray menu; clicking it restarts into the new version.

The portable exe cannot replace itself, so it reports "portable build" and links
to the releases page instead.

By default the app reads the GitHub release for each tag. **That only works
once the repo is public** - GitHub answers 404 on a private release feed, and
the app reports "no release feed found" and offers the releases page instead.

While it is private, or to host builds yourself, set `updateFeedUrl` in
`KEYS → UPDATES` to any static directory serving `latest.yml` next to the
installer. The relay can be that directory: it serves `<dataDir>/updates` at
`/updates/`, and `/download` redirects to whatever `latest.yml` names, which
gives you one stable link to hand out.

```
updateFeedUrl   https://relay.supr.systems/updates
download link   https://relay.supr.systems/download
```

To publish a build there, copy the installer, its `.blockmap` and `latest.yml`
from the GitHub release into `/opt/callout-relay/data/updates/` on the box.
Upload `latest.yml` last - it is what tells installed apps a new version exists.
Nothing needs restarting.

## Releasing

Tagging is the whole release process - the `Release` workflow builds the
installers, the update feed and both relay-server binaries, then attaches them to
the GitHub release:

```powershell
pnpm version-bump 0.3.1
git commit -am "Release v0.3.1"
git tag -a v0.3.1 -m "v0.3.1"
git push origin master v0.3.1
```

The workflow refuses to build when the tag and `apps/standalone/package.json`
disagree, which is what `pnpm version-bump` keeps in step. `CI` runs a build, a
typecheck and a renderer element-id check on every push and pull request.

Once the repo is public that is the whole release. If you are mirroring builds
to a relay box (see Updates), copy them across afterwards:

```powershell
gh release download v0.3.2 -p "CalloutRelay-Setup-*.exe" -p "*.blockmap" -p latest.yml -D out
node scripts/vps.mjs put out\CalloutRelay-Setup-0.3.2.exe /opt/callout-relay/data/updates/CalloutRelay-Setup-0.3.2.exe
node scripts/vps.mjs put out\CalloutRelay-Setup-0.3.2.exe.blockmap /opt/callout-relay/data/updates/CalloutRelay-Setup-0.3.2.exe.blockmap
node scripts/vps.mjs put out\latest.yml /opt/callout-relay/data/updates/latest.yml
```

## Run

### Desktop app (the normal way)

Launch **Callout Relay** (Start Menu, desktop icon, or the portable exe).

The window is a caption console: the live transcript is the whole stage, and
every control sits in one signal-chain strip underneath it
(`01 SOURCE -> 02 TRANSCRIBE -> 03 TRANSLATE -> 04 OUTPUT`).

- **First run** walks you through three steps: how Relay hears you (a Deepgram
  key checked as you paste, or a local model downloaded onto this PC), a Gemini
  key (optional - skip it for English-only captions), and your audio sources
  plus where captions go. `KEYS → RUN SETUP AGAIN` (or the tray menu) reopens
  it any time; `✕ BACK TO CONSOLE` abandons a re-run.
- **01 SOURCE** picks `Default microphone` or `System audio (game + comms)`
  (system audio uses Windows loopback capture - no stereo mix fiddling).
  `+ ADD` mixes in more sources - your mic plus the voice chat, or two mics -
  into the same captions. While live it turns into an input level meter.
- **02 TRANSCRIBE** switches between `CLOUD` (Deepgram, needs a key) and
  `LOCAL` (a model running on this PC, no key, no bill). Local models are
  grouped LIGHT / MEDIUM / HEAVY; setup recommends a tier from your CPU thread
  count and RAM, and every model shows approximate speed and accuracy dots plus
  its download size. The meta line offers `DOWNLOAD` until the model is on disk.
- **03 TRANSLATE** holds the language pair and the on/off toggle. It starts
  **off** - a fresh install captions what it hears and nothing else. Add a Gemini
  key and switch it on to get a second column; with no key it greys out and the
  stage stays a single caption column.
- **04 OUTPUT** chooses Phone, OBS, or Both. OBS is served entirely from this PC
  and never needs a relay; phone links need one to leave your LAN.
- Hit **START SESSION**, then **COPY** the link in the footer and send it to your
  friend. `unique` link mode mints a fresh link per session; rotate any time with
  **NEW**.
- **KEYS** opens keys & relay settings, **LOG** shows the detailed session log
  with per-line latency. `Esc` returns to the stage.
- Closing the window hides to tray - capture keeps running mid-game. The tray
  menu can start/stop and rotate the link without opening the app.
- Settings changes (model / language / audio source) apply live: the session
  restarts but the viewer link survives.

The phone viewer, OBS overlay and Stream Deck property inspector share the same
design; `DESIGN.md` is the spec they are all built against.

### Relay standalone (VPS / remote friend)

Your relay is already deployed and running:

- **Public name:** `relay.supr.systems` (TLS via the Traefik already on the box)
- **Host:** `187.124.87.202` (Hostinger, Ubuntu 24.04)
- **Service:** `systemctl status callout-relay` (auto-starts on boot, restarts on crash)
- **Install dir:** `/opt/callout-relay/` - binary + `.env` (keys) + `data/relay-state.json` (tokens)
- **Viewer link:** `https://relay.supr.systems/watch/<viewerToken>`
- **Logs:** `journalctl -u callout-relay -f`

Set `relayUrl` to `wss://relay.supr.systems` in `KEYS`; the phone link derives its
`https://` base from it, so nothing else needs configuring. Link mode is `fixed`,
so the viewer link is stable across sessions - rotate only when you want to kick
everyone off.

**How the TLS is wired.** Traefik terminates on 443 and forwards to the relay on
`127.0.0.1:8787`, including WebSocket upgrades. The route is a file-provider
rule in `/docker/traefik/dynamic/relay.yml`; Traefik watches that directory, so
editing it needs no restart. Port 8787 is still open directly for plain HTTP,
which is what makes a LAN fallback work.

To redeploy after a rebuild:

```powershell
pnpm dist:relay                                  # rebuild + re-inject SEA binaries
node scripts/vps.mjs put packages\relay\sea\callout-relay-server-linux /opt/callout-relay/callout-relay-server
node scripts/vps.mjs exec "systemctl restart callout-relay"
```

`scripts/vps.mjs` wraps SSH (exec/put) using the credentials in
`F:\Ai\_projects\_secrets\hostinger_vps.*`.

- Tokens persist in `%APPDATA%\callout-relay\relay-state.json` (or the platform
  equivalent - on the server: `relay-state.json` next to the exe if `%APPDATA%`
  is missing), so the viewer link is stable across restarts.
- For a hosted relay, set `DEEPGRAM_API_KEY` + `GEMINI_API_KEY` and
  `RELAY_PUBLISHER_TOKEN` / `RELAY_VIEWER_TOKEN` in the environment, open
  `RELAY_PORT` (default 8787), then point the desktop app at it via
  **Relay URL** (`ws://your-server:8787`) and paste the matching tokens into
  the app settings. `Public base URL` is for tunnels (`ngrok`/`cloudflared`).
- Rotate the viewer link remotely:
  `POST /admin/rotate-viewer-token` with `Authorization: Bearer <publisher token>`.

### Stream Deck plugin

1. `pnpm build:sd`
2. Copy `apps/streamdeck/com.callout-relay.sdPlugin/` into
   `%appdata%\Elgato\StreamDeck\Plugins\`
3. Restart Stream Deck. Drop **Callout Relay → Toggle Relay** on a key.
4. The property inspector is the 3-step wizard: **Model → Audio → Link**
   (copy / rotate the viewer link right from the PI).
5. The key goes green **LIVE** whenever a session is running - regardless of
   whether it was started from the app, tray, or the key itself.

The plugin talks to the desktop app's local control API
(`127.0.0.1:47477`, loopback-only), so the app must be running (it lives in
the tray anyway).

## Viewer page

`http://<lan-ip>:8787/watch/<token>`

- Mobile-friendly dark UI with the last few callout lines.
- `?obs=1` - transparent background, only the latest subtitle pair, sized for
  OBS browser sources (add it as a Browser source, 1920x1080).
- The link is the token: whoever has it can watch. Rotate to kill old viewers.

## Local speech-to-text

`02 TRANSCRIBE → LOCAL` runs the model on your PC through
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (CPU only, no key, no
bill). Models are fetched from the sherpa-onnx `asr-models` GitHub release
into `%APPDATA%\callout-relay\models` (change the folder under
`KEYS → LOCAL MODELS`; a folder that already holds sherpa-onnx model
directories is picked up as-is).

| Tier | Model | Mode | Size | Languages |
| --- | --- | --- | --- | --- |
| LIGHT | Zipformer 20M | streaming | 121 MB | en |
| LIGHT | Moonshine tiny | phrase | 102 MB | en |
| LIGHT | Whisper tiny.en | phrase | 112 MB | en |
| MEDIUM | Zipformer EN | streaming | 296 MB | en |
| MEDIUM | Moonshine base | phrase | 239 MB | en |
| MEDIUM | Whisper base.en | phrase | 198 MB | en |
| MEDIUM | SenseVoice | phrase | 158 MB | zh en ja ko yue |
| HEAVY | Parakeet TDT 0.6B v2 | phrase | 460 MB | en |
| HEAVY | Parakeet TDT 0.6B v3 | phrase | 464 MB | 25 European |
| HEAVY | Nemotron 3.5 streaming | streaming | 453 MB | 25 European |
| HEAVY | Whisper large-v3 turbo | phrase | 537 MB | multilingual |

*Streaming* models show words as you speak, like Deepgram. *Phrase* models
wait for a pause (Silero VAD), then caption the whole phrase; light phrase
models also show interim text while you talk. Setup recommends HEAVY for 12+
threads and 16 GB, MEDIUM for 6+ threads and 8 GB, LIGHT otherwise - a game
is usually running on the same CPU. Inference runs in a worker thread inside
the desktop app; the VPS relay never transcribes (it only mirrors finished
subtitles), so local STT needs no server-side change.

## Config schema

```json
{
  "sttEngine": "cloud",
  "stt": "deepgram-nova-3",
  "localStt": "local-zipformer-en-20m",
  "translation": "gemini-2.5-flash",
  "audioSources": ["default-mic", "system-loopback"],
  "languages": { "source": "en", "target": "vi" },
  "linkMode": "unique",
  "setupComplete": true
}
```

`audioSource` (single) is still written - it mirrors `audioSources[0]` for
the Stream Deck inspector and older configs.

Notes on models:
- `deepgram-nova-3` - fastest, best for English comms.
- `deepgram-nova-3-multi` - multilingual (en/es/fr/de/pt/it/...).
- `deepgram-nova-2` - widest language support (incl. Vietnamese STT).
- `gemini-2.5-flash-lite` if you want to shave ~200 ms off translation.
- `local-*` ids are the local catalog above (`LOCAL_STT_MODELS` in `packages/shared`).

## Testing

```powershell
pnpm smoke      # full relay e2e without API keys (mock STT + mock Gemini)
node packages/relay/scripts/real-pipeline.mjs <wav>   # real Deepgram + Gemini
node packages/relay/scripts/local-stt-test.mjs local-moonshine-tiny <16k-mono.wav>   # local engine
```

Set `CALLOUT_LOCAL_STT_MODEL_DIR` (and optionally `CALLOUT_LOCAL_STT_MODEL`,
`CALLOUT_LOCAL_STT_WAV`) to make `pnpm smoke` also push audio through a real
local model; without it that case is skipped, so CI stays model-free.

## Troubleshooting

- **Friend can't open the link** - same Wi-Fi? Check Windows Firewall for the
  Node/Electron inbound rule on port 8787. Different network → run the relay
  on a VPS or tunnel it.
- **No system audio option works** - loopback capture needs the Electron app
  running on Windows; it auto-approves the capture prompt.
- **`ENGINE UNAVAILABLE` under 02 TRANSCRIBE** - the sherpa-onnx addon did not
  load (`KEYS → LOCAL MODELS` shows why). Switch to CLOUD, or reinstall; the
  portable exe and the installer both ship the Windows x64 binaries.
- **Local captions lag** - pick a lighter tier, or a *streaming* model; heavy
  phrase models decode a whole phrase after you stop talking.
- **`replaced by another session`** - a second publisher (e.g. a second app
  instance) took over; only one publisher connection is allowed.
- **Kicked viewers** - someone opened the same link on another device, or the
  link was rotated. Send them the fresh link.

## Done when

You and your friend run a real Valorant session, he reads Vietnamese on his
phone, and you never touch audio settings mid-game.
