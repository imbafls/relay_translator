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

---

### Turn 6/100 - Resilience & state (relay token persistence)

- **Tests Added**: `packages/relay/test/config.test.ts`, 15 tests over
  `relay-state.json` - the file that keeps a viewer link working across a
  restart, living on a VPS next to a service that gets restarted and
  redeployed. Covers tokens surviving a restart, explicit options winning,
  recovery from a file truncated mid-write / empty / null / a bare string / an
  array, wrong-typed tokens, and what `saveState` leaves on disk.
- **Issue/Gap Uncovered**: `readStateFile` is guarded, so a corrupt file already
  regenerated rather than crashing. But the tokens came out of it through
  `persisted?.publisherToken || generateToken()`, which is a falsiness check,
  not a type check. A file holding `123`, `true`, `{"a":1}` or `["a"]` was
  adopted verbatim - and a non-string token can never equal the string off a
  query param, so the relay came up refusing every connection it exists to
  accept, then persisted that state so a restart did not clear it. The route in
  is `saveState` itself: a plain `writeFileSync` that a crash or a full disk can
  truncate. Two all-clears alongside it: `/updates/` is properly defended by an
  `^[A-Za-z0-9._-]+$` allowlist that makes a slash impossible, and the uplink
  hello spreads rather than dereferences, so it cannot crash the way the
  publisher hello could.
- **Enhancement Shipped**: Persisted tokens are accepted only when they are
  non-empty strings, and `readStateFile` rejects a root that is not a plain
  object. `saveState` writes beside the file and renames over the top, so a
  crash part way through can no longer leave a truncated file that costs
  everyone their viewer link on the next boot.
- **Status**: PASSED

---

### Turn 7/100 - Translation pipeline (what happens when Gemini misbehaves)

- **Tests Added**: `packages/relay/test/gemini.test.ts`, 12 tests driving the
  real translator - its retry predicate, backoff, cache and response parsing.
  What stands in is Google: a real HTTP server on localhost answering the shapes
  the API answers when things go wrong. Covers 429, 500, 503 to exhaustion, a
  400, a 200 carrying no candidates, a dropped connection, multi-part answers,
  token accounting, cache hits, and callout normalisation.
- **Issue/Gap Uncovered**: The retry predicate was
  `status === 429 || (status !== undefined && status >= 500) || /abort/i.test(...)`.
  A transport failure - a dropped connection, DNS, a body that will not parse -
  arrives as `TypeError: fetch failed` with no status and no "abort" in the
  text, so it fell through every branch and broke out of the loop on the first
  try. That is the single most common transient failure on a live stream over a
  home connection, and it was the one class getting no retry, while a 500 got
  two. One blip, and that line is never translated for anyone.
- **Enhancement Shipped**: The predicate now reads the other way round: anything
  without a status is a request that never came back with one and is worth
  another go, 429 and 5xx retry as before, and a 4xx breaks out because it is
  our fault and asking again cannot fix it. A 200 with no candidates is tagged
  permanent, since a safety block answers the same way however many times you
  ask. Reverting the predicate turns exactly one test red - the dropped
  connection - which is the shape a fix should have: it repairs the broken case
  and leaves every correct one alone. Also adds `baseUrl` and `backoffMs` seams,
  which is what makes any of this testable against a real server.
- **Status**: PASSED

---

### Turn 8/100 - The model download pipeline, and the open archive bug

- **Tests Added**: `apps/standalone/test/models.test.ts`, 9 tests over the real
  `ModelStore` - download plan, staging folder, bz2 and tar pipeline, size gate,
  publish-by-rename and cleanup all executing against a real 190-byte tar.bz2
  fixture on a real disk. Only the transport is stood in for, since the
  catalogue points at Hugging Face and the real archives are hundreds of MB.
  `ModelStore` turned out to have no Electron imports at all, so none of this
  needed the harness I expected to have to build.
- **Issue/Gap Uncovered**: The pipeline is sound - declared entries extract
  under the names the worker wants, undeclared entries stay out, the staging
  folder is published with one rename, and a missing entry, a short entry or an
  HTTP error each fail without leaving anything that looks installed. The gap
  was diagnostic. A stream that stops early and one that arrives corrupted both
  surfaced as the same decoder error, which is what makes the open archive bug
  read as "the archive is bad" when the transport may be what broke.
- **What this says about the open bug**: Probing the decoder directly, a
  truncated bz2 stream reports `input stream ended prematurely` or a
  `Cannot read properties of undefined` TypeError - *not* the
  `crc32 do not match` the bug report carries. That is evidence against plain
  truncation, though not proof: the fixture is a single small block and a real
  118 MB archive is many blocks, where a partially received block could
  plausibly fail its CRC. It cannot be settled from here, which is exactly why
  the instrumentation matters.
- **Enhancement Shipped**: `fetchArchive` counts the bytes that actually arrive
  and compares them to `content-length`. A failure now says either "the download
  stopped early: N of M bytes (P%)" or "the archive would not unpack after all N
  bytes arrived", so the next person to hit this knows which half to look at
  instead of inferring it from a crc message. Also a `catalogue` seam on
  `ModelStore`, which is what lets a test drive it with a small model.
- **Status**: PASSED

---

### Turn 9/100 - Client UI (the local control API handed out the API keys)

- **Tests Added**: `packages/companion/test/controlServer.test.ts`, 10 tests
  driving the real control server on a real port over real HTTP. Every response
  that carries status is checked against the actual secret values, an origin
  from the open web, the `null` origin the property inspector sends, and a
  mutation with no client header.
- **Issue/Gap Uncovered**: `ControlStatus.config` is the whole `AppConfig`,
  which holds `deepgramApiKey`, `geminiApiKey`, `publisherToken` and
  `viewerToken`, and five paths returned it verbatim - `GET /status`, the SSE
  opening frame, `broadcast`, and the replies to `POST /start`, `/stop` and
  `/config`. The only gate is `allowedOrigin`, and it has to allow `"null"` for
  the Stream Deck property inspector, because a `file://` page sends exactly
  that. So does a sandboxed iframe on any website. A page embedding one could
  read the live Deepgram and Gemini keys off a fixed localhost port. Disabling
  redaction turns six tests red, the `Origin: null` one among them.
  Found alongside it: `ControlHandle.port` reported the *requested* port, so
  `listen(0)` bound an ephemeral port while the handle still advertised 0, and
  anything building a URL from it got a dead address.
- **Enhancement Shipped**: Every status leaving the control server is redacted -
  a set credential becomes `"***"`, an unset one stays falsy. That is all any
  consumer needs: the property inspector only tests truthiness to grey out its
  translate toggle, and the desktop UI reads config over IPC, not from here. The
  origin allowlist is deliberately unchanged, because it cannot be tightened
  without breaking the property inspector - which is the argument for not having
  the keys behind it in the first place. `ControlHandle.port` now reports the
  bound port.
- **Status**: PASSED

---

### Turn 10/100 - Resilience & state (the config file holding the API keys)

- **Tests Added**: `packages/companion/test/config.test.ts`, 17 tests over
  `ConfigStore` against real files: round-trip, partial language merge, unknown
  keys surviving a downgrade, env fallback filling a gap without overriding a
  saved key, both pre-0.3 and pre-0.4 migrations, and four shapes a file takes
  when a write did not finish.
- **Issue/Gap Uncovered**: Three, all confirmed by running the tests against the
  original. `config.json` holds the user's whole setup and both API keys, and
  `persist()` was a plain `writeFileSync`, so a crash part way through left JSON
  that does not parse. `load()` answered that by falling back to
  `DEFAULT_CONFIG` behind a `console.warn` - the keys and the entire setup gone
  silently, and made permanent by the next save. A file holding a bare `null`
  crashed `load()` outright with `TypeError: Cannot convert undefined or null to
  object`, because `Object.entries` runs outside the try that guards the parse.
  A file holding a bare string merged in as numeric keys, `{0:'h',1:'e',...}`.
- **Enhancement Shipped**: `persist()` writes beside the file and renames over
  the top, and keeps the copy it is replacing as `.bak` - but only while that
  copy still parses, so a good backup is never overwritten by a torn one.
  `load()` reads the backup before it considers defaults, so a half-written save
  costs a settings change rather than the API keys. A root that is not a plain
  object is rejected instead of being merged.
- **Status**: PASSED

---

### Turn 11/100 - Sweeping the pattern the last five turns kept hitting

Turns 4, 6, 9 and 10 were all one shape: *we wrote it, so it must be
well-formed*. This turn went looking for the rest of that class instead of
another instance of it, by enumerating every write and every parse in
first-party runtime source.

- **Tests Added**: 6 tests in `packages/relay/test/localStt.test.ts` covering the
  probe's argv against paths a real Windows profile produces - a space,
  non-ASCII, an apostrophe, a trailing space - plus a worker that fails the
  probe unless the init JSON parses back with its `modelDir` and `engine`
  intact.
- **Issue/Gap Uncovered**: None. The sweep came back clean, which is the finding.
  Writes: `models.ts` already stages to `.part` and renames, and the two JSON
  stores were the ones fixed in turns 6 and 10; `version-bump.mjs` and `vps.mjs`
  are tooling that is never read back at runtime. Parses: Deepgram's handler
  wraps everything in a try, both the uplink and relay clients guard the parse
  and never dereference a nested object the way the publisher hello did, and the
  viewer's saved-style loader clamps its numbers and whitelists its font. The
  two places the pattern was actually open are both already closed.
- **Enhancement Shipped**: Regression cover for the newest and least-exercised
  code in the tree. The crash guard ships an init through `argv` to a child
  process, and a probe that fails because a path did not survive that trip
  reports "could not be loaded on this PC" - a false verdict on a model that
  works. A user called Ömer is not an edge case. That path is now held down
  before it ships rather than after.
- **Status**: PASSED

---

### Turn 12/100 - Message orchestration (the path to a phone)

- **Tests Added**: `packages/relay/test/uplink.test.ts`, 7 tests running two real
  relays in-process with a bridge between them: uplink auth against the viewer
  token and no token, the greeting, a subtitle crossing from the local relay to
  a viewer on the far one, the language pair propagating, the remote viewer
  count reaching the uplink, and the not-live status when the uplink drops. The
  bridge is a raw socket rather than the companion's `UplinkClient`, since that
  lives in a package this one does not depend on - so what is covered is the
  relay half.
- **Issue/Gap Uncovered**: None in the code. A correction to my own turn 4 note
  instead: I had flagged the unguarded `ws.send` in the viewer fan-out as a risk
  that one viewer's failure would break the broadcast for the rest. It is not
  reachable. `viewers` is keyed by token and `onViewer` kicks the previous holder
  of that token, so there is at most one viewer per token and there are no
  others to break it for. The gap that was real is that this whole path had no
  automated cover at all: `scripts/uplink-e2e.mjs` needs a live VPS, a relay on
  8787 and a real `%APPDATA%`, so nothing runs it, and `pnpm smoke` only ever
  exercises one relay.
- **Enhancement Shipped**: The product's headline feature - captions reaching a
  friend's phone through the VPS - is now covered by `pnpm test` on any machine,
  with no VPS and no keys. Two traps worth recording for whoever writes the next
  one: both relays greet a socket the instant they accept it, so a listener
  attached after `open` resolves has already missed "ready" and "hello"; and the
  mock STT marks itself open on a `setImmediate`, so a single audio buffer sent
  in the same tick as the hello is discarded. A publisher streams, and the test
  has to as well.
- **Status**: PASSED

---

### Turn 13/100 - Resilience & state (the socket held open all session)

- **Tests Added**: `packages/companion/test/uplinkClient.test.ts`, 7 tests
  driving the real `UplinkClient` against a real WebSocket server: a second
  `connect()`, a retry landing next to a reconnect, automatic recovery when the
  relay goes away, the hello being resent on the new socket, staying down after
  `disconnect()`, no retry after a 4401 token rejection, and the same
  stacking test against `RelayPublisherClient`.
- **Issue/Gap Uncovered**: `open()` assigned `this.ws = ws` without closing the
  socket it was replacing, and `connect()` did not clear an armed `retryTimer`.
  So a second `connect()` - a settings change, a session restart - left two live
  sockets to the relay. The orphan is unrecoverable rather than merely untidy:
  its `onclose` returns early because `this.ws` has moved on, so it is never
  retried and never closed, and it holds until the far end drops it. This is the
  socket the app keeps open for a whole session, so the leak is per restart and
  accumulates. `relayClient.ts` had the identical shape and the identical fix.
- **Enhancement Shipped**: `open()` now clears any armed retry and closes the
  previous socket before opening a new one, clearing `this.ws` first so the old
  socket's `onclose` correctly sees it is no longer current and does not arm a
  retry of its own. `scheduleRetry` clears before it sets, so two timers can
  never be armed at once. Reverting either file turns its stacking test red.
- **Status**: PASSED

---

### Turn 14/100 - Client UI (the control client and its hand-rolled SSE)

- **Tests Added**: `packages/companion/test/controlClient.test.ts`, 12 tests
  pairing the real `ControlClient` with the real `ControlServer`, plus a raw HTTP
  server for the cases where what matters is how the client parses bytes rather
  than what a server means: a keepalive comment between events, an event split
  across two chunks, a frame that is not valid JSON, an event that is not a
  status, two broadcasts back to back, unsubscribe, and recovery when the server
  restarts underneath it.
- **Issue/Gap Uncovered**: The SSE parser itself is sound - every framing case
  above passed first time, including the ones a well-behaved server never
  produces. What is wrong is narrower: the subscriber callback was invoked
  *inside* the try that exists to catch malformed JSON. A consumer whose handler
  throws - a render bug in the Stream Deck plugin, say - had its exception
  swallowed and filed as "ignore malformed frame", so a real bug in the one
  place this data is used became invisible. The Stream Deck plugin itself is a
  clean singleton with no leak: one client, one subscription, and `instances`
  added and removed on appear and disappear.
- **Enhancement Shipped**: Parse and dispatch are separated. A frame that will
  not parse is skipped, and a subscriber that throws is caught on its own and
  reported, rather than being mistaken for bad input. Letting it out instead
  would tear down the stream and reconnect, so the stream survives and the error
  is visible - which is the same choice turn 8 made about the archive download:
  say which thing broke.
- **Status**: PASSED

---

### Turn 15/100 - Message orchestration (what churn leaves behind)

- **Tests Added**: `packages/relay/test/churn.test.ts`, 7 tests against a real
  relay doing what a long session actually does: a settings change rebuilding
  the session on a live socket, a publisher replaced by a new one, eight
  connect-and-disconnect cycles, and the broadcast bus subscribed and
  unsubscribed ten times over.
- **Issue/Gap Uncovered**: Nothing in the code. One thing in my understanding,
  which the tests corrected: a final subtitle goes out *twice* by design - the
  source immediately, then the translation patching the same segment id, both
  carrying `final: true`. My first pass counted every final and read that as a
  duplicate. Knowing it let the assertions tighten from "no more than two" to
  "exactly one", which is the cover actually worth having against a duplicated
  caption. Worth recording the contrast with turn 13: the server *does* close
  the publisher socket it replaces, which is precisely what the client failed to
  do with its own. Same situation, opposite outcome.
- **Enhancement Shipped**: Regression cover for the duplicate-caption class -
  doubled subtitles, reused segment ids, ghost sessions still feeding the bus
  after their publisher left, and broadcast listeners piling up across the
  rewiring the app does whenever the relay is rebuilt. Each asserts an exact
  count, so a regression shows up as a number rather than a shrug.
- **Status**: PASSED

---

### Turn 16/100 - Resilience & state (range requests on the update feed)

- **Tests Added**: `packages/relay/test/updates.test.ts`, 12 tests against a real
  relay serving a real 1000-byte installer whose bytes encode their own offset,
  so a wrong slice is visible rather than merely the wrong length. Covers the
  whole file, `latest.yml` caching, HEAD, an explicit span, an open-ended span, a
  suffix range, an end past the file, a start past the file, a backwards range,
  a zero-length suffix, and a Range header that cannot be parsed.
- **Issue/Gap Uncovered**: Three, in the code that feeds electron-updater.
  `bytes=-100` is the suffix form and means the last 100 bytes; the regex left
  `start` empty so it was read as `0-100` and served the *first* 101 bytes,
  under a `Content-Range` asserting that was the range requested. The client
  gets the beginning of the installer where it expected the end, and nothing
  anywhere reports an error - the worst shape a bug can take on a download that
  is then executed. `bytes=0-999999` returned 416 rather than clamping, though
  RFC 7233 says an end at or past the length means the rest of the file, which
  is exactly what a resume asking for more than is left sends. And `bytes=-0`
  returned a byte instead of the 416 an unsatisfiable range calls for.
- **Enhancement Shipped**: The suffix form is computed from the end of the file,
  an over-large end is clamped to the last byte, and a zero-length suffix is
  refused. Nothing else moved: the explicit-span, open-ended, start-past-EOF and
  backwards cases all passed before the change and still do.
- **Status**: PASSED
