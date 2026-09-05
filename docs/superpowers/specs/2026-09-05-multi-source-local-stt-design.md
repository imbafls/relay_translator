# Multi-source capture, local STT, and re-runnable setup - design

Status: implemented in 0.4.0. Written autonomously (Ralph loop) - the routine
calls below were made without a design review; each one is flagged where an
alternative was plausible.

## Goals

1. **Several audio sources at once.** Caption the mic *and* the game / voice
   chat (system loopback), or two mics, in one session.
2. **Local speech-to-text.** Run STT on this PC with no Deepgram key, from a
   catalog of downloadable models grouped into LIGHT / MEDIUM / HEAVY tiers,
   with a recommendation derived from the machine's CPU and RAM. Cloud
   (Deepgram) stays the default; the user picks during setup and can switch
   any time from the console.
3. **Re-run setup.** Onboarding can be reopened from KEYS or the tray at any
   time, and it can be cancelled when re-run.
4. Ship as a tagged release (0.4.0).

Non-goals: GPU inference, speaker-labelled captions per source, local
translation (Gemini stays cloud-only), running local STT on the VPS relay.

## 1. Multiple sources

**Decision: mix, don't multiplex.** All chosen sources are opened as separate
`MediaStream`s and summed into the one existing 16 kHz mono PCM worklet, so the
relay, the wire protocol and every STT engine see exactly what they see today.

Rejected alternative: Deepgram `multichannel=true` with one channel per source.
It would tag each caption with its source, but doubles STT cost, does not exist
for local models, and the viewer has no design for per-speaker rows. Mixing is
what a Discord call already sounds like to the listener.

- `AppConfig.audioSources: string[]` (default `["default-mic"]`). The legacy
  `audioSource` stays as the *primary* entry and is kept in sync, so the
  Stream Deck inspector and old configs keep working. A patch that carries
  only `audioSource` becomes `audioSources[0]`.
- `BrowserAudioCapture.start(sources, onPcm)` opens each source (mic /
  loopback / device id), connects every `MediaStreamSource` to the same
  worklet input (Web Audio sums fan-in), and clips in the worklet as before.
  Duplicate ids are dropped; a source that fails to open fails the session
  with a message naming it.
- Console 01 SOURCE: the primary select as today, plus one select row per
  extra source with a `✕`, and a `+ ADD` link in the meta row (hidden while
  live or when every device is already used). Meta shows `MIC + SYSTEM`.
- Onboarding step 3: primary select plus an optional "ALSO LISTEN TO" select
  (`None` by default).

## 2. Local STT

### Engine

**Decision: sherpa-onnx (`sherpa-onnx-node` 1.13.7).** One native addon with
prebuilt Windows / macOS / Linux binaries, CPU-only, that runs both true
streaming transducers (live words, Deepgram-like endpointing) and offline
models (Whisper, Moonshine, Parakeet, SenseVoice) behind a Silero VAD. Verified
in this container: streaming zipformer decodes 6.6 s of audio in 161 ms;
Moonshine tiny decodes a 6 s phrase in 186 ms; the addon loads inside a
`worker_thread`.

Rejected: whisper.cpp bindings (needs a native build per Electron version),
transformers.js (no streaming, slower), Vosk (ffi-napi is broken on Node 22).

### Where it runs

The desktop app already runs STT in its embedded relay and mirrors finished
subtitles to the VPS over the uplink, so local STT slots in at exactly the
point Deepgram does: `PublisherSession.start()` picks the engine from the
model id (`local-*` → local, else Deepgram). No wire-protocol change.

Inference runs in a **worker thread** (`packages/relay/src/localStt/worker.ts`)
so a 0.5-1 s Parakeet decode never stalls Electron's main loop (IPC, tray,
control API). Audio goes in as transferred `Int16Array` buffers; partial /
final / error events come back. The worker file is found next to the relay
bundle (`localStt/worker.js` for the tsc build, `localStt-worker.js` for the
esbuild bundle); the addon is loaded with a plain `require` so the relay
package builds and the SEA server binary still runs without it (local STT is
simply "unavailable" there).

Two stream shapes, both implementing the existing `SttStream`:

- **Streaming** (`OnlineRecognizer`, zipformer / Nemotron transducers):
  feed samples, decode while ready, emit a partial whenever the text changes,
  emit a final and reset on `isEndpoint`. Endpoint rules: 2.0 s trailing
  silence after any text, 0.8 s after a decoded phrase, 15 s max utterance.
  `audioEndSec` for the latency badge is the audio position at the endpoint.
- **Phrase** (`OfflineRecognizer` + Silero VAD): the VAD cuts speech
  segments (0.25 s min speech, 0.5 s min silence, 8 s max); each segment is
  decoded once and emitted as a final. While a segment is open, the buffered
  audio is decoded again at most once per second (and only if the last decode
  took under 400 ms) to give interim text - so light models feel live and
  heavy models simply wait for the phrase.

Output is normalised for captions: trimmed, first letter upper-cased, all-caps
transducer output lower-cased.

### Model catalog and tiers

`LOCAL_STT_MODELS` in `packages/shared` is the single source of truth: id,
label, tier, mode (`streaming` | `phrase`), kind (which sherpa config to
build), archive name, size, languages, 1-5 ratings for speed and accuracy, and
a one-line note. Every archive below was checked to exist on the sherpa-onnx
`asr-models` GitHub release.

| Tier | Model | Mode | Size | Langs | Speed | Accuracy |
| --- | --- | --- | --- | --- | --- | --- |
| LIGHT | Zipformer 20M (streaming) | streaming | 121 MB | en | 5 | 2 |
| LIGHT | Moonshine tiny | phrase | 102 MB | en | 5 | 3 |
| LIGHT | Whisper tiny.en | phrase | 112 MB | en | 3 | 2 |
| MEDIUM | Zipformer EN (streaming) | streaming | 296 MB | en | 4 | 3 |
| MEDIUM | Moonshine base | phrase | 239 MB | en | 4 | 4 |
| MEDIUM | Whisper base.en | phrase | 198 MB | en | 2 | 3 |
| MEDIUM | SenseVoice | phrase | 158 MB | zh en ja ko yue | 4 | 4 |
| HEAVY | Parakeet TDT 0.6B v2 | phrase | 460 MB | en | 3 | 5 |
| HEAVY | Parakeet TDT 0.6B v3 | phrase | 464 MB | 25 European | 3 | 5 |
| HEAVY | Nemotron 3.5 streaming 0.6B | streaming | 453 MB | 25 European | 2 | 5 |
| HEAVY | Whisper turbo | phrase | 537 MB | multilingual | 1 | 5 |

Ratings are editorial (public WER tables: Moonshine paper, Open ASR
leaderboard) and are labelled "approximate" in the UI. Whisper is rated slow
because sherpa-onnx pads every phrase to Whisper's 30 s window.

Files inside each archive are located by kind (encoder / decoder / joiner,
`preprocess` + `encode` + cached / uncached decoders, `*-encoder.int8.onnx`,
`model.int8.onnx`), preferring int8 weights except for the transducer decoder,
so the catalog does not have to know exact file names.

### Model manager

`packages/relay/src/localStt/models.ts` (Node, used by the Electron main
process and exposed to the renderer over IPC):

- `modelsDir` = `AppConfig.modelsDir` or `<dataDir>/models`. The user can
  point it at a folder they already have (for example an existing dev folder
  of sherpa-onnx models): any sub-folder named after a catalog archive, or
  after a model id, counts as that model.
- `statuses()` → per model: `missing` | `downloading {percent, bytes}` |
  `unpacking` | `ready` | `error {detail}`.
- `download(id)` streams the tar.bz2 from GitHub through `unbzip2-stream` +
  `tar` straight into `<modelsDir>/<id>/` (first path component stripped),
  reporting progress from `Content-Length`. Phrase models also fetch
  `silero_vad.onnx` once into the models dir. A failed or cancelled download
  removes the partial folder. One download at a time.
- `remove(id)` deletes the folder.

### Hardware recommendation

`hardware:info` (main process) reports logical CPU threads, CPU model, total
RAM and, when known, the fastest core clock. Tier rule:

- HEAVY: ≥ 12 threads and ≥ 16 GB
- MEDIUM: ≥ 6 threads and ≥ 8 GB
- LIGHT: everything else

Onboarding shows `YOUR PC · 16 THREADS · 32 GB → HEAVY RECOMMENDED` and
pre-selects that tier; the user can pick any tier. The rule is deliberately
conservative: a game is running on the same CPU.

### Config and status

- `sttEngine: "cloud" | "local"` (default cloud), `stt` (cloud model id,
  unchanged), `localStt` (local model id, default `local-zipformer-en-20m`),
  `modelsDir?`. The id sent in the publisher `hello` is whichever the engine
  selects, so old relays that only know Deepgram ids are unaffected until they
  see a `local-` id, which the desktop app never sends to the VPS (the VPS
  only receives finished subtitles).
- `ControlStatus` gains `localStt: { available: boolean; detail?: string;
  models: ModelStatus[] }` and `hardware`. `UsageInfo` gains
  `local.sttMinutes`; Deepgram minutes only count cloud sessions.
- Session start checks: cloud needs a Deepgram key, local needs the chosen
  model `ready` and the engine `available`; otherwise the start fails with a
  message pointing at the fix.

### Console

02 TRANSCRIBE gets a `CLOUD | LOCAL` mini-segment in its label row. The model
select lists Deepgram models or the local catalog (grouped by tier). Meta:
`EN · STREAMING · READY`, `EN · 121 MB · DOWNLOAD` (link), `DOWNLOADING 43%`,
`UNPACKING…`, or `ENGINE UNAVAILABLE` in amber. Live meta: `4.2 MIN · $0.000
· LOCAL`. KEYS gets a LOCAL MODELS field: models folder path, OPEN FOLDER.

## 3. Onboarding

Step 1 SPEECH becomes an engine choice: `CLOUD · DEEPGRAM` (the current key
step) or `LOCAL · THIS PC`. The local pane shows the hardware line, the
LIGHT / MEDIUM / HEAVY segment with a one-line description of each tier, and
the models of that tier as selectable rows (name, STREAMING/PHRASE tag,
languages, size, speed and accuracy dots, note). The selected row carries the
DOWNLOAD button, progress, or READY. CONTINUE is enabled when a valid Deepgram
key is present (cloud) or the selected model is ready (local).

Step 3 adds the optional second source.

**Re-run:** `AppConfig.setupComplete` (default false; migrated to true for
configs that already hold a Deepgram key). Boot opens onboarding while it is
false. `RUN SETUP AGAIN` (KEYS footer) and the tray entry "Run setup…" stop a
live session and open onboarding; when setup is re-run, the left pane shows
`✕ BACK TO CONSOLE` so it can be abandoned. OPEN CONSOLE sets
`setupComplete: true`.

## Packaging

- `sherpa-onnx-node` is a dependency of `@callout-relay/relay` and of the
  desktop app; esbuild marks it (and the per-platform packages) external, and
  electron-builder unpacks `node_modules/sherpa-onnx-*` from the asar so the
  `.node` and its DLLs load. Only the Windows x64 package matters for the
  shipped installer.
- `tar` and `unbzip2-stream` are pure JS and get bundled.
- The SEA relay server bundle also marks the addon external; the server logs
  "local STT unavailable" and keeps serving.

## Testing

- `pnpm smoke` gains a local-engine path that runs only when a model folder
  is present (`CALLOUT_LOCAL_STT_MODEL_DIR`), so CI stays key- and
  model-free.
- `node packages/relay/scripts/local-stt-test.mjs <model-id> <wav>` decodes a
  wave file through the same worker the app uses (used here to validate the
  zipformer, Moonshine, Parakeet, Nemotron and Whisper paths).
- Renderer element-id check and typecheck as before.
