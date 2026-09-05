# Iteration Log

Autonomous hardening loop over the relay pipeline. One domain per turn: write
tests for edge cases nobody covered, fix what they expose, and ship the feature
the failure argues for.

Working branch: `ralph/pipeline-hardening`, cut from `master` at the `v0.5.2`
release commit so loop work stays out of the release.

Verification per turn: `pnpm test`, `pnpm typecheck:test`, `pnpm typecheck`,
`pnpm build`, `node scripts/check-renderer-ids.mjs`, `pnpm smoke`.

---

### Turn 1/100 - Resilience & state (local STT preparation window)

- **Tests Added**: First test runner in the repo (vitest 5, `pnpm test`), plus
  `packages/relay/test/localStt.test.ts` with 6 tests driving the real
  `createLocalSttStream` state machine - its probe child process, worker thread,
  pending-audio queue and close handshake all run for real, with only the
  sherpa-onnx engine stood in for by a worker script speaking the same message
  contract. Covers: catalogue misses, the VAD requirement splitting offline from
  streaming models, a model that aborts its probe, audio spoken during
  preparation, and buffer overflow.
- **Issue/Gap Uncovered**: The pending-audio queue in `localStt.ts` was capped at
  300 frames. The capture worklet emits 100 ms frames, so that is 30 seconds -
  and since the crash guard landed in `0ae312f`, that window has to cover *two*
  sequential loads of the same model (the probe child, then the worker) where it
  previously covered one. Everything past 30 s was discarded with no signal to
  the user or the log; the comment above it still read "a few seconds at most".
  The test failed exactly as predicted: `expected 300 to be 400`, 10 seconds of
  speech gone.
- **Enhancement Shipped**: The queue now budgets by audio duration instead of
  frame count, sized to `PROBE_TIMEOUT_MS` so nothing spoken during a legitimate
  probe is lost, and overflow past that budget is reported through `onError`
  ("the model took so long to start that Ns of speech was dropped") rather than
  swallowed. `onError` logs and notifies without tearing down the session, so the
  report is safe on that path.
- **Status**: PASSED

---

### Turn 2/100 - Translation pipeline & relay logic (shutdown race)

- **Tests Added**: `packages/relay/test/session.test.ts`, 5 tests driving the real
  `PublisherSession` - its segment ids, its final-then-patch broadcast order and
  its stop path all genuine, with STT through the session's own `mockStt` seam
  and Gemini behind a translator whose latency the test controls. Added a
  `translator` seam to `SessionDeps` alongside the existing `mockStt`/`mockGemini`
  ones to make that possible.
- **Issue/Gap Uncovered**: Two things, one of which turned out to be a non-issue
  worth recording. The ordering tests **pass**: the source subtitle is broadcast
  synchronously and the translation patches the same segment id, so a slow
  translation updates its row in place and cannot reorder captions. But
  `inflight` was a dead counter - incremented and decremented, never read - and
  the server's `close()` called `dropPublisher()` and then immediately closed
  every viewer socket. The last utterance finals late, so its translation was
  still running at that point and resolved into viewers that were already gone.
  Say one more line, hit stop, and that line never gets translated for anyone.
- **Enhancement Shipped**: `PublisherSession.drain(timeoutMs)` waits for the
  translations that were in flight at stop and resolves with the number still
  outstanding, so a wedged translator cannot hold a shutdown open. The relay's
  `close()` now awaits it before tearing down viewer sockets. `inflight` finally
  has a reader.
- **Status**: PASSED

---

### Turn 3/100 - Stream & audio transport (the audio clock across a mute)

- **Tests Added**: `packages/companion/test/workletSource.test.ts`, 8 tests over
  the capture resampler. The worklet ships as a source string the browser
  evaluates, so the tests evaluate that exact string with the three globals it
  expects - the resampler under test is the one that ships, not a
  reimplementation. Covers output rate at 48 kHz, 44.1 kHz (non-integer ratio),
  16 kHz and 8 kHz, the 100 ms frame size the relay's buffering depends on,
  two-channel interleaving without bleed, and mute. Plus one test in
  `session.test.ts` for what mute does downstream.
- **Issue/Gap Uncovered**: The resampler is sound - rate holds with no
  cumulative drift at every ratio tested, frames are exactly 100 ms, channels
  stay separate. What the mute test exposed is downstream. Muting emits *nothing*
  rather than silence, so it puts a hole in the stream, and latency is computed
  as `finalAt - streamWallStart - audioEndSec`: wall time counts the mute, the
  STT audio clock cannot. Every latency badge after a mute reads that much too
  high, cumulatively, for the rest of the session. Confirmed by reverting the
  fix: a 30 s mute gave `expected 29900 to be less than 500`. It was invisible
  until now partly because the mock STT never reported `audioEndSec`, the one
  field the real engines always send.
- **Enhancement Shipped**: The session tracks time when no audio arrived at all
  and subtracts it, so the badge measures pipeline latency rather than how long
  the mic was off. Threshold is five missed 100 ms frames, which is a stall
  rather than delivery jitter. The mock STT now reports `audioEndSec` like the
  real engines, so timing bugs cannot hide behind it again.
- **Status**: PASSED
