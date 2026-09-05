# Callout Relay

Real-time translated comms for games. Capture your mic (or the game audio itself),
transcribe it with Deepgram, translate it with Gemini, and your friend reads the
subtitles on their phone or as a transparent OBS overlay — while you never leave
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
| `CalloutRelay-Portable-0.3.0.exe` | Portable single exe — run from anywhere, nothing installed |
| `callout-relay-server.exe` | Standalone relay server (for a VPS / second PC) |
| `latest.yml` | Update feed the installed app reads — keep it next to the installer |
| `SHA256SUMS.txt` | Checksums for the above |

The desktop apps embed the relay, the viewer page, and the control API — there
are no dev servers, no Node.js install, no terminal. Install (or run the
portable exe), paste your API keys once in Settings, and you're done.

### Build the executables yourself

```powershell
pnpm install
pnpm dist        # -> release/ (installer + portable + callout-relay-server.exe)
```

API keys — either put them in `.env` at the repo root (gitignored, dev only):

```
DEEPGRAM_API_KEY=...
GEMINI_API_KEY=...
```

or paste them into the desktop app once (KEYS in the app footer). Keys are
stored in `%APPDATA%\callout-relay\config.json` on Windows.

## Updates

The installed app checks for a new version 15 seconds after launch and every six
hours after that, downloads it in the background, and installs it on the next
restart — a live session is never interrupted. `KEYS → UPDATES` shows the running
version, the last check, a manual **CHECK**, and a switch to turn the background
checks off. When an update is staged, an amber chip appears in the footer and in
the tray menu; clicking it restarts into the new version.

The portable exe cannot replace itself, so it reports "portable build" and links
to the releases page instead.

**The feed has to be reachable.** Updates are served from this repo's GitHub
releases, which only works while the repo is public. If you keep it private,
either set `updateFeedUrl` in `KEYS → UPDATES` to any static directory holding
`latest.yml` plus the installer (your relay box will do), or the app will simply
report "no release feed found" and keep running.

## Releasing

Tagging is the whole release process — the `Release` workflow builds the
installers, the update feed and both relay-server binaries, then attaches them to
the GitHub release:

```powershell
pnpm version-bump 0.3.1
git commit -am "Release v0.3.1"
git tag -a v0.3.1 -m "v0.3.1"
git push origin master v0.3.1
```

The workflow refuses to build when the tag and `apps/standalone/package.json`
disagree, which is what `pnpm version-bump` keeps in step. `CI` runs a typecheck,
a build and a renderer element-id check on every push and pull request.

## Run

### Desktop app (the normal way)

Launch **Callout Relay** (Start Menu, desktop icon, or the portable exe).

The window is a caption console: the live transcript is the whole stage, and
every control sits in one signal-chain strip underneath it
(`01 SOURCE -> 02 TRANSCRIBE -> 03 TRANSLATE -> 04 OUTPUT`).

- **First run** walks you through three steps: a Deepgram key (required, checked
  as you paste), a Gemini key (optional — skip it for English-only captions), and
  your audio source plus where captions go.
- **01 SOURCE** picks `Default microphone` or `System audio (game + comms)`
  (system audio uses Windows loopback capture — no stereo mix fiddling). While
  live it turns into an input level meter.
- **03 TRANSLATE** holds the language pair and the on/off toggle. It starts
  **off** — a fresh install captions what it hears and nothing else. Add a Gemini
  key and switch it on to get a second column; with no key it greys out and the
  stage stays a single caption column.
- **04 OUTPUT** chooses Phone, OBS, or Both. OBS is served entirely from this PC
  and never needs a relay; phone links need one to leave your LAN.
- Hit **START SESSION**, then **COPY** the link in the footer and send it to your
  friend. `unique` link mode mints a fresh link per session; rotate any time with
  **NEW**.
- **KEYS** opens keys & relay settings, **LOG** shows the detailed session log
  with per-line latency. `Esc` returns to the stage.
- Closing the window hides to tray — capture keeps running mid-game. The tray
  menu can start/stop and rotate the link without opening the app.
- Settings changes (model / language / audio source) apply live: the session
  restarts but the viewer link survives.

The phone viewer, OBS overlay and Stream Deck property inspector share the same
design; `DESIGN.md` is the spec they are all built against.

### Relay standalone (VPS / remote friend)

Your relay is already deployed and running:

- **Host:** `187.124.87.202` (Hostinger, Ubuntu 24.04)
- **Service:** `systemctl status callout-relay` (auto-starts on boot, restarts on crash)
- **Install dir:** `/opt/callout-relay/` — binary + `.env` (keys) + `data/relay-state.json` (tokens)
- **Viewer link:** `http://187.124.87.202:8787/watch/<viewerToken>`
- **Logs:** `journalctl -u callout-relay -f`

The desktop app is already configured for it (`relayUrl: ws://187.124.87.202:8787`
in Settings → API keys & relay). Link mode is `fixed`, so the viewer link is
stable across sessions — rotate only when you want to kick everyone off.

To redeploy after a rebuild:

```powershell
pnpm dist:relay                                  # rebuild + re-inject SEA binaries
node scripts/vps.mjs put packages\relay\sea\callout-relay-server-linux /opt/callout-relay/callout-relay-server
node scripts/vps.mjs exec "systemctl restart callout-relay"
```

`scripts/vps.mjs` wraps SSH (exec/put) using the credentials in
`F:\Ai\_projects\_secrets\hostinger_vps.*`.

- Tokens persist in `%APPDATA%\callout-relay\relay-state.json` (or the platform
  equivalent — on the server: `relay-state.json` next to the exe if `%APPDATA%`
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
5. The key goes green **LIVE** whenever a session is running — regardless of
   whether it was started from the app, tray, or the key itself.

The plugin talks to the desktop app's local control API
(`127.0.0.1:47477`, loopback-only), so the app must be running (it lives in
the tray anyway).

## Viewer page

`http://<lan-ip>:8787/watch/<token>`

- Mobile-friendly dark UI with the last few callout lines.
- `?obs=1` — transparent background, only the latest subtitle pair, sized for
  OBS browser sources (add it as a Browser source, 1920x1080).
- The link is the token: whoever has it can watch. Rotate to kill old viewers.

## Config schema

```json
{
  "stt": "deepgram-nova-3",
  "translation": "gemini-2.5-flash",
  "audioSource": "default-mic",
  "languages": { "source": "en", "target": "vi" },
  "linkMode": "unique",
  "obsOverlay": false
}
```

Notes on models:
- `deepgram-nova-3` — fastest, best for English comms.
- `deepgram-nova-3-multi` — multilingual (en/es/fr/de/pt/it/...).
- `deepgram-nova-2` — widest language support (incl. Vietnamese STT).
- `gemini-2.5-flash-lite` if you want to shave ~200 ms off translation.

## Testing

```powershell
pnpm smoke      # full relay e2e without API keys (mock STT + mock Gemini)
node packages/relay/scripts/real-pipeline.mjs <wav>   # real Deepgram + Gemini
```

## Troubleshooting

- **Friend can't open the link** — same Wi-Fi? Check Windows Firewall for the
  Node/Electron inbound rule on port 8787. Different network → run the relay
  on a VPS or tunnel it.
- **No system audio option works** — loopback capture needs the Electron app
  running on Windows; it auto-approves the capture prompt.
- **`replaced by another session`** — a second publisher (e.g. a second app
  instance) took over; only one publisher connection is allowed.
- **Kicked viewers** — someone opened the same link on another device, or the
  link was rotated. Send them the fresh link.

## Done when

You and your friend run a real Valorant session, he reads Vietnamese on his
phone, and you never touch audio settings mid-game.
