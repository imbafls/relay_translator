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

---

### Turn 17/100 - Resilience & state (the .env that supplies the VPS its keys)

Turn 16's lesson generalised: hand-rolled implementations of standard formats
are where the sharp edges are. This is the last one in the tree.

- **Tests Added**: `packages/relay/test/dotenv.test.ts`, 14 tests over
  `tryLoadDotenv`: plain assignments, comments, blank lines, CRLF, quoted values
  of both kinds, an equals sign inside a value, an empty value, a shell
  `export` line, the environment winning over the file, a missing file, and four
  kinds of whitespace a real file picks up.
- **Issue/Gap Uncovered**: Its doc comment calls it a convenience for
  `pnpm dev:relay`, but `cli.ts` runs it on the directory beside the binary, so
  on the VPS it is what reads `/opt/callout-relay/.env` and supplies both API
  keys. Three faults. `(.*)\s*$` is greedy, so `.*` swallowed trailing
  whitespace and `\s*$` matched nothing - a key pasted with a space after it
  kept the space, and authentication then fails while every log shows the key
  looking correct. A trailing tab did the same. And a lone CR anywhere in the
  file made the whole regex fail, because `.` will not cross a carriage return:
  the assignment was skipped in silence, so the relay came up with no key at
  all. `vps.env` is authored on Windows and deployed to Linux, so mixed endings
  are not hypothetical.
- **Enhancement Shipped**: The line split takes CR, LF and CRLF. The value match
  is lazy, so trailing whitespace is trimmed rather than kept. Quotes have to
  match to count, and what is inside them is preserved verbatim, which is how a
  value with real spaces gets written deliberately. A shell `export` prefix is
  accepted, since these files are often sourced as well as parsed.
- **Status**: PASSED

---

### Turn 18/100 - Unit conversions (two units in one field)

Sweeping every place a number crosses between bytes, samples, seconds,
milliseconds and megabytes - the class turn 3's latency bug belonged to.

- **Tests Added**: one invariant in `packages/shared/test/catalogue.test.ts`,
  applied per model: the advertised `sizeMb` must be within 2% of the bytes the
  download actually fetches. It fails with the two numbers in the message, so a
  future mis-entry says what it says and what it should have said.
- **Issue/Gap Uncovered**: The catalogue was using two units in one field. The
  three per-file models had `sizeMb` in decimal MB (44 for 43.6, 670 for 670.5);
  the seven archive models had it in MiB (113 for 112.6, 537 for 537.7). Every
  formatter divides by 1000, so decimal is the intended unit and each archive
  model understated its download by about five percent. Most of the other
  conversions in the sweep came out sound: the STT billing seconds, the
  per-channel multiplier Deepgram charges on, the retry backoffs, the pending
  audio budget from turn 1 and the latency arithmetic from turn 3.
- **Enhancement Shipped**: The seven archive values now state decimal MB, and
  the invariant holds the field to one unit as models are added. Running it
  against the old catalogue fails all seven with the numbers named.
- **Left deliberately**: archive models unpack to far more than they download -
  whisper-turbo fetches 564 MB and lands 1037 MB on disk, nemotron 475 MB
  against 682 MB - and nothing tells the user that before they start. The
  catalogue already carries the unpacked sizes, so the number is available, but
  surfacing it is a renderer change rather than a data fix and does not belong
  in this turn.
- **Status**: PASSED

---

### Turn 19/100 - Stream & audio transport (room for the model before it starts)

Taking the follow-up turn 18 deferred, in the form that helps rather than the
form that only informs.

- **Tests Added**: 4 in `apps/standalone/test/models.test.ts` for the pre-flight
  - refused when the drive is short, both numbers named in the message, allowed
  when there is room, and allowed when the platform will not report free space -
  plus 2 in the catalogue tests for `modelDiskBytes`, including that an archive
  needs more room than it downloads.
- **Issue/Gap Uncovered**: `sizeMb` answers how long a download takes, not
  whether it fits, and the two differ a lot for archive models: the archive
  streams through memory and never lands on disk, so what has to be free is the
  unpacked size. whisper turbo fetches 564 MB and leaves 1037 MB; nemotron 475
  against 682. Nothing checked, so running out of space meant a long download,
  then a failure deep in the extract, on a disk that is now also full.
- **Enhancement Shipped**: `modelDiskBytes` in shared - unpacked files plus the
  silero VAD where an offline model needs it - and a pre-flight in
  `ModelStore.download` that refuses before fetching anything, naming what is
  needed and what is there. An unknown answer never blocks: `statfs` is not
  available everywhere, and a probe that cannot tell must not stop a download
  that would have worked. The probe is injectable, which is what makes the four
  cases testable without a full disk.
- **Status**: PASSED

---

### Turn 20/100 - Making the previous nineteen turns enforceable

- **Tests Added**: `packages/shared/test/workflows.test.ts`, 9 assertions that
  the workflows still run what the repo can check. Deliberately crude greps -
  they exist to notice a step being dropped, not to model GitHub Actions.
- **Issue/Gap Uncovered**: CI ran build, typecheck and the renderer id check,
  and nothing else. Not `pnpm test`, not `pnpm typecheck:test`, and - from
  before any of this - not `pnpm smoke` either. So 220 tests and 14 pre-existing
  smoke assertions ran only when someone remembered. Worse, the release workflow
  went from typecheck straight to building the installer, so a tag could publish
  with the whole suite red. Turn 4's crash shipped because something went out
  unverified; nothing structural had changed to stop that happening again. And
  `linux-relay` builds the binary that runs on the VPS with no typecheck and no
  tests at all, which is exactly how a Windows-authored file that Linux reads
  differently reaches production unnoticed - turn 17's dotenv bug in one line.
- **Enhancement Shipped**: CI runs the tests' typecheck, the suite, the renderer
  ids and smoke. The release workflow runs all four before it builds anything a
  user installs. CI gains a Linux job covering the packages that actually ship
  there, since every other check runs on Windows. The release pipeline's own
  Linux job was left alone on purpose: I cannot run these tests on Linux from
  here, and putting an unverified step in the path that publishes releases is
  not a trade worth making - CI is where that belongs until it has gone green
  once.
- **Status**: PASSED

---

### Turn 21/100 - What crosses to Linux

Went looking to close turn 20's open question by running the suite on Linux
here. There is no WSL and no Docker on this machine, so it cannot be done and
the caveat stands: the CI job is how that gets answered.

- **Tests Added**: `packages/shared/test/lineEndings.test.ts`, 3 assertions -
  that the detection flags a CRLF-stored blob and passes everything else, that
  no tracked text file is stored with anything but LF, and that the check found
  enough files to mean something. It reads what git *stores*, not the working
  tree: CRLF on disk in a Windows checkout is expected and fine.
- **Issue/Gap Uncovered**: None, and the hypothesis was wrong in a way worth
  recording. Every commit this session warned about CRLF conversion, and files
  from this repo are deployed to a Linux box, so a CR reaching the VPS looked
  plausible - it is the exact bug turn 17 fixed in `tryLoadDotenv`. It is not
  happening: the index holds 106 files as LF and 17 as binary, and nothing at
  all with CRLF. The repo is already normalised correctly.
- **Enhancement Shipped**: It was only correct because every contributor so far
  has had `core.autocrlf` on - a property of the machines, not the repository.
  `.gitattributes` makes it a property of the repository, and the guard fails if
  a CRLF blob is ever committed. Both are preventive rather than corrective, and
  the commit says so. Adding the attribute changed nothing that is already
  stored, which is the check that it was a no-op.
- **Status**: PASSED

---

### Turn 22/100 - Stream & audio transport (what the source pickers offer)

- **Tests Added**: `packages/companion/test/capture.test.ts`, 8 tests over
  `listDevices`. `BrowserAudioCapture` is otherwise thoroughly browser-bound,
  but this method is plain mapping over one call, so only that call is stood in
  for: the two built-in sources always coming first, surviving an
  `enumerateDevices` that throws because permission has not been granted,
  filtering non-inputs and entries with no id, naming a microphone the browser
  will not name, and the platform's pseudo-devices.
- **Issue/Gap Uncovered**: `default` was filtered - it is already offered as the
  first entry - but `communications` was not. Windows exposes it alongside
  `default` as a second alias for a device that is in the list already, so the
  picker offered two entries that are the same input. That is the exact shape of
  the confusion the handoff documents at length: two sources that turn out to be
  the same one, two channels transcribing the same voice, and nothing anywhere
  saying why. It does not explain the Wave Link case in the handoff, which is a
  genuine mix-routing question, but it is another way to arrive at the same
  symptom - and this one is ours.
- **Enhancement Shipped**: Both alias ids are filtered, named as what they are.
  Also worth recording for whoever writes the next browser-facing test: Node
  ships its own `navigator` and it is getter-only, so it has to be redefined
  rather than assigned - all 8 tests failed on that before they failed on
  anything real.
- **Status**: PASSED

---

### Turn 23/40 - Client UI (a DOM harness, and the viewer under it)

The loop was capped at 40 this turn at the owner's request. This is the first of
the two things worth the remaining budget: a real DOM harness, rather than more
recommending of one.

- **Tests Added**: `packages/viewer/test/viewer.test.ts`, 7 tests running the
  shipped `index.html` in happy-dom with the shipped `app.js` evaluated inside
  it, driven by messages pushed through the socket the relay would have opened.
  Covers the token coming out of `/watch/<token>`, a final subtitle appearing,
  the translation patching its own line rather than adding one, two speakers
  staying separate with their tags, caption text not being rendered as markup,
  the interim line clearing when the stream stops, and the ended message when
  another device takes the link.
- **Issue/Gap Uncovered**: Nothing in the page - it behaves correctly on every
  path tested, and the markup case confirms by execution what turn 5 could only
  read: a caption containing an `<img onerror=...>` lands as text, no element.
  Two mistakes were mine and worth writing down. The viewer's row markup is
  `.src > span.txt` with the translation directly in `.tgt`; I wrote selectors
  for `.src .text`, which is the *desktop renderer's* structure, and four tests
  failed on my own confusion between two different pages. And the socket's
  `onopen` is scheduled, so it fired into a page the teardown had already
  cleared and reported an error belonging to the teardown - handlers are
  detached before the body goes now.
- **Enhancement Shipped**: The harness itself. happy-dom is in place and the
  pattern is established: load the real markup, evaluate the real script, stand
  in only for the socket. The renderer's 1900-line setup state machine is the
  obvious next tenant, and it no longer needs new infrastructure to reach.
- **Status**: PASSED

---

### Turn 24/40 - Client UI (the renderer's boot, under the new harness)

The harness built last turn, pointed at the 1900-line file it was built for.

- **Tests Added**: `apps/standalone/test/renderer.test.ts`, 5 tests booting the
  real renderer: the shipped `index.html` in a DOM and `app.ts` imported so its
  own `boot()` runs, with the preload bridge stood in for - that bridge is the
  process boundary and everything behind it is Electron. Covers which view opens
  on a fresh install versus a finished one, and all three arms of the
  gone-model fallback.
- **Issue/Gap Uncovered**: Nothing in the product. The fallback turn 5 hardened
  works end to end: a config naming `local-whisper-small` - dropped from the
  catalogue for aborting the process - is rewritten to `FALLBACK_STT`, the
  change is logged rather than made silently, and a config naming a model that
  still exists is left alone. Turn 5 could only argue for that by reading;
  disabling the guard now turns two tests red, so it is held down.
  One harness note: `document.fonts` does not exist in happy-dom, and the
  renderer awaits `document.fonts.ready` while laying out. The exception landed
  after the fallback ran but before a view was chosen, which is why the fallback
  tests passed and the view test did not - a good reminder that a partial boot
  fails in a shape that looks like a specific bug. The same again with timers:
  `boot()` starts a clock and a level meter on intervals and never stops them,
  which is right for a window that lives as long as the app and a leak in a
  test - they went on firing into a torn-down page and took the whole run's
  exit code with them while every test still reported passing.
- **Enhancement Shipped**: Coverage where there was none, on the file that holds
  all the renderer's state. The bridge stub is the reusable part: every one of
  the eighteen `cr.*` methods answers, so the next test here starts from a
  booting app rather than from scratch.
- **Status**: PASSED

---

### Turn 25/40 - Client UI (the setup flow's stale-key bug, pinned down)

- **Tests Added**: 5 more in `apps/standalone/test/renderer.test.ts`, all through
  the boot harness: a saved Gemini key being re-checked when setup opens, the
  same for Deepgram, no check at all when nothing was saved, both fields
  refilled from config, and setup always opening on step 1.
- **Issue/Gap Uncovered**: Nothing new - this pins down a bug that was real
  enough to get its own commit (`8aae344`), and whose consequence is spelled out
  in a comment beside the fix: a key saved in an earlier run has no validation
  cached in this one, so step 2 opened showing EMPTY with CONTINUE dead, and the
  only enabled way out was SKIP - which turns off the very translation the key
  was there for. Removing the two re-check lines turns both tests red.
  My own mistake this turn: the onboarding checks are debounced by 500 ms
  because they are wired to keystrokes, and a 30 ms settle saw nothing. The
  tests wait on the outcome now rather than on a guessed delay, and the negative
  case waits past the debounce so it asserts absence rather than impatience.
- **Enhancement Shipped**: Regression cover for a fixed bug that had none. That
  is the second past bug this harness has locked down in two turns - the
  gone-model fallback in turn 24, the stale-key reopen here - which is the
  argument for having built it. The fixes existed; the guards did not.
- **Status**: PASSED

---

### Turn 26/40 - Client UI (the Stream Deck inspector's own copy of the catalogue)

Started by closing a loose end of my own: turn 9 redacted the API keys leaving
the control API to `"***"`, and the property inspector reads `geminiApiKey` to
decide whether its translate toggle works. It only ever tests truthiness, so a
placeholder is safe - but I had reasoned that rather than shown it.

- **Tests Added**: `packages/shared/test/propertyInspector.test.ts`, 6 tests
  parsing the shipped `pi.js` and holding its hardcoded lists against the
  catalogue: no speech, translation or language id it offers may be unknown to
  the app, every cloud and local model the catalogue has must be offered, and
  every entry needs a label.
- **Issue/Gap Uncovered**: The inspector is a plain script in the plugin folder
  with no build step, so it cannot import the catalogue and keeps its own copy
  of every id. That copy had drifted twice. It still offered
  `local-whisper-small`, which was dropped in `0ae312f` for aborting the
  process - picking it sets a model the app no longer knows, which the renderer
  then quietly rewrites via the turn 24 fallback, so the setting appears to do
  nothing. And it was missing all seven archive models added in `36aeda5`.
  That second one is worse than a short menu: the inspector filters downloaded
  models against this same list, so a model installed in the app could not be
  chosen from the Stream Deck at all.
  One suspicion checked and dropped: `currentStatus.localModels` looked like a
  field nothing sends, which would have made the whole downloaded-model path
  dead. It is in `ControlStatus` and `main.ts` populates it. Worth verifying
  before reporting.
- **Enhancement Shipped**: The list names all ten local models and no dead ones,
  and the guard fails if either side moves without the other. Running it against
  the old file reports both faults by name.
- **Status**: PASSED

---

### Turn 27/40 - Resilience & state (the version nothing was bumping)

Turn 26 found the property inspector keeping its own copy of the catalogue.
This sweeps the same seam - data duplicated where it cannot be imported - and
found the duplicate that had drifted furthest.

- **Tests Added**: `packages/shared/test/versions.test.ts`, 6 tests: every
  workspace `package.json` and every `.sdPlugin/manifest.json` must state the
  same version as `apps/standalone`, that version must be one the tooling
  accepts, and `version-bump.mjs` must actually reach all of them.
- **Issue/Gap Uncovered**: The Stream Deck manifest said `0.1.0` while the rest
  of the repo said `0.5.2`. It is not a `package.json`, `version-bump.mjs` only
  globs those, and the release workflow only checks the tag against
  `apps/standalone` - so nothing has moved it since the UI redesign, through
  five releases. Elgato both displays that number and uses it to decide a plugin
  is newer, so a stuck one reads as a plugin that has never been updated.
  One hit checked and dismissed: `home.html` matched the search for hardcoded
  language ids, but those are CSS classes on the sample captions, not a
  duplicated list.
- **Enhancement Shipped**: `version-bump.mjs` rewrites the manifest too, the
  manifest is at `0.5.2`, and the guard covers both directions - the versions
  must agree, and the script must still be able to reach every file that states
  one. Reverting either half turns two tests red.
- **Status**: PASSED

---

### Turn 28/40 - Resilience & state (checking the checker)

`check-renderer-ids.mjs` runs in CI and in the release gate and nothing had ever
checked it. A guard that quietly stops guarding is worse than no guard, because
the green tick is believed.

- **Tests Added**: `packages/shared/test/checkRendererIds.test.ts`, 6 tests
  running the real script against fixture trees - its paths are relative to the
  working directory, so a temp tree is all it takes to control its inputs.
  Covers a clean pass, an id the markup does not define, a page that has gone
  missing, an id used through `querySelector`, single-quoted ids, and a class
  selector not being mistaken for one.
- **Issue/Gap Uncovered**: A configured page whose HTML could not be read was
  skipped with a message and did not count as a failure. Deleting the viewer's
  `index.html` made the script print "skip phone/OBS viewer" and then "all
  renderer element ids resolve", exit 0 - reporting success while checking
  nothing. Since a move or a rename is exactly when you want this check to
  speak up, it was silent in the one case that matters most. Two latent holes
  alongside it, neither triggered by today's code: ids referenced through
  `querySelector("#id")` were invisible to it, as were single-quoted lookups
  and single-quoted `id=''` attributes.
- **Enhancement Shipped**: A missing page is a failure with a message saying
  nothing was checked. The reference scan covers `querySelector` and both quote
  styles. The real repo still passes - 116, 32 and 14 ids resolving - and
  removing a page now exits 1 where it used to exit 0.
- **Status**: PASSED
