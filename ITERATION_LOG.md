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
