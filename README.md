# Callout Relay

Real-time translated comms for games. Capture your mic, the game audio, or both
at once, transcribe it in the cloud (Deepgram) or on your own PC (local
sherpa-onnx models), translate it with Gemini, and your friend reads the
subtitles on their phone or as a transparent OBS overlay - while you never leave
the game.

```
 mic + system audio (PCM 16 kHz, 1 or 2 channels)
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
| `CalloutRelay-Setup-0.4.0.exe` | Windows installer (desktop + Start Menu shortcuts, updates itself) |
| `CalloutRelay-Portable-0.4.0.exe` | Portable single exe - run from anywhere, nothing installed |
| `callout-relay-server.exe` | Standalone relay server (for a VPS / second PC) |
| `latest.yml` | Update feed the installed app reads - keep it next to the installer |
| `SHA256SUMS.txt` | Checksums for the above |

The desktop apps embed the relay, the viewer page, the control API and the
local speech engine - there are no dev servers, no Node.js install, no terminal.
Install (or run the portable exe), pick cloud or local speech in the setup, and
you're done. The relay server exe is cloud-only (no local models).

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

- **First run** walks you through three steps: how Relay hears you (**Cloud**
  = a Deepgram key, checked as you paste; **Local** = pick a model and download
  it), a Gemini key (optional - skip it for English-only captions), and your
  audio source(s) plus where captions go. Run it again any time from
  `KEYS → RUN SETUP AGAIN` or the tray menu.
- **01 SOURCE** picks `Default microphone` or `System audio (game + comms)`
  (system audio uses Windows loopback capture - no stereo mix fiddling). The
  `+` row adds a **second source**: mic + system audio captions your own
  callouts *and* the voice chat, and every line is tagged `YOU` / `CHAT` (two
  mics: `A` / `B`). Each source is transcribed on its own channel - with
  Deepgram that is `multichannel=true` and both channels are billed. While live
  the block turns into an input level meter.
- **02 TRANSCRIBE** lists the cloud models and the local ones. Local models run
  on your CPU through sherpa-onnx, cost nothing, and never send audio anywhere;
  pick one and hit `DOWNLOAD` in the meta line (or manage them under
  `KEYS → LOCAL SPEECH MODELS`). Models live in
  `%APPDATA%\callout-relay\models\<model-id>\`.
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

## Config schema

```json
{
  "stt": "deepgram-nova-3",
  "translation": "gemini-3.1-flash-lite",
  "audioSource": "default-mic",
  "audioSource2": "system-loopback",
  "languages": { "source": "en", "target": "vi" },
  "translationEnabled": false,
  "linkMode": "unique",
  "output": "phone",
  "setupDone": true
}
```

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
| `local-parakeet-tdt-0.6b-v3` | NVIDIA Parakeet TDT 0.6B v3 - best accuracy, English + 24 European languages | 670 MB |
| `local-sense-voice` | SenseVoice Small - zh / en / ja / ko / yue | 240 MB |
| `local-whisper-small` | Whisper Small - ~100 languages incl. Vietnamese, slowest | 375 MB |

Streaming models decode as you speak; the others segment speech with silero
VAD (1 MB, fetched alongside) and decode each utterance, re-decoding the open
one every ~1.2 s for a partial. Everything runs in a worker thread so the relay
never stalls. Parakeet decodes a 6 s utterance in ~0.6 s on a desktop CPU.

## Testing

```powershell
pnpm smoke      # full relay e2e without API keys (mock STT + mock Gemini, 1 and 2 channels)
node packages/relay/scripts/real-pipeline.mjs <wav>   # real Deepgram + Gemini
node packages/relay/scripts/local-stt-test.mjs local-parakeet-tdt-0.6b-v3 <16k-mono.wav> --stereo
                # local model through the worker; --stereo fakes a second source
```

## Troubleshooting

- **Friend can't open the link** - same Wi-Fi? Check Windows Firewall for the
  Node/Electron inbound rule on port 8787. Different network → run the relay
  on a VPS or tunnel it.
- **No system audio option works** - loopback capture needs the Electron app
  running on Windows; it auto-approves the capture prompt. Loopback follows the
  *default* output device, so route the voice chat there (or to the device you
  also game on) if you want it captioned.
- **Local model won't start** - `02 TRANSCRIBE` says `NOT DOWNLOADED` until
  every file is on disk; a failed download shows `DOWNLOAD FAILED`, retry from
  `KEYS → LOCAL SPEECH MODELS`. The standalone relay server exe has no local
  engine - local models only work in the desktop app.
- **`replaced by another session`** - a second publisher (e.g. a second app
  instance) took over; only one publisher connection is allowed.
- **Kicked viewers** - someone opened the same link on another device, or the
  link was rotated. Send them the fresh link.

## Done when

You and your friend run a real Valorant session, they read Vietnamese on their
phone - your callouts tagged `YOU`, the voice chat tagged `CHAT` - and you never
touch audio settings mid-game.
