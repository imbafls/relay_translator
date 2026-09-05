# Multi-source capture + local STT + re-runnable setup - design

Date: 2026-09-05. Written and executed autonomously (Ralph loop); assumptions are
called out inline rather than asked.

## Goals

1. **Two audio sources at once.** Transcribe the mic *and* a second source
   (system loopback = game + voice chat, or a second input device) in one
   session, and label every caption with who it came from (`YOU` / `CHAT`).
2. **Local speech-to-text.** Run STT on this PC with no Deepgram key, using
   models downloaded into the app data dir. Cloud (Deepgram) stays the other
   option; the user picks one in setup and can switch any time in
   `02 TRANSCRIBE`.
3. **Setup can be re-run any time** (keys view button + tray item), and it
   knows about the cloud/local choice.

Non-goals: per-channel diarization inside a source, more than two sources,
GPU providers, local translation.

## Assumptions

- The Tokezly folder (`%APPDATA%\com.tokezly.app\models\parakeet-tdt-0.6b-v3-int8`)
  holds Parakeet in the *transcribe-rs* layout (`encoder-model`,
  `decoder_joint-model`, `nemo128.onnx`). sherpa-onnx needs the
  encoder/decoder/joiner split, so Relay downloads its own copy of the same
  model (int8, 670 MB) into `%APPDATA%\callout-relay\models\` instead of
  reusing those files.
- Local STT engine is **sherpa-onnx** (`sherpa-onnx-node`, N-API, prebuilt
  win-x64). Verified on this machine: loads inside an Electron 33
  `worker_threads` Worker, streaming zipformer decodes 6.6 s of audio in
  ~190 ms, silero VAD works. `enableExternalBuffer` must be `false` under
  Electron.
- Deepgram's streaming API supports `multichannel=true&channels=2`; results
  carry `channel_index: [i, n]`. Both channels bill separately.

## Architecture

```
renderer                                  relay (embedded, Electron main)
 mic ─┐  one AudioContext                 ┌─ deepgram.ts  (multichannel=true)
 sys ─┴─▶ merger ─▶ worklet ─▶ s16le ─────┤
          (2ch, 16 kHz, interleaved)      └─ localStt.ts ─▶ Worker(localSttWorker.js)
                                                            sherpa-onnx: VAD + offline
                                                            or online recognizer,
                                                            one stream per channel
```

### Shared types (`packages/shared`)

- `AppConfig.audioSource2?: string` - second source id; empty/undefined = off.
- `AppConfig.setupDone: boolean` - onboarding finished. Migration: an existing
  config with a Deepgram key counts as done.
- `STT_MODELS` becomes a catalogue with `provider: "deepgram" | "local"`. Local
  entries carry `kind: "streaming" | "offline"`, `sizeMb`, `languages`, and the
  file list (name + URL from the `csukuangfj/*` Hugging Face mirrors, so no
  tar.bz2 handling). Local ids are prefixed `local-`.
  - `local-zipformer-en-20m` - streaming, English, 44 MB, word-by-word partials.
  - `local-parakeet-tdt-0.6b-v3` - offline, English + 24 European languages,
    670 MB, best accuracy (the Tokezly model).
  - `local-sense-voice` - offline, zh/en/ja/ko/yue, 240 MB.
  - `local-whisper-small` - offline, ~100 languages incl. Vietnamese, 375 MB,
    slowest.
  - `LOCAL_VAD` - silero VAD, needed by every offline model.
- Wire: publisher `hello` gains `channels?: 1 | 2` and `channelLabels?: string[]`.
  `partial` / `subtitle` (viewer, publisher echo, uplink) gain
  `channel?: number` and `speaker?: string`. Binary frames are interleaved
  stereo when `channels = 2`.
- `LocalModelStatus { id, downloaded, sizeMb, progress?, error? }` on
  `ControlStatus.localModels`.
- `UsageInfo.local?: { sttMinutes }` - local minutes are free; Deepgram minutes
  count channels.

### Relay (`packages/relay`)

- `deepgram.ts`: `channels` param -> `multichannel=true&channels=2`; parse
  `channel_index[0]` into `onPartial(text, channel)` / `onFinal(text, {audioEndSec, channel})`.
- `localStt.ts` (new): `createLocalSttStream(cfg, events)` spawns the worker,
  forwards audio with transfer, maps worker messages to `SttEvents`. Fails
  fast with a readable error when `sherpa-onnx-node` or the worker file is
  missing (SEA server binary).
- `localSttWorker.ts` (new, separate bundle): loads sherpa-onnx lazily,
  de-interleaves, per channel either an `OnlineStream` with endpointing
  (streaming models) or silero VAD + `OfflineRecognizer` (offline models,
  with a periodic partial decode of the open segment every ~1.2 s).
- `session.ts`: per-channel pending segment ids so two interims never collide;
  `speaker` from `channelLabels`; provider chosen by the `local-` prefix.
- `server.ts`: `RelayOptions.localStt { modelsDir, workerPath }`; hello carries
  channels/labels; uplink forwards channel/speaker.
- Mock STT emits alternating channels so the smoke test covers the path.

### Companion (`packages/companion`)

- `BrowserAudioCapture.start(sources: string[], onPcm)` - 1 or 2 sources in one
  `AudioContext`; each source is downmixed to mono by an explicit-channel-count
  gain, merged, and the worklet emits interleaved `Int16Array` frames for N
  channels. `listDevices()` unchanged.

### Desktop app (`apps/standalone`)

- Main: `models:status`, `models:download(id)`, `models:delete(id)` IPC with
  progress events; downloads to `<dataDir>/models/<id>/<file>.part` then
  renames. Relay started with `localStt` paths. Tray gets **Run setup again**.
  Control status carries `localModels`.
- Renderer:
  - `01 SOURCE`: primary select + a second select (`OFF` or a device). While
    live the meter shows the louder channel.
  - `02 TRANSCRIBE`: optgroups CLOUD / LOCAL. Local meta: `ON THIS PC · FREE`
    plus `DOWNLOAD 670 MB` / `DOWNLOADING 43%` / `READY`.
  - Stage rows and log lines show a `YOU` / `CHAT` tag when two sources are on;
    interim rows are per channel.
  - Onboarding step 1 is a cloud/local choice: cloud = Deepgram key as today;
    local = model list with download buttons, CONTINUE when the chosen model
    is on disk. Step 3 adds the second source. `OPEN CONSOLE` sets
    `setupDone`. `SETUP` button in the keys view (and the tray item) reopens
    it at step 1 with current values; Esc returns to the stage when setup was
    already done.
  - Start guards: cloud needs a key, local needs the model downloaded.
- Build: worker bundled to `dist/localSttWorker.js` with `sherpa-onnx-node`
  external; `asarUnpack` for the sherpa packages.

### Viewer + Stream Deck

- Viewer: speaker tag before the source line; interim per channel; OBS overlay
  shows the tag on the latest row.
- PI: model select lists cloud models plus downloaded local ones (from
  `status.localModels`).

## Testing

- `pnpm smoke` extended: 2-channel hello + stereo silence -> subtitles carry
  `speaker` for both channels.
- `packages/relay/scripts/local-stt-test.mjs <model-id> <wav>`: real local
  decode through the worker.
- Deepgram multichannel checked once against the real API with a stereo file.
- `pnpm -r build && pnpm -r typecheck && node scripts/check-renderer-ids.mjs`.
- `electron-builder --dir` locally to confirm the unpacked sherpa DLLs ship.

## Release

Version 0.4.0. Tag -> Release workflow -> mirror installer + `latest.yml` to
the VPS updates dir -> redeploy the VPS relay binary (it must forward the new
`speaker` field). README, DESIGN.md addendum, spec committed.
