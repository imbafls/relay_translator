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

---

### Turn 29/40 - Message orchestration (the check that keeps a stream private)

Started by verifying the last unchecked guard. `pnpm smoke` is in CI and the
release gate, and nothing had confirmed it fails when it should - so I disabled
the relay's admin auth and ran it: `FAIL admin endpoint auth`, one failure,
exit 1. It has teeth, and all four of its catch blocks either record a failure
or only guard a JSON parse.

- **Tests Added**: `packages/relay/test/viewerAuth.test.ts`, 9 tests against a
  real relay: the real token admitted, a wrong one refused, no token refused,
  the *publisher's* token refused, a prefix of the real token refused, the page
  still served to anyone, and three for rotation - the old token stops working,
  the new one is admitted, and whoever was already watching is hung up on.
- **Issue/Gap Uncovered**: A coverage hole rather than a defect, in the one
  place it matters most. The viewer page is served to anybody by design, so a
  link can be opened before a session starts, and the token is enforced at the
  WebSocket instead. That single check is the whole of what keeps a stream
  private, and nothing tested it - smoke asserts the page is public and that a
  *publisher* with a bad token is refused, never a viewer. Worse, its rotate
  block is titled "old viewer token dies" and only asserts that the token
  changed: the heading promised a check that was not there. The behaviour is
  correct on all nine counts, rotation hanging up on the connected viewer
  included, which I did not expect to hold.
- **Enhancement Shipped**: The property is now asserted rather than assumed.
  Disabling the viewer token check turns five of the nine red - and before this
  turn it would have turned nothing red anywhere in the repo.
- **Status**: PASSED

---

### Turn 30/40 - The document the next session reads first

- **Tests Added**: `packages/shared/test/handoff.test.ts`, 4 assertions.
  Deliberately narrow, because a document cannot be asserted true but a command
  it tells you to run either exists or does not: every `pnpm <script>` it names
  must be in `package.json`, every repo file it points at must exist, and it may
  not still claim there is no test runner.
- **Issue/Gap Uncovered**: `HANDOFF.md` had gone stale in a way that already
  cost something. It told this loop the repo had no test runner - which is why
  the loop prompt says so - long after the runner existed. Its first-run block
  ran typecheck, the id check and smoke, and never the suite. Its open-work
  entry for the archive download still asked for instrumentation that turn 8
  shipped. Nothing recorded the hardening branch or that none of it is in
  `v0.5.2` as tagged.
- **Enhancement Shipped**: The document now matches the repo: the full
  verification sequence, why `typecheck:test` is separate, what the branch holds
  and that the tag predates it, the instrumentation and the evidence it has
  produced so far, and a new open item for the Linux CI job that has never run.
  Two mistakes of mine on the way, both caught immediately: the file-reference
  regex listed `js` before `json`, so ordered alternation truncated
  `package.json` to `package.js`; and a failed backup left injected test text in
  the document, which the guard's own assertion then flagged.
- **Status**: PASSED

---

### Turn 31/40 - Message orchestration (the unauthenticated kill)

First of the audit's findings. The audit ran for two hours over 338 agents and
came back with 36 confirmed defects, several of them worse than anything the
previous thirty turns found - including this one, which is live on the VPS.

- **Tests Added**: `packages/relay/test/hostileRequests.test.ts`, 8 tests firing
  request targets over a raw socket, because `fetch` normalises them away and
  the internet does not: `//%25`, `/updates/%C0%80`, a lone `%`, a truncated
  `%E0%A4`, a bad escape in the query, a backslash host, and the same target on
  the WebSocket upgrade path.
- **Issue/Gap Uncovered**: Node's HTTP parser accepts targets `new URL` refuses.
  `//%25` reads as an invalid host and throws `ERR_INVALID_URL`;
  `decodeURIComponent` on the `/updates/` route throws `URIError` on an overlong
  or truncated escape. Both are outside any try, both run before any token
  check, and there was no `uncaughtException` handler anywhere. Proved against a
  real built process rather than under vitest, which installs its own handlers
  and hides it: `/health` answered 200, then `GET //%25` exited the process with
  code 1 and every publisher and viewer socket went with it. Anyone could do
  this to `relay.supr.systems`, repeatedly, with one line of curl. Turn 4 found
  the same shape behind the publisher token; this needs nothing at all.
- **Enhancement Shipped**: `parseTarget` answers 400 instead of throwing, on
  both the request and upgrade paths; the `/updates/` decode is guarded; and
  `cli.ts` logs an uncaught exception rather than exiting - deliberately, since
  the alternative on an unattended public host is one malformed request ending
  the stream for everyone and systemd restarting into the same request. Same
  probe after the fix: 400, 404, 404, process alive, `/health` still 200.
- **Status**: PASSED

---

### Turn 32/40 - Resilience & state (a descriptor per abandoned download)

Audit finding 4, and server-side like finding 1, so both reach the VPS in the
same mirror step.

- **Tests Added**: `packages/relay/test/updateStreams.test.ts` (5) plus
  `packages/relay/scripts/leak-probe.cjs`, a real-process measurement the test
  runs and asserts on. Behavioural cover alongside it: serving normally after a
  run of aborts, a range still correct afterwards, and a completed download
  still arriving whole.
- **Issue/Gap Uncovered**: `fs.createReadStream(file).pipe(res)` on the
  unauthenticated `/updates/` route. `pipe` attaches an error handler to the
  *destination* only, so a read error on the source is emitted with no listener
  and ends the process, and it never destroys the source when the destination
  goes away. Measured against the built relay: 25 aborted downloads, 25 streams,
  **all 25 `destroyed=false` and still holding descriptors**. A caller leaving
  part way through is completely ordinary - a phone off wifi, an updater
  retrying, a closed tab - so this accumulates until the process hits its file
  limit and stops serving without crashing or logging why.
- **A mistake worth recording**: my first test observed the leak through the
  filesystem, on the theory that Windows will not unlink an open file. All six
  assertions passed against the *unfixed* code. Node opens these with
  `FILE_SHARE_DELETE`, so the file renames happily while the descriptor is held
  - the observable proved nothing and would have shipped as false confidence.
  Counting the streams directly is what showed the leak.
- **Enhancement Shipped**: both call sites go through `sendFile`, which uses
  `pipeline` - it destroys the source when the destination goes and gives the
  source an error handler. Re-measured: 25 aborts, 0 undestroyed. Reverting the
  fix turns the test red with `RESULT: 12 leaked`.
- **Status**: PASSED

---

### Turn 33/40 - Client UI (finishing what turn 9 started, partly)

Audit finding 3, which is a correction to my own turn 9 work.

- **Tests Added**: 3 in `packages/companion/test/controlServer.test.ts`, and
  `view-secret` added to the list of secrets every existing assertion checks -
  so the whole file now fails if the viewer token appears anywhere, not just
  the API keys.
- **Issue/Gap Uncovered**: Turn 9 masked the four `SECRET_FIELDS` and I called
  the control API safe. A viewer link is `<origin>/watch/<viewerToken>`, so
  `relay.viewerUrl` carried the token in a different shape and went out
  unmasked on `/status`, on `/events`, on every broadcast and in the replies to
  `/start`, `/stop` and `/config`. Masking the field and leaving the URL hands
  out the same power: whoever holds the link watches the stream. I fixed the
  keys and left the door open, and it took an adversarial audit to notice.
- **Enhancement Shipped**: `redact()` masks the token inside `viewerUrl`,
  `localViewerUrl` and `remoteViewerUrl` as well as the fields.
- **Not closed, and marked in the code**: `GET /link` returns the unredacted
  status on purpose - handing out the viewer link is what that route is for -
  and it has no credential to check. `allowedOrigin` admits `Origin: null`,
  which is exactly what a sandboxed iframe on any web page sends, so a page you
  visit can still ask for the link. The real fix is the one the audit names: a
  per-launch token the app writes and the Stream Deck property inspector
  presents, gating reads as well as writes. That needs the inspector wired to
  receive it, which cannot be tested from here, and the `Origin: null`
  allowance is load-bearing for a `file://` inspector - removing it blind would
  break the integration silently. Shipping half-wired auth would be worse than
  the honest partial fix, so the remaining hole is commented at the route.
- **Status**: PASSED

---

### Turn 34/40 - Resilience & state (the field that chooses which binary runs)

Audit finding 2, and the route it travels - finding 3's still-open `/config`.

- **Tests Added**: `packages/shared/test/controlPolicy.test.ts`, 25 tests over
  two new helpers: what a remote control may change, and which update feed may
  be trusted.
- **Issue/Gap Uncovered**: `updateFeedUrl` decides which executable the app
  downloads and runs on quit, under `autoDownload` and `autoInstallOnAppQuit`,
  and this build sets no `publisherName` - so electron-updater's signature check
  returns early and the only integrity proof is a hash in the feed's own file.
  Nothing validated the value. The route to it was worse: the control API's
  `patchConfig` went straight into `configStore.update`, which merges any key at
  all, so a single POST from a sandboxed iframe could set the update feed, the
  relay endpoint, the publisher token or an API key. One field, set from a web
  page, is code execution as the user.
- **Enhancement Shipped**: `controlConfigPatch` filters an untrusted patch down
  to what a Stream Deck legitimately changes - what to transcribe, in which
  languages, from which device, how it is shown - and logs what it refused.
  Nothing on that list can point the app at another server or another binary,
  and it is exactly the five fields `pi.js` actually sends, verified in turn 26.
  IPC from our own renderer still applies patches unfiltered.
  `isAllowedUpdateFeed` requires https, allowing http only on loopback, which is
  a developer serving their own build.
- **What this does not do**: signing. The audit's other half is
  `win.publisherName` plus a certificate, which is not something I can add here,
  and until it exists the feed hash is self-certifying. https and the allowlist
  narrow who can choose the feed; signing is what would make the download itself
  trustworthy.
- **Status**: PASSED

---

### Turn 35/40 - Client UI (the Stream Deck key that never did anything)

Audit finding 5.

- **Tests Added**: `packages/shared/test/streamdeckPlugin.test.ts`, 6 tests over
  the source, the manifest and the built bundle: every `@action`-decorated class
  is registered, registration happens before `connect()`, every declared action
  has a manifest entry, every manifest entry has an action behind it, and the
  bundle Stream Deck actually loads constructs the action by name.
- **Issue/Gap Uncovered**: `streamDeck.connect()` was the plugin's only runtime
  statement. `@action` stamps a UUID onto the class and nothing more;
  `registerAction` is the sole place listeners are attached and `connect()`
  performs no discovery. So `ToggleAction` was never constructed - confirmed in
  the built bundle, where `new ToggleAction` appeared zero times and the only
  two `registerAction` hits were the SDK's own method and its doc comment. The
  key shows up in Stream Deck, and every press does nothing. It has shipped that
  way. The UUIDs did match, so registration was the whole of it.
- **A test of mine that would have lied**: the bundle assertion first matched
  the *shape* `registerAction(new X())`, on the theory that esbuild might rename
  the class. The SDK's doc comment contains
  `registerAction(new MyCustomAction());`, so that regex passed against the
  broken bundle. It now requires the declared class name, and reverting the fix
  turns three tests red instead of one.
- **Enhancement Shipped**: the action is registered before `connect()`, with a
  comment saying why the decorator alone is not enough.
- **Status**: PASSED

---

### Turn 36/40 - Message orchestration (a four-byte frame the hello validator never saw)

Audit finding 18, and like turn 33 it is a correction to my own earlier work.

- **Tests Added**: 16 in `packages/relay/test/hostileRequests.test.ts` plus
  `packages/relay/scripts/frame-probe.cjs`, a real-process probe the suite runs.
  Five bodies that parse cleanly but are not objects - `null`, `123`,
  `"a string"`, `[]`, `true` - against all three socket roles.
- **Issue/Gap Uncovered**: On `/ws/publisher` and `/ws/uplink` the try covers
  only `JSON.parse`; the property read after it sits outside. `JSON.parse("null")`
  succeeds and `msg.type` throws. The `publisherHello` validator I added in turn
  4 runs *after* that read, so it never saw any of this - I hardened the payload
  and left the dereference. `onViewer` keeps its reads inside the try, which is
  what shows the omission was accidental rather than considered.
- **Why "the relay survived" was not good enough**: it survived before the fix
  too. Turn 31 added an `uncaughtException` handler to `cli.ts`, so the
  standalone server logs and carries on - which makes that backstop
  load-bearing rather than belt-and-braces, and makes liveness a useless
  observable. The probe looks for the throw in stderr instead:
  `uncaught: TypeError: Cannot read properties of null (reading 'type')` before,
  nothing after. It matters because the embedded relay in the desktop app never
  goes through `cli.ts` and has no handler at all, so the same frame ends the
  app rather than a request.
- **Enhancement Shipped**: both handlers reject a parsed value that is not an
  object before reading anything off it. Reverting turns the probe red with the
  TypeError named.
- **Status**: PASSED

---

### Turn 37/40 - Resilience & state (one null that ends the app for good)

Audit finding 13.

- **Tests Added**: 7 in `packages/companion/test/config.test.ts` - a null
  `languages` refused in a patch and never persisted, a config that already
  holds one repaired on load, the same for a string, a number, an array and
  half a pair, and other fields left alone when they are null.
- **Issue/Gap Uncovered**: `merge()` skipped only `undefined`. A `null` passed
  that check, failed the `value &&` test on the languages branch, and fell
  through to the wholesale assignment - so `{languages: null}` overwrote the
  default and `persist()` wrote it. Turn 10 added a guard for a top-level `null`
  config; a per-field null sailed past it. The consequence is not a bad session,
  it is a dead app: every later launch runs `boot()` into
  `config.languages.source`, throws before `setView`, `refreshDevices` or any
  timer runs, and there is no `unhandledrejection` handler to notice. The only
  way out is editing the file by hand. Reachable from the control API too, since
  `languages` is a legitimate field and turn 34's allowlist rightly permits it.
- **Enhancement Shipped**: `null` is skipped alongside `undefined`, and a
  `languages` that is not a well-formed pair is rebuilt from the defaults on the
  way through - prevention was not enough on its own, because a file written
  before the guard still has to open. Reverting turns six of the seven red.
- **Status**: PASSED

---

### Turn 38/40 - Resilience & state (an env key that copied itself into the file)

Audit finding 14, and it bears directly on the key rotation done during this
run.

- **Tests Added**: 5 in `packages/companion/test/config.test.ts`: an env-only
  key never written to the file, a key clearable from the app, the environment
  still reaching the app that needs it, a rotated env value not being outranked
  by a stale copy, and a key the user actually saved still winning.
- **Issue/Gap Uncovered**: The env fallback lived inside `merge()`, which
  `update()` runs before `persist()` - so it applied on the *write* path.
  Clearing a key in KEYS sends `""` deliberately; the fallback saw a falsy value
  and put the environment's key straight back, and `persist` wrote it to
  `config.json`. The field refilled itself and there was no way to clear a key
  from the app. Worse, any unrelated save - a `showLatency` toggle, a background
  token sync - copied an env-only secret into the file, where it outlived the
  environment and quietly won over a rotated one. Anyone who rotates their keys
  and finds the old ones still in use is looking at this.
- **Enhancement Shipped**: the fallback moved to `withEnv()`, a read-only view
  applied on the way out. `merge()` and everything `persist()` writes now
  contain only what was actually stored, and `update()` merges into that rather
  than into the env-applied view. Three of the five tests go red on revert.
- **Status**: PASSED

---

### Turn 39/40 - Message orchestration (ids that collided with what was on screen)

Audit finding 12.

- **Tests Added**: `packages/relay/test/segmentIds.test.ts`, 3 tests against a
  real relay and a real viewer socket: numbering continues across a rebuild, no
  id repeats across a stream that rebuilds twice, and a genuinely new publisher
  still starts at 1.
- **Issue/Gap Uncovered**: `segId` is per-`PublisherSession` and `buildSession`
  constructs a fresh one on every publisher hello - which a settings change
  triggers mid-stream, without kicking viewers. Viewers key their caption rows
  by id and nothing tells them to start again, so the new session handed out ids
  already on screen: the next caption rewrote an existing row in place under the
  old line's timestamp, and the line it replaced was gone. Measured against the
  original, a four-caption stream emitted `1, 2, 1, 1` - two distinct ids for
  four captions, so the viewer showed two rows being overwritten.
  Turn 15 tested that ids stay unique *within* a session and never crossed a
  rebuild, which is why it missed this.
- **Enhancement Shipped**: a replacement session is seeded from the outgoing
  one's counter, so numbering continues. Contained to the relay - no protocol
  change and nothing for viewers to learn. Reverting turns two of the three red.
- **Status**: PASSED

---

### Turn 40/40 - Leaving it findable

The last iteration. The most useful thing left was not another fix but making
sure the unfinished work survives the session that found it.

- **Tests Added**: 2 more in `packages/shared/test/handoff.test.ts` - every
  document the handoff points at must exist, and it must still point at both
  the audit and this log.
- **Issue/Gap Uncovered**: The audit existed only in a temp directory and as a
  file sent to the owner. Twenty-eight of its findings are unaddressed, each
  with a failure scenario and a suggested fix, and none of that was in the repo.
  `HANDOFF.md` was nine turns and an entire audit out of date - it still
  described ~280 tests and a fix list that predates everything from turn 31 on.
- **Enhancement Shipped**: `docs/AUDIT-2026-09-05.md` carries the full ranked
  report with a header saying which eight are fixed, which turn fixed each, and
  the two pieces that need a person - code signing, and a credential for the
  control API. `HANDOFF.md` names the branch, what is on it, the six findings
  most worth knowing about, and why `v0.5.2` as tagged must not be pushed as-is.
  The guard keeps both pointers honest.

### Where this run ended up

370 tests where there were none. 35 fixes across 40 turns, 8 of them from the
audit. The verification gate - `pnpm test`, `pnpm typecheck:test`,
`pnpm typecheck`, `pnpm build`, the renderer id check and `pnpm smoke` - passed
at every one of the 40 commits, and now runs in CI and blocks a release.

Four things a future run should take from this, all of them learned the hard
way here:

1. **A test that goes green first time, when you expected red, has probably not
   run.** It happened four times: a debounce that outlasted the assertion, a
   filesystem observable that could not see an open handle, a liveness check
   that an uncaughtException handler had already made meaningless, and a regex
   that matched the SDK's own doc comment. Each looked like a passing test of a
   broken thing.
2. **Fix the shape you can see and an adjacent one usually stays open.** Turn
   4's payload validator ran after the dereference that killed the process.
   Turn 9's redaction masked the token field and left it in the URL. Turn 10's
   guard caught a null config and not a null field. The audit found all three.
3. **Ask what a thing is checking, not whether it is correct.** A skip that
   passed, a version nothing bumped, a menu offering a deleted model, a comment
   claiming a check that was never written.
4. **Liveness is the wrong observable for a crash** once anything catches
   exceptions. Look for the throw.

---

### Turn 41 - Translation pipeline (half a sentence, remembered for half an hour)

The loop's counter and my numbering had drifted by one, so there was another
iteration. Audit finding 16.

- **Tests Added**: 4 in `packages/relay/test/gemini.test.ts` - a cut-off answer
  retried with more room, a fragment never cached when the retry is cut off too,
  a complete answer still cached, and a normal finish reason treated as
  complete.
- **Issue/Gap Uncovered**: `attempt()` never read `finishReason`; the only
  rejection test was `if (!out)`. A 15 s VAD segment is 40-50 words, and
  translated into a token-dense target - Thai, Japanese, Korean, Chinese - it
  runs past `maxOutputTokens: 120`. Gemini answers 200 with partial text and
  `finishReason: MAX_TOKENS`, so the fragment went to viewers mid-clause with
  normal latency and no marker, and into the 30-minute cache - where every
  repeat of that callout got the same fragment without another request.
- **Enhancement Shipped**: the cap is named, a truncated answer is retried once
  with three times the room, and a fragment is returned but never cached. Half a
  line still beats nothing on a live caption; remembering it for half an hour
  does not. Reverting turns two of the four red.
- **Status**: PASSED

### Turn 42 - Client UI (a settings pane nobody could find)

**Found.** There was no "settings" anywhere in the product. The only door into
configuration was a button reading **KEYS**: 10.5px, `--dim`, styled
`.label-btn`, sitting at the far right of the footer between the cost readouts
and the window edge. The pane behind it announced itself as **KEYS & RELAY**.
Behind that credential-shaped word lived every non-credential preference the app
has - LINK MODE, the update feed, auto-update, the local speech-model manager -
while the profanity filter and the latency badges were unlabelled square chips
crammed into the `04 OUTPUT` block header, explained only by `title=` tooltips.
Caption appearance is not in the app at all: it lives on the viewer page behind
an `AA` button which, in OBS, is `opacity: 0` until hover - and a browser source
never hovers. `?settings=1` pins it, and that parameter appears in no UI, no
tooltip and no copied link. Users had to be told where to go.

There is no application menu either (`autoHideMenuBar`, no menu installed), so
File → Preferences does not exist as a fallback.

**Two sweeps, independently.** One walked `AppConfig` field by field asking
where each is editable; one walked the markup control by control asking whether
a streamer could find it. Between them, 34 discoverability gaps. Several are
their own findings and are now in `docs/OPEN-WORK.md`; this turn took the door.

**Changed.**

- The footer control is `SETTINGS`, with a gear, a border and the ink colour -
  a thing that reads as a control rather than as another readout. `Ctrl+,`
  opens it too. Everything in the renderer is now named for what the user calls
  it: `settingsBtn`, `#settings`, `renderSettings()`, `saveSettings()`.
- The pane is two named halves. **WHAT VIEWERS SEE** carries captions, caption
  appearance and the viewer link; **ACCOUNTS & ENGINE** carries the keys and the
  models. LINK MODE was the fifth field of the right-hand column, under PUBLISH
  TOKEN - it is the setting that decides whether an OBS browser source survives
  a restart, and this repo already has a comment recording what a wrong value
  there put on air.
- Relay URL, publish token, public base URL, local port and update feed are
  behind an `ADVANCED` disclosure that ships shut, with a line saying none of it
  is needed to run Relay.
- The two caption toggles moved into the pane with real labels and one line of
  plain English each.
- `OPEN CAPTION VIEW` opens the viewer's own display screen with `?settings=1`,
  which is the only route to the OBS overlay's appearance settings that does not
  involve editing a URL by hand.

**A defect the move exposed.** Both toggles ship in the publisher `hello`, so a
running session cannot pick either up - which is why both handlers `return`
early while live. That was survivable as an unlabelled chip and is not in a pane
called SETTINGS: click HIDE SWEARING mid-match and nothing moves, with no
message. They are now disabled while live with the reason on screen.

**Guards - all four watched fail first.** `apps/standalone/test/renderer.test.ts`,
`finding the settings`. Reverting each fix on its own turns exactly its own
guard red: the old `KEYS` label; the toggles back in the `04 OUTPUT` header; the
disclosure shipped `open`; the caption-view route removed. A script drove each
revert and asserted the run was red **and** that the filter actually matched a
test, because a `-t` typo produces "no tests" and exits zero, which reads as a
pass.

**Verified in a browser**, not only in happy-dom: the shipped `dist/renderer`
served with the preload bridge stubbed, driven against `scripts/mock-relay.mjs`
with a synthetic `MediaStream` standing in for a microphone. A real session went
ON AIR with captions flowing, and the live lock was observed in that state -
both toggles disabled, the reason visible, the caption-view button live with a
real link. The wider footer chip pushed the link row into the cost figures at
1000px, so the breakpoint that hides those figures moved from 900 to 1080.

**Not verified:** the Electron build itself. Everything here is renderer markup,
CSS and DOM code exercised through the real `app.ts`, but the packaged app was
not launched.

### Turn 43 - Stream & audio transport (three sources, not two)

**Asked for.** Multi-channel STT: several sources, isolated, used how the
streamer wants. Scope settled with the user - up to **three**, each carrying its
own identity into **one** tagged viewer feed. Not a link per source, not an
engine per source.

**What the stack already did.** Three sweeps of the audio path, one per layer,
before touching anything. Most of it is already general over N and has been all
along:

- `capture/index.ts` builds the graph from `streams.length` - a `ChannelMerger`
  sized to the source count, one input per source, one `AudioContext` so every
  lane shares a clock. Nothing there needed changing.
- `SpeakerTag { channel?: number; speaker?: string }` is unbounded already.
- `session.ts` keys interim ids by channel and tags each caption through
  `tag(channel)`; the uplink carries finished subtitles and never sees a channel
  count at all.
- Deepgram costs **no extra socket**: one connection with `multichannel=true`
  and `channels=n`. Local STT costs **no extra worker thread**: one worker with
  per-channel state inside it.

So this was not a rewrite. It was four hard stops:

| Where | The stop |
|---|---|
| `shared/src/index.ts` | `clampChannels(n): 1 \| 2` - and the return **type** capped it independently of the body |
| `shared/src/index.ts` | the publisher hello's own `channels?: 1 \| 2` |
| `capture/index.ts` | `.slice(0, 2)`, truncating silently before a stream is opened |
| `capture/workletSource.ts` | `Math.min(2, ...)` plus a resampler hand-unrolled for exactly two lanes (`a`, `b`, two `prev` slots, two stores) |

`MAX_CAPTURE_CHANNELS = 3` now lives in `shared` and every one of those reads
it, including the worklet - which is a template string, so the cap is
interpolated into it rather than written twice. If the worklet and the hello
ever disagreed the relay would re-cut the frame on the wrong stride and every
lane after the first would carry a different voice on every frame, which decodes
to fluent speech and sounds like nothing is wrong.

`clampChannels` still collapses an **over**-count to mono rather than rounding
it down to the cap, and there is now a test saying why: the number is not a
preference, it is how many samples each frame holds.

**A bug the third channel would have shipped.** The 01 SOURCE level meter walked
the frame with a stride of 3, commented "odd stride so interleaved stereo frames
feed both channels into the meter". That holds only while the stride and the
channel count share no factor. At three sources a stride of three lands on
channel 0 every time: the meter moves convincingly and two of the three are
invisible in it. No crash, no log line. It reads every sample now - 4800 per
100 ms frame, which is not a cost worth being wrong for.

**Guards, each watched fail against its own revert.** `clampChannels(3)` back to
1; the worklet clamp back to 2; the capture slice back to 2; the meter back to a
stride of 3. The source-list rule moved out of `start()` into `captureSources()`
to be reachable at all - `start()` wants an `AudioContext`, an `AudioWorklet`
and a real `getUserMedia`, so the only previous way to cover it was to rewrite
it in a test and check the rewrite.

**The one the tests could not have caught.** `@callout-relay/companion` has two
entry points, and `package.json` maps the default to `dist/browser.js` for
bundlers. The renderer is bundled for the browser, so it loads that one; vitest
loads the other. `rmsLevel` was exported from `src/index.ts` and not from
`src/browser.ts`: it typechecked, it built, all 504 tests passed, and the meter
read a flat zero through a live session. Only the browser showed it, and only
because the pre-change build was rebuilt from `git show HEAD:` and run side by
side on the same synthetic stream - 11 bars lit against 0.
`packages/shared/test/browserEntry.test.ts` now resolves every name the renderer
imports against the browser barrel, and names the missing one when it fails.

**Verified in a browser**: a live session on the mock relay with a resumed
`AudioContext` feeding a synthetic `MediaStream`; meter reads 11 of 12 bars,
identical to the pre-change build.

**Not verified:** three sources end to end. Nothing in the UI can select a third
yet - that is the next turn, and it needs a config shape, `CONTROL_PATCHABLE_KEYS`,
the two hard-coded `<select>` slots in the markup, and `channelLabels()`, which
returns a two-element literal and has no answer for what channel three is
called.

### Turn 44 - Client UI (picking and naming three sources)

Turn 43 made the pipeline carry three channels. Nothing in the app could choose
a third, so this is the half a user can see.

**The config shape.** `sources: string[]` is the truth now, with
`sourceLabels: string[]` beside it. `audioSource` / `audioSource2` stay, marked
deprecated, because deleting them would break two things at once: every
`config.json` already on disk, and the Stream Deck property inspector, which
patches those two names through the control API and knows nothing about a list.

`resolveSourceIds()` reads the list when there is one and folds in the pair when
there is not - that order matters, because preferring the pair would drop a
third source every time a Stream Deck key was pressed.

**A legacy patch names a slot, not the list.** That question only surfaced
because the test was written first. The first version asserted that patching
`audioSource` collapsed the config back to one source, which is what a naive
fold does - and it is wrong. An old client patching slot 0 is saying "slot 0 is
this"; it has no idea a third slot exists, so it cannot be asking to delete one.
`syncSources()` applies the slots a legacy patch names and leaves the rest, then
mirrors the first two back onto the pair so an older build still sees something.

**The tag rule moved into `shared` and grew a third case.** It was structurally
binary: it compared `kinds[0]` against `kinds[1]` and returned the literal
`["YOU", "CHAT"]`, so a three-channel session got a two-long array and the relay
fell through to `CH3`. The two-source behaviour is unchanged and pinned by tests
saying so. Past the second slot there is no role left to derive - two
microphones are two microphones, and nothing in a device list says which one is
the coach - so the third defaults to its slot number and the streamer names it.
That is the whole reason `sourceLabels` exists, and why the field shows the tag
it will otherwise carry as its placeholder rather than a blank.

Names ship in the publisher hello like the caption toggles, so they carry the
same live lock and the same sentence.

**The bug only the browser found.** The renderer computed
`const channels = sources.length === 2 ? 2 : 1`. Three sources therefore
announced **one** channel while capture opened three lanes, and the relay would
have re-cut every frame on the wrong stride - which decodes to fluent speech
from the wrong people. It never got that far: `if (capture.channels !== channels)`
turned it into a clean refusal to start. That check earned its keep today.

There is no unit test for that call site - it needs an `AudioContext` and a live
relay. What is pinned instead is the contract the two sides now share, that
`clampChannels(captureSources(ids).length)` equals the number of lanes actually
opened, for every count the app can produce. The call site itself was caught in
a browser and is verified there, not in the suite. Said plainly because it
matters.

**Guards - six, each watched fail against its own revert:** the third picker
removed from the chain; saving one named field per picker instead of the list;
the third name field removed; the two-element tag literal restored; the empty-slot
rows shown; and the legacy fold disabled.

The proof harness itself was wrong first. A revert that failed to typecheck was
being reported as GREEN, because the build error was caught by the same `catch`
that catches a failing test and then found no "Tests" line to read. That is
lesson 1 from this file in a new costume - a run that proves nothing looks
exactly like a run that proves the fix. It now reports a build failure as its own
outcome.

**Verified in a browser, end to end.** Three devices enumerated, three slots
picked, the third named COACH in SETTINGS, then a live session against
`scripts/mock-relay.mjs`. The relay logged
`publisher session: ... (3 channels: YOU/CHAT/COACH)` and
`stt open (deepgram-nova-3, en, 3 channels)`, and captions arrived tagged YOU,
CHAT and COACH.

That run also caught a **stale process**: the mock relay still running from an
earlier session had the old `clampChannels`, so it read three channels as mono
and stripped every speaker tag. The relay was restarted on the new build before
anything was believed.

**Known gap, next.** `isOtherSpeaker()` is binary - `YOU` versus everyone else -
so on the stage and in the viewer, CHAT and COACH are the same colour. Three
speakers are tagged but only two are distinguishable at a glance.

### Turn 45 - Client UI (a colour per speaker, chosen by the streamer)

Turn 44 left three speakers tagged and only two of them distinguishable. The
tag colour was one binary class - `YOU` against everyone else - in both the
desktop console and the viewer, so `CHAT` and `COACH` came out identical. Asked
for directly: make them editable.

**The colour is the streamer's, not the viewer's.** Caption size, font and theme
belong to the device watching; who is speaking does not. So it sits beside the
name in SETTINGS, travels in the publisher hello, and reaches every viewer.
`sourceColors` in the config, `channelColors` on the wire, `color` on each
`SpeakerTag`. Defaults are distinct per slot so three speakers differ untouched.

**It is untrusted input on its way into CSS.** On the embedded relay the
publisher is this app; on a hosted one it is whoever holds a publish token. The
relay drops anything that is not plainly `#rrggbb` rather than escaping it, and
the viewer does the same again on the way into the DOM.

**A test of mine that proved nothing.** The first viewer guard pushed
`color: "red; background: url(javascript:alert(1))"` and asserted no
`background` appeared. It passed against the reverted sanitiser too - because
assigning to `.style.color` makes the CSSOM reject the whole value on its own.
It was testing the DOM, not the code. The real protection is *assigning the
property rather than building a `style` attribute*, so that is what is asserted
now, and reverting to `setAttribute("style", ...)` turns it red. The sanitiser
gets its own, honest guard: a non-hex value must leave the class fallback doing
the work rather than half-applying something the publisher named.

**The bug the browser found again.** Everything was right - the hello carried
the colours, the relay broadcast them, viewers painted them - and the desktop
console still showed grey tags. `relayClient.ts` rebuilds each message field by
field, and `color` was simply not in the list. The callback type is
`{...} & SpeakerTag`, so widening `SpeakerTag` looked sufficient; an object
literal missing an optional field typechecks fine. Nothing in the suite could
see it, because the only thing downstream of that function is the renderer.
There is a guard now, against a real WebSocket server, asserting the whole tag
comes through rather than naming one field.

**Guards - seven, each watched fail against its own revert:** `safeSpeakerColor`
accepting any string; the relay passing colours through unsanitised; the session
omitting the colour; that omission seen end to end from a viewer socket; the
viewer not painting; the viewer trusting any string; and the viewer building a
`style` attribute instead of assigning the property.

**Verified in a browser, end to end**: three sources picked, the third named
COACH and its swatch set to `#ff5f9e`, then a live session. The desktop stage
showed YOU amber, CHAT blue, COACH pink; the viewer page at
`/watch/<token>` showed the same three. Read off the live DOM, not inferred.

The mock relay had to be restarted twice during this run - a process started
before a rebuild still had the old `clampChannels` and read three channels as
mono, stripping every tag. Worth remembering: a stale relay looks exactly like a
broken feature.

### Turn 46 - Client UI (audit finding 10: ENDED on the broadcast)

The only finding in the audit that an audience can see, and it fires on the
default settings.

`kicked` called `showScreen("ended")` with no `?obs=1` guard, and the OBS rules
hide the HUD and the non-latest rows but nothing else - there was no
`body.obs #ended`. So with `linkMode: "unique"` (the default), every press of
START rotated the viewer token, the rotation kicked the overlay, and the browser
source composited **THIS LINK HAS ENDED**, a line of explanation and a solid
TRY AGAIN button onto the live stream. It stayed there until someone refreshed
the source. Mid-stream, when a second device opened the link, the same panel
appeared and its text was also factually wrong.

`showScreen` now blanks everything when the overlay is the one being kicked -
the panel, the captions, all of it - so an overlay that has lost its link
disappears instead of announcing itself. A phone viewer still gets the panel;
that is the whole point of it. `body.obs #ended { display: none !important }`
backs it up in CSS.

**Guards, watched fail:** the overlay showing nothing on a kick, and the phone
still showing the panel. Reverting the guard turns the first red and leaves the
second green, which is the pair that matters - a fix that blanked both would
have been a different bug.

A third assertion was written and then deleted rather than kept. It checked
`checkVisibility()` on the surviving row, which in happy-dom ignores an
ancestor's `hidden` attribute - so it was reporting on the DOM implementation,
not on this code. The first test already covers `#live` being hidden, which is
what actually blanks the overlay.

**Verified in a browser against a real kick**, not a simulated one: an overlay
on `/watch/<token>?obs=1` showing live captions, then
`POST /admin/rotate-viewer-token` with the publisher's bearer token. The overlay
went to `live`, `display` and `ended` all hidden, body text empty - a blank
transparent page. Screenshot before and after.

**Noticed while verifying, not fixed:** a phone viewer who *loads* a dead link
gets `RECONNECTING` forever rather than the ENDED panel, because a rejected
socket is not the same path as a `kicked` message. Different defect, adjacent to
audit finding 9. Written down rather than folded in.

### Turn 47 - Message orchestration (audit finding 11: a dead pipeline that says it is live)

The failure shape the audit calls the worst one for a live tool: the app claims
to be working while producing nothing.

When the STT socket closed on its own - a Deepgram 1011, a quota, an idle
timeout - `onClose` logged a line, told viewers `live: false`, and called
`setLive(false)`, which at the server was **`() => {}`**. Nothing reached the
publisher app, because `onSttError` was wired to `onError` and never to
`onClose`. `isLive()` was pure socket presence, so `/health` and every viewer
`hello` went on saying live. And `audio()` billed the chunk *before* handing it
to a stream whose `readyState` guard was dropping it, so billed seconds kept
accruing for audio that never left the process.

The app's own socket to the relay is untouched by any of this. That is why
nothing noticed: the desktop stayed ON AIR with the clock running.

**Three changes, one story - the pipeline is gone, so stop pretending:**

1. `onClose` now calls `onSttError` as well, so the failure reaches the app's
   log instead of the Electron main-process console, which is invisible in a
   packaged build.
2. `setLive` at the server is real, and `isLive()` is
   `(publisher !== null && sttLive) || uplink !== null`. An uplink carries
   finished subtitles and has no STT of its own, so it stays live on its own
   terms. A rebuilt session resets the flag.
3. `SttStream.sendAudio` returns whether the chunk actually went to the engine,
   and `audio()` bills only what was sent. Deepgram, the mock, the local worker
   and the two failure stubs all answer it honestly.

**A seam, added deliberately.** There was no way to reach the close path from a
test: `mockStt` never closes, so the only route was to dial the real Deepgram
from a test and hope it hung up. `SessionDeps.makeStt` supplies the socket and
nothing else - every decision the session makes about a dead stream stays real.
It is the same shape as the existing `translator` and `localStt` deps, and
`startRelay` takes it too, which is what makes the end-to-end test possible.

**Guards - seven, each watched fail against its own revert.** Three at the
session (the app is told, viewers are told, billing stops) and four at the
server, from the outside: `/health` live while up, not live once the pipeline
dies, a viewer joining afterwards told `live: false` rather than shown ON AIR
forever, and live again on a fresh session.

One of those nearly proved nothing. The first version of the billing test used a
fake whose `sendAudio` always returned true, including after its own close - so
it would have passed against the unfixed code. A fake that keeps accepting
audio after the socket is gone is not a fake of a socket.

The viewer test also had to attach its listener before the socket opened: the
connect `hello` is sent the instant the socket is accepted, and the file's own
`waitFor()` helper attaches after `open` resolves, so it missed it every time.
That looked exactly like "no hello is sent".

**Still open from finding 11**, deliberately not folded in: no reconnect ladder
for the Deepgram socket, and the heartbeat still pings without tracking pongs or
calling `terminate()`, so a half-open publisher holds a session for minutes.
Both are their own turn.

**Not verified in a browser.** Nothing here changes a pixel - it changes what
`/health` and a viewer `hello` say, which the tests read directly off a real
relay over real sockets.

### Turn 48 - Stream & audio transport (audit finding 21: a device that goes away)

The other half of "a dead session that reports itself live", from the capture
end rather than the relay end.

No `ended` listener existed anywhere in the companion package, and
`get capturing()` returned the `active` flag - which only ever means "start()
ran and stop() has not". So unplugging a USB headset mid-game ended its track,
its merger input fed digital silence, and everything downstream carried on: the
app stayed LIVE with the clock running, full-rate interleaved PCM kept flowing
so the engine kept billing at the full channel rate, and that speaker's captions
simply stopped. The surviving channel kept the level bar moving. Nothing on
screen hinted at it, and recovery was a manual restart.

**What changed.** `watchSourceTracks()` attaches an `ended` listener per slot
and reports which slot went and how many are left. A track that has *already*
ended is reported immediately - `ended` fired before anyone was listening and
never fires twice, and a device can go between `getUserMedia` resolving and the
graph being wired. `capturing` now means a track is actually live.

The app names the device in its log, marks the slot in the 01 SOURCE meta -
`YOU + CHAT LOST + CH3` - and, when the last source goes, stops the session and
says so rather than sitting there ON AIR.

**Guards - three, each watched fail against its own revert:** the `ended`
listener removed, the already-ended case removed, and `capturing` back to the
flag.

That third one caught a hole in my own test. It first exercised `anyTrackLive()`
directly, so reverting the *getter* left it green - the guard covered the helper
and not the thing the finding is about. It now sets the state `start()` would
have left and reads the shipped getter. White-box, and said so in the test,
because the alternative was an assertion that could not fail.

**Verified in a browser**, with a distinct live MediaStream per device so one
could be pulled on its own:

- pull slot 2 → `Wave Link chat disconnected - that source has stopped
  captioning`, the meta reads `YOU + CHAT LOST + CH3`, session stays live and
  the other two keep captioning;
- pull the rest → `Coach line disconnected - no audio sources left, stopping the
  session`, status ERROR, `every audio source disconnected` on the stage.

Before this, every one of those was silent.

### Turn 49 - Message orchestration (a mint endpoint with no limit)

One of the two gates on handing the hosted relay's URL to anyone else.

`POST /claim` mints a room for whoever asks. The rooms are worthless without
their secrets and an idle one costs nothing, which is why this was survivable
while the URL was unadvertised - and exactly why it had to close before it was
not.

**The limit is the platform's, not the Worker's.** `src/index.ts` holds no state
by design, and that rule is load-bearing: the single-tenant relay's bugs at
tenant scale are all module-scope singletons. A counter up there would also be
per-isolate and per-colo, which is to say not a limit at all. So it is a
`[[ratelimits]]` binding - five a minute per address. A streamer claims one room
ever and the app claims one on first run, so five leaves room for a retry and a
second machine and no room for a script.

**Checked before the room id is minted**, and before any Durable Object is
addressed. A refused claim has to cost nothing, and an object that runs is an
object that bills. There is a test for exactly that, because doing the check one
line later would look identical and quietly bill for every rejection.

**Keyed on `CF-Connecting-IP` and nothing else.** Cloudflare writes that header
on every request and overwrites whatever the caller sent; `X-Forwarded-For` is
just a string the client typed. Keying on the second would hand every caller
their own private bucket and the limit would count to one forever. Where there
is no address at all - `wrangler dev`, a test - everyone shares one bucket,
because a unique key per request is not a limit either.

The binding is optional in `Env`, so the service still runs locally with nothing
bound. That is also the honest description of production until this is deployed.

**Guards - three, each watched fail against its own revert:** the check removed,
the check moved after the room is created, and the forwarded-for header trusted.
They drive the real `fetch` with the binding stood in for, so the decision under
test is the shipped one.

**Not done here:** the other gate. Billed Durable Object duration for an hour of
live room is still unmeasured, and it cannot be measured by writing code - it
needs a real stream held open for an hour and a look at the Workers dashboard.
Left as it was, with the reason written down rather than quietly dropped.

**Deployed, and then measured** (same turn, after the commit above). The binding
came up as `env.CLAIM_LIMIT (5 requests/60s)`, and both verification scripts were
re-run against `relay.supr.systems`: `verify-deploy` 14/14, `verify-isolation`
9/9. The relay reported `live:false, viewers:0` first, so nothing was cut off.

Then the limit itself was checked, and the first seven claims all returned 200.
That is not the limit failing - Cloudflare documents this API as "permissive,
eventually consistent, and intentionally designed to not be used as an accurate
accounting system", with counters cached per location and reconciled
asynchronously. Under sustained pressure it does engage: **the 25th sequential
claim was the first 429.**

Worth writing down exactly, because "5 requests/60s" in the deploy output reads
like a promise it does not make. It caps sustained abuse and will not stop a
burst - which is a fair trade for rooms that are worthless without their secrets
and free when idle, and a bad thing to misremember later. An exact limit would
need a Durable Object counter on the claim path: an invocation per claim, to
protect something that costs nothing.

The ~24 rooms that measurement minted joined the un-reaped pile the README
already lists.

### Turn 50 - Client UI (audit finding 7: a source whose device is gone)

The trap: everything on screen says there is no second source, and START fails
anyway, every time, with one word.

`fillSelect` never sets `selected` when nothing matches, so a configured id that
is no longer enumerated left the box on index 0 - "No second source" - while the
config still held the dead id. `activeSources()` reads the config, not the
select, so START opened the missing device with `deviceId: { exact: ... }`. And
because the select's value was *already* `""`, choosing "No second source" fired
no `change` event: the one path that could have cleared it never ran. The user
could not fix it from the UI at all.

The error text made it worse. It was `String(err.message || err)`, and Chromium
leaves `OverconstrainedError.message` **empty** - so the banner read exactly
`OverconstrainedError`, naming neither the slot nor the device nor the
constraint, with `err.constraint` sitting in scope unread.

**Both halves.** `refreshDevices` now drops any configured source that is not in
the enumerated list and says which slot went - the same correction `boot()`
already makes for a model that has left the catalogue. Not while live: dropping
a slot mid-session would change the channel count under a running publisher, and
a device lost *during* a session is finding 21's job, done last turn.
`captureErrorText` turns the error into something that names what to do.

**Where it lives matters.** `captureErrorText` was written in the renderer, where
no test can reach it, and moved into `capture/` before it was believed - the
same seam as `rmsLevel` and `captureSources`, exported from both barrels (the
browser-entry guard would have caught it otherwise, which is what that guard is
for).

**Guards - five, three of them watched fail against their own revert:** the drop
removed, the log line removed, and the `OverconstrainedError` branch removed
(which returns the string `OverconstrainedError`, exactly the old symptom). Two
more are invariants that must stay green: a live pair is not rewritten, and the
built-in `system-loopback` is not mistaken for a dead device.

The third revert had to be done by hand. The scripted one deleted a `return` and
left the code after it unreachable, so it failed to compile - and a revert that
does not compile proves nothing, which is the trap the harness was taught to
report two turns ago.

**Not verified in a browser.** The failing path needs a device that enumerates
once and then does not, which the harness cannot produce; the DOM-level guards
boot the real renderer against a device list that is missing an id, which is the
same condition.

### Turn 51 - Stream & audio transport (audit finding 23: no anti-alias filter)

One line, and it degraded every session this app has ever run.

`new AudioContext()` took no options, so the graph ran at the device rate and
the worklet dropped to 16 kHz by linear interpolation with a one-sample history.
At the common 48 kHz the step is exactly 3 and the interpolation weight is
identically **zero** - so it was not interpolation at all, it was pure
decimation with no filter in front of it.

**Measured against the shipped worklet source rather than taken on report:**

```
48000 Hz in -> 16000 Hz out, 12000 Hz tone
   4000 Hz  amplitude 1.000  (-0.0 dB)
   2000 Hz  amplitude 0.000  (-84.1 dB)
   6000 Hz  amplitude 0.000  (-84.1 dB)
```

A 12 kHz tone arrives as a 4 kHz tone at full amplitude. Everything from 8-24
kHz folds into the 0-8 kHz band the acoustic model reads: game transients land
on the formant region, sibilance smears onto its own aliases.

`new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })` makes Chromium resample
with its own windowed-sinc filter before the worklet sees anything, and the
worklet's step becomes 1 - a case the existing
`[16000, "no resampling at all"]` test already covers.

**Reaching `start()` at all.** This is the first test that runs it. It needs an
`AudioContext`, an `AudioWorkletNode`, `URL.createObjectURL`, `Blob` and a
`getUserMedia`, so the Web Audio API is stood in for - which is standing in for
the browser, not for the thing under test, the same way the renderer's tests run
against happy-dom. What it checks is this package's own graph construction. It
also, for the first time, covers the merger wiring: three sources land on
merger inputs 0, 1 and 2, and the worklet is told three lanes.

`navigator` is a getter-only global in node and has to be `defineProperty`'d,
not assigned; assigning throws and every test in the block failed identically
before that was fixed.

**Guard watched fail**: reverting to `new AudioContext()` turns it red on
`expected undefined to be 16000`.

**What this does not fix.** The worklet itself is still a decimator if anything
ever feeds it a higher rate - the measurement above is of the shipped worklet
and stays true. What changed is that the app no longer asks it to do the rate
conversion. A real filter in the worklet would be a different, larger change,
and is not needed while the context is asked for the right rate.

### Turn 52 - Client UI (audit finding 9: the reconnect that kills the live socket)

The other one an audience sees, and the sibling of finding 10 - both put THIS
LINK HAS ENDED on a session that is still running.

`connect()` had no re-entrancy guard, did not cancel the armed 2 s retry, and
every handler acted on the module-level `ws` rather than on the socket that
raised the event. A phone's socket drops and arms a retry; the user unlocks the
phone inside that window, `visibilitychange` calls `connect()` (socket B), and
then the timer fires and `connect()` runs again (socket C, `ws = C`). The relay
allows one viewer per token, so it kicks B - and **B's still-bound handler**
sets `closedByKick`, shows ENDED, and calls `ws.close()`, which by then means
**C**, the healthy one. A live session goes dark until the page is reloaded.

Separately, `visibilitychange` cleared `closedByKick` unconditionally, so a
genuinely rotated token restarted a flat 2 s reconnect loop against a dead
token, forever, every time the phone was unlocked.

**Fixed the way `cc824dd` fixed `relayClient` and `uplinkClient`:** cancel the
armed retry, drop any socket already open, capture the socket in a local, and
give every handler a `current()` check before it acts. `closedByKick` is only
cleared by TRY AGAIN, which reloads the page - the user actually asking.

**Guards - four, three watched fail against their own reverts.** The fourth is
the invariant that a kick on the LIVE socket must still end the session; a fix
that ignored every kick would be a different bug.

**One of those guards did not guard.** It first counted *live* sockets, and went
green against the reverted `clearTimeout` - because `connect()` now closes the
previous socket, so a third socket still leaves exactly one alive. It was
measuring the symptom the other half of the fix already covers. It counts
sockets *created* now, which is what the cancelled retry actually prevents, and
reverting turns it red on `expected 3 to be 2`.

That is the fourth time in this session a test has passed against code it was
written to catch. The pattern each time: the assertion was one level away from
the change.

### Turn 53 - Measuring what a live room actually costs

The second sharing gate, and the one the board said could change the plan. It
could not be answered by reading code, so it was not.

`scripts/measure-cost.cjs` claims a room, attaches an uplink and a viewer,
publishes a caption every 2.5 s - a dense stream - and prints the exact UTC
window. `scripts/read-cost.cjs` reads that window back from the GraphQL
analytics API. **22 minutes, 527 captions sent, 527 received at the viewer.**

Units were not guessed. GraphQL introspection on
`AccountDurableObjectsPeriodicGroupsSum` says `activeTime` is microseconds and
**`duration` is GB\*s** - the billed quantity itself - so the script reads
`duration` rather than converting something and hoping.

| per hour of live room | measured |
|---|---|
| captions | 1,436 |
| billed requests | 1,597 |
| billed duration | **3.83 GB-s** |
| active time | 30 s |

An idle hour on the same account measured 0.04 GB-s, so essentially all of that
is the room.

**Hibernation works, and it works so well that it answered a different question
than the one that matters.** The design comment in `room.ts` says hibernation is
the whole design because a four-hour stream would otherwise be billed for four
hours of compute. That is right, and the result is 30 seconds of active time per
hour. Against the free plan's 13,000 GB-s/day that is **3,400 room-hours a
day**. The premise holds: hosting friends is effectively free.

**But the binding constraint turned out to be requests, not duration.** Every
inbound WebSocket message on a hibernating object is a billed request, so each
caption is a request. 1,597/hr against 100,000/day is **63 room-hours a day** -
two or three people streaming a full evening. Duration allows fifty times more
than that.

So the answer to "is hosting others viable" is yes, and the number to watch is
the one nobody was watching. On Workers Paid the included million requests is
~626 room-hours a month, and beyond that the entire cost is about **$0.29 per
1,000 room-hours**. The lever, if it is ever needed, is batching or debouncing
captions - nothing to do with hibernation.

**Read the credential, did not print it.** The analytics query uses
`CLOUDFLARE_API_TOKEN` if set, otherwise the OAuth token wrangler already stores
on this machine - the same credential `wrangler deploy` used earlier, for a
read-only query.

**No guard test.** There is nothing here to regress: two operational scripts and
a number written down. What would rot is the number, and the way to keep it
honest is to re-run the two scripts, which is why they are committed rather than
thrown away.

### Turn 54 - Resilience & state (audit finding 6: a save that bricks the app and says it worked)

The audit calls this "six defects, one incident", and the entry point is typing
`3000` into LOCAL PORT - a port another dev server on the same machine already
owns.

`applyConfig` calls `configStore.update(patch)` - a synchronous `writeFileSync`
- **before** `await restartEmbeddedRelay()`. The restart closes the working
relay and sets it to `null` before it knows the replacement can bind, with no
rollback. `server.listen` rejects with EADDRINUSE, `applyConfig` throws, and the
renderer swallows it into one log line and then unconditionally runs
`log("keys & relay saved", "ok")` and `setView("stage")`.

From then on `publisherWsUrl()` is `undefined` and every START fails with "local
relay not ready". A relaunch re-reads the persisted `3000` and fails identically.
One typo, permanently dead app, reported as success.

**Three changes, three different reasons:**

- **`validRelayPort()`** - the input's `min`/`max` are inert (no `<form>`,
  nothing calls `checkValidity()`), so the port was `Number(value) || 8787` and
  `0`, `-1` and `70000` all sailed through. It is checked now *before the patch
  is built*, because the write happens before the restart is attempted.
- **`relayRollbackPatch()`** - puts the relay fields back when a restart fails,
  and only the relay fields. The same save can carry a language change and a
  port change; reverting the language because the port failed would be its own
  bug. A field that was *cleared* comes back as `""`, not `undefined`, because
  `ConfigStore.merge` skips `undefined` and the bad value would simply stay.
- **`saveAndApply` returns whether it worked**, and `saveSettings` only reports
  success and closes the panel when it did.

`main.ts` now catches the failed restart, rolls back, restarts on the old
settings, tells the renderer, and rethrows.

**Guards - five, each watched fail against its own revert.** Two in the renderer
(saying saved anyway, closing the panel anyway), one on the port check, and two
on the pure helpers.

**What is and is not covered.** `main.ts` imports Electron and is not reachable
from the suite, so the rollback *glue* has no test - what is tested is the two
pure functions it is built from and the renderer behaviour on the other side of
the IPC. Said plainly rather than implied: the try/catch itself was read, not
executed.

**Verified in a browser.** `70000` into LOCAL PORT and SAVE: `local port must be
a number between 1024 and 65535 - "70000" is not`, the panel stays open, and
focus lands on the offending field. `8787` and SAVE: `settings saved`, panel
closes. Before this, the first of those wrote the bad port and closed the panel
saying it had worked.

### Turn 55 - Message orchestration (audit finding 20: the wrong link handed to a friend)

Small, and it matters more now that the point of the last few turns is being
able to share a link.

`localViewerUrl()` hardcoded the OBS flavour - `relay.viewerUrl(token, true)` -
and `viewerUrl()`'s fallback returned it unchanged. The desktop footer strips
`?obs=1` itself; the tray and the Stream Deck property inspector do not.

So on a **fresh install** - `output: "phone"`, no relay URL, which is the
documented default - the phone link is undefined and the fallback handed out
`http://192.168.x.x:8787/watch/T?obs=1`. The recipient opened the overlay
variant on a phone: transparent body, white text, no HUD, every history row
hidden, no display settings. One line at a time on the browser's own
background, and nothing anywhere to say why.

`viewerLinkFor()` in `shared` decides it now, and the rule it encodes is that
**the overlay flavour is never a fallback**. It is right only when the output IS
the overlay; where there is no plain link, undefined is better than a link that
renders wrong. `localViewerUrl(obs)` takes the flavour as an argument.

**Guard watched fail**: reverting the fallback to `obsUrl` turns three of the
six red, including the fresh-install case, on
`expected 'http://192.168.1.5:8787/watch/T?obs=1' to be 'http://192.168.1.5:8787/watch/T'`.

**Not verified in a browser.** The consumers are the tray menu and the Stream
Deck property inspector, neither of which the renderer harness can reach - the
Stream Deck also needs hardware, which is why audit finding 3 is blocked. What
was checked in a browser earlier this session is the other half: the plain
`/watch/<token>` does render the phone page, and `?obs=1` the overlay.

### Turn 56 - Translation pipeline (audit finding 22: a translator that quietly stops)

`geminiErrorLogged` was a boolean that latched for the life of the session and
was never reset, and `SessionDeps` had no publisher-facing hook for translation
errors at all - unlike `onSttError`, which has had one all along.

Minute 1: one transient 503 exhausts the retries and burns the latch. One line
goes to the Electron main-process console, which in a packaged build goes
nowhere - `log()` is `console.log`/`console.error` and is never forwarded to the
renderer's LOG pane. Minute 40: the Gemini quota is hit, every `translate()`
rejects, and the latch swallows all of it. Viewers keep getting source-only
subtitles whose target half sits on the "…" placeholder forever. A revoked key
and a safety-blocked response are equally silent.

The latch became a **timestamp**: `lastTranslateErrorAt`, reported at most once
every 30 s. Long enough that a flapping translator does not fill the log, short
enough that a wall hit mid-session is reported rather than swallowed by a
transient failure from minute 1. `onTranslateError` goes to the same
`sendPublisher({type:"error"})` channel as `onSttError`, so it lands in the log
pane the user can actually open.

**Guards - four, two watched fail against their own reverts** (the hook removed;
the timestamp back to a latch). The other two are the invariants: not every
failure is reported, and a working translator says nothing.

**A test that would have proved nothing.** The first version of the latch guard
ran four utterances over about 200 ms of real time - well inside the 30 s
reporting interval, so it saw exactly one report whether the latch was there or
not. Reporting is rate-limited by wall clock, so the clock is what has to move:
`Date.now` is stubbed and advanced 40 s between utterances. Without that the
test passes against the unfixed code, which is the fifth time this session.
