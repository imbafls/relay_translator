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

---

### Turn 4/100 - Message orchestration (a bad hello takes the relay down)

- **Tests Added**: `packages/relay/test/server.test.ts`, 7 tests booting the real
  relay on a real port and talking to it over real sockets. Five malformed
  publisher hellos, plus two that confirm a good hello is still accepted -
  asserted through the viewer language broadcast, which is the observable proof
  that `buildSession` ran.
- **Issue/Gap Uncovered**: All three `JSON.parse` sites are guarded, so malformed
  *JSON* was already handled. Malformed *shape* was not. The publisher handler's
  try/catch covers only the parse, then dereferences `msg.languages.source`
  outside any guard. A publisher that is past the token check - an old build, a
  half-written client, anyone holding the token - sending `{"type":"hello"}`
  throws a TypeError inside a `ws.on("message")` handler, and there is no
  `uncaughtException` handler anywhere in the codebase, so that is the relay
  process dying and taking every viewer with it. Reverting the fix showed a
  second vector I had not spotted: a hello with no `stt` reaches
  `isLocalStt(undefined)` and dies on `.startsWith`. Vitest reported both as
  Unhandled Errors.
- **Enhancement Shipped**: A `publisherHello` validator that treats the payload
  as untrusted even though the token checked out. It requires
  `languages.source` and `languages.target` as strings, fills `stt`,
  `translation`, `channels` and `channelLabels` from defaults when they are
  missing or the wrong type, and rejects with an error message to the publisher
  rather than throwing. The relay now survives all five malformed shapes and
  keeps serving.
- **Status**: PASSED

---

### Turn 5/100 - Client UI and catalogue invariants

- **Tests Added**: `packages/shared/test/catalogue.test.ts`, 50 tests over the
  model catalogue and the pure helpers around it: no duplicate ids, every local
  model carrying the `engine`/`kind`/`files`/`sizeMb`/`tier` the loader reads,
  mel bins only ever 80 or 128, unique file names, every archive model mapping
  every file it declares to an entry in the archive, defaults and fallbacks
  resolving, `recommendTier` across the grid, and `clampChannels` against
  wrong-typed input off the wire.
- **Issue/Gap Uncovered**: Two all-clears and one latent risk. The public viewer
  writes transcript and speaker text with `textContent` throughout - its single
  `innerHTML` is a clear - so the publicly served page has no injection path,
  and the renderer's `innerHTML` sites are static templates or `esc()`-escaped.
  Every catalogue invariant already held, including the archive `pick` coverage
  I expected to catch something. The risk is the boot fallback: a config naming
  a model that left the catalogue falls back to a hardcoded `"deepgram-nova-3"`
  literal in the renderer, and that guard runs once. If that id is ever dropped
  the way whisper-small just was, the app strands itself on a second dead model.
  Nothing enforced that it stays in the catalogue. One test of mine was wrong
  rather than the code - 12 threads with 8 GB is correctly `medium`, since heavy
  needs both gates - and that expectation was fixed, not the function.
- **Enhancement Shipped**: `FALLBACK_STT` in shared, with the two properties the
  fallback actually depends on now asserted: it resolves in the catalogue, and
  it is a cloud model, because the fallback runs when nothing is known to be on
  disk. The renderer uses it instead of its own literal, so dropping that model
  turns the suite red instead of stranding a user.
- **Status**: PASSED
