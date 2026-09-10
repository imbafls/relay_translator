# CLAUDE.md — Callout Relay

Read this first. It is the orientation document for a session working in this
repo. `README.md` is the product, `DESIGN.md` is the UI spec, `HANDOFF.md` is a
point-in-time handoff (partly stale — see below), `docs/OPEN-WORK.md` is the
consolidated backlog, `ITERATION_LOG.md` is the history of what was found and
fixed.

Everything here was verified against the tree at v0.8.0. Where a claim could not
be verified from this machine it says so.

---

## What this is

Real-time game comms translation. Audio is captured on a Windows desktop,
transcribed (Deepgram cloud STT, or sherpa-onnx locally), translated (Gemini),
and pushed as subtitles to a friend's phone or an OBS browser source.

pnpm monorepo, TypeScript throughout, Node >= 20. Root package is
`callout-relay`, private, version `0.8.0` — every workspace package carries the
same version and a guard test enforces that.

## The two relays — read this before debugging anything network-shaped

**This is the single biggest source of wasted time in this project.** There are
two different things called "the relay".

**1. The embedded relay.** The desktop app always starts one locally, default
port **8787** (`relayPort` in config, `RELAY_PORT` env, `packages/shared/src/index.ts`
default). It does the real work: STT, translation, and serving the viewer page
at `/watch/<token>`. It serves **LAN and OBS viewers**. It needs no
configuration and works out of the box on a fresh install.

**2. The uplink to a remote relay.** Optional. Mirrors **already-finished
subtitles** to a remote relay (the hosted Worker at `textrelay.cc`) so viewers on
the internet — a phone not on your LAN — can watch. The remote relay does
**no STT and no translation**. It is pure fan-out.

The uplink is gated in `startUplink()` at `apps/standalone/src/main.ts`:

```ts
if (!cfg.relayUrl || !cfg.publisherToken || !relay) {
  uplinkState = "off";
  return;
}
```

Missing `relayUrl`, missing `publisherToken`, or no embedded relay → it sets
`uplinkState = "off"` and returns **silently**. So:

> **A fresh install has no cloud relay and is LAN-only by construction.**
> That is not a bug and not a misconfiguration. It is the default.

The renderer says so: `apps/standalone/renderer/app.ts` pushes a
`THIS NETWORK ONLY` / `ONE DEVICE AT A TIME` warning chip into `04 OUTPUT` when
`config.relayUrl` is unset - the same words `SETTINGS → WHO CAN OPEN IT` uses,
deliberately, so the chip you see and the panel that fixes it agree. If a
user reports "the phone link doesn't work over the internet", check for that
chip before touching any code.

### Where the tokens come from

`loadState()` in `packages/relay/src/config.ts` resolves each token in this
order, first hit wins:

1. explicit `opts.publisherToken` / `opts.viewerToken`
2. `process.env.RELAY_PUBLISHER_TOKEN` / `process.env.RELAY_VIEWER_TOKEN`
3. the persisted `relay-state.json` in the relay's data dir (a value only counts
   if it is a non-empty string — `persistedToken()` rejects anything else, since
   a non-string token can never match a query param and would bring the relay up
   refusing every connection)
4. `generateToken()` — 16 random bytes, hex

Then it **always writes the result back** via `saveState()` (temp file +
rename, so a crash cannot leave a truncated state file).

The consequence, and the reason for commits `85706ca` and `9f0c393`: if the
environment sets neither token, step 4 mints random ones that exist **only on
that box**. The desktop app cannot be pointed at such a relay without SSHing in
to read the value, and wiping the data dir mints a new pair, invalidating every
viewer link already handed out. `packages/relay/sea/vps.env.example` now
documents both variables; the app's KEYS placeholder now says
`RELAY_PUBLISHER_TOKEN`, which is the name the code actually reads.

## Saved transcripts — where the copy comes from

Since v0.8.0 the desktop app writes every finished line to disk while the
session runs (`apps/standalone/src/transcripts.ts`, one `.jsonl` per session,
default `Documents\Callout Relay\Transcripts`). Two traps shaped it, and neither
is visible from outside the code:

- **The copy comes from `RelayHandle.onTranscript`, not `onBroadcast`.**
  `onBroadcast` fires inside `toViewers`, which is handed the line after
  `HIDE SWEARING` has masked it, and without latency when the badge is off.
  `onTranscript` is the publisher echo: what was actually said.
- **With translation on, one utterance arrives twice** - the line, then the
  same id again carrying `target`. The writer appends each as its own record
  and the reader merges them; it never buffers, because a buffer is exactly what
  a crash loses. Relay segment ids restart on every new publisher socket, so
  records are keyed by the file's own sequence number `n`, not by `id`.

## Package and app map

| Path | Responsibility |
|------|----------------|
| `packages/shared` | The contract: `AppConfig` + `DEFAULT_CONFIG` and the edge validators every hand-editable key goes through (`validRelayPort`, `validIdleBillingStopMinutes`, `validTranscriptDir`), the STT model catalogue, the wire types for every hop including the saved-transcript shapes, `isAllowedUpdateFeed()` and `redactLog()`. `src/index.ts`, plus `src/changelog.ts` - one source for the what's-new panel and the release notes. The loopback control API this row once described was deleted in 0.5.11. Every other package typechecks against its emitted `.d.ts`, so **it must be built first on a clean checkout**. |
| `packages/relay` | The relay server itself: HTTP + WebSocket (`server.ts`), publisher session and broadcast (`session.ts`), Deepgram STT (`deepgram.ts`), Gemini translation (`gemini.ts`), local sherpa-onnx STT and its worker (`localStt.ts`, `localSttWorker.ts`), token/state/dotenv handling (`config.ts`), and the `cli.ts` entry that becomes the SEA binary for anyone hosting their own relay. `onBroadcast` is the viewers' copy of each line; `onTranscript` is the publisher's, as heard. |
| `packages/companion` | Shared client side: audio capture and the downsampling worklet (`capture/`), the relay client (`relayClient.ts`), the uplink client (`uplinkClient.ts`), config store and merge (`config.ts`), and claiming a room on the hosted relay (`hostedRoom.ts`). |
| `packages/viewer` | The phone/OBS subtitle page (`public/`) that the relay serves. Plain JS, no build step (`build` and `typecheck` are `node -e "1"`). |
| `apps/standalone` | The Electron desktop app, **Windows-only**. `src/main.ts` (embedded relay, uplink, tray, IPC), `src/transcripts.ts` (saved transcripts: writer, reader, export - no Electron import, so it tests under plain Node), `src/models.ts` (local model download/extract), `src/updater.ts` (electron-updater), `renderer/` (the UI). This is the app users install. |
| `apps/hosted-relay` | The Cloudflare Worker behind `textrelay.cc` and `relay.supr.systems`: one Durable Object per streamer, rooms claimed with `POST /claim`, the landing page, and `POST /feedback` into R2. Fan-out only - no STT, no translation, no copy kept. `pnpm deploy:hosted` publishes it; `apps/hosted-relay/README.md` has the verify scripts. |

## Commands

All verified against `package.json` at v0.8.0.

| Command | What it does |
|---------|--------------|
| `pnpm test` | vitest, the whole suite. **59 files, 1030 tests** at v0.8.0. ~40 s. |
| `pnpm test:watch` | vitest in watch mode. |
| `pnpm typecheck:test` | `tsc -p tsconfig.test.json --noEmit`. **Separate on purpose** — see gotchas. |
| `pnpm -r typecheck` | Per-package typecheck. Needs `pnpm -r build` first on a clean checkout. |
| `pnpm -r build` | Build every package. `shared` emits the `.d.ts` the others need. |
| `pnpm smoke` | `packages/relay/scripts/smoke.mjs` — end-to-end against a real `startRelay` on an ephemeral port (`port: 0`): token auth, the subtitle pipeline, two channels, the admin endpoints. Requires `packages/relay/dist`, so build first. |
| `node scripts/check-renderer-ids.mjs` | Every element id the desktop renderer and the viewer page reference must exist in the markup. Prints the counts and exits non-zero if one dangles. |
| `pnpm dist:relay` | Build the relay + bundle + inject the SEA binary (`packages/relay/sea/`). |
| `pnpm dist:app` | electron-builder, Windows. |
| `pnpm deploy:hosted` | `wrangler deploy` of `apps/hosted-relay` - both custom domains at once. Uses this machine's `wrangler login`. |
| `pnpm version-bump <v>` | Set the version across the root and every workspace package.json. Prints the exact next commands. |
| `pnpm dev:relay` / `pnpm dev:app` | Run the relay CLI / the Electron app. |

The full gate — what CI runs and what a release must pass — is:
`pnpm -r build`, `pnpm -r typecheck`, `pnpm typecheck:test`, `pnpm test`,
`node scripts/check-renderer-ids.mjs`, `pnpm smoke`.

## Release process, end to end

```bash
pnpm version-bump 0.8.1
git add package.json apps/*/package.json packages/*/package.json   # not -a: the tree may hold unrelated edits
git commit -m "Release v0.8.1"
git tag -a v0.8.1 -m "v0.8.1"          # annotated; every release tag is
git push origin master v0.8.1
```

Then `.github/workflows/release.yml` runs on the `v*` tag:

1. **`windows` job** (windows-latest). Checks out the tag, then the
   **tag/version guard**:

   ```bash
   tag="$GITHUB_REF_NAME"
   pkg=$(node -p "require('./apps/standalone/package.json').version")
   if [ "$tag" != "v$pkg" ]; then exit 1; fi
   ```

   This is why **you cannot test the pipeline with an `rc` tag**: `v0.5.4-rc1`
   will never equal `v` + the package version, so the job fails before it
   builds anything. To exercise the workflow, use `workflow_dispatch` with an
   existing tag. After the guard: build, typecheck, typecheck:test, test,
   renderer ids, smoke, then electron-builder `--publish never` (the publish
   job owns the release so both builds attach to one) and `pnpm dist:relay`.
   Uploads installer, portable exe, `latest.yml`, `.blockmap`, and the Windows
   relay exe.
2. **`linux-relay` job** (ubuntu-latest). Build, `vitest run packages/relay packages/shared`,
   smoke, then SEA-inject into the runner's own node to produce
   `callout-relay-server-linux`. Added in v0.5.3 — that was the first tag whose
   Linux binary is gated on Linux tests. `apps/standalone` is Windows-only and
   stays out of this job.
3. **`publish` job** (needs both). Lays out the assets, generates
   `SHA256SUMS.txt`, and `gh release create`/`upload`s them.

**A release is not finished when the workflow goes green.** Two steps follow,
and `HANDOFF.md` carries the exact commands:

1. **Release notes.** The workflow publishes under GitHub's generated notes;
   replace them with the changelog prose, `node scripts/release-notes.mjs <v>`
   piped to `gh release edit`. That script reads `packages/shared/dist`, so
   build shared first. A version written but never tagged on its own - 0.7.0 -
   has no release page, so its entry belongs in the next release's notes.
   Prose only: no tooling credit, no emoji.
2. **The hosted relay.** `pnpm deploy:hosted`, then the two verify scripts in
   `apps/hosted-relay/scripts/`. A deploy restarts every Durable Object, so
   anyone watching reconnects once.

There is no VPS to mirror any more; it was stopped on 2026-09-06. Auto-update
reads `latest.yml` from the GitHub release, and an install only looks anywhere
else if `updateFeedUrl` is set.

## Repo gotchas

- **Workflow YAML is CRLF in the working tree and must be LF in the index.**
  `.gitattributes` sets `* text=auto eol=lf`, and
  `packages/shared/test/lineEndings.test.ts` asserts it by parsing
  `git ls-files --eol` — anything not stored `i/lf` (or `-text`/`none`) fails
  the suite. `git ls-files --eol .github/workflows/` currently reads
  `i/lf w/crlf`, which is the correct state. A stray CR reaching the VPS is how
  a `.env` line once stopped parsing; that is why this is enforced.
- **Tests live outside each package's `rootDir`,** so `pnpm -r typecheck` does
  not see them. They need `pnpm typecheck:test` or they rot untyped. CI runs
  both.
- **`apps/standalone/dist` is untracked and regenerates.** `dist/` is gitignored
  repo-wide; `pnpm --filter @callout-relay/standalone build` (or `pnpm dev:app`)
  rebuilds it. Same for every other package's `dist/`.
- **`packages/relay/sea/` is build output and gitignored** — the two big
  binaries, the blob, and the bundle. `vps.env` is gitignored too (it holds real
  keys); `vps.env.example` is the tracked template.
- **`shared` must be built before anything typechecks.** Both workflows build
  before they typecheck for exactly this reason.
- **`HANDOFF.md` was rewritten at v0.8.0,** after sitting at v0.5.1 for weeks
  describing a merged branch as unmerged and a retired VPS as the release
  target. `packages/shared/test/handoff.test.ts` guards it, this file,
  `docs/OPEN-WORK.md` and `README.md`: every `pnpm <script>`, file and document
  they name has to exist. A guard test cannot catch a stale claim, though, only
  a dangling pointer - which is exactly how both files drifted.
- **`pnpm dev:app` needs Electron's binary, which pnpm's postinstall may never
  have fetched.** `node_modules/.pnpm/electron@<v>/node_modules/electron/` ships
  only `index.js` until `install.js` downloads `dist/` (~190 MB) and writes
  `path.txt`; without them every Electron entry point dies with "Electron failed
  to install correctly". Run that `install.js` once. Worth checking before
  concluding that anything Electron-side "cannot be verified from this machine"
  - that conclusion was carried in this repo's notes for several sessions and
  was only ever a missing download.
- The repo merges by **rebase**; history is linear. Don't add merge commits.

## Conventions

**Commit messages.** Short imperative subject naming the *effect*, not the file
— "Stop a web page choosing which binary the app runs", "Answer a bad request
target instead of dying on it", "Bump the version nothing was bumping". No
conventional-commits prefixes, no scope tags. The body explains **why**: what
the failure actually was, how it was reproduced, and what changes. Then a
`Co-Authored-By:` trailer. Read the last 20 with `git log --format='%s%n%n%b'`
before writing one — the style is consistent and load-bearing.

**A guard test per fix.** Every fix in `ITERATION_LOG.md` shipped with tests
that go red when the fix is reverted, and the log records that check explicitly
("Reverting turns two of the four red"). Follow it: a fix without a test that
fails against the old code has not been demonstrated. This extends to
documentation and config — `versions.test.ts`, `workflows.test.ts`,
`lineEndings.test.ts`, `handoff.test.ts` and `checkRendererIds.test.ts` all
guard non-source facts.

**No mocking of the core relay or the translation state machine.** Verified:
`vi.mock` appears in **zero** of the 59 test files. The relay tests stand up a
real `startRelay` on an ephemeral port and talk to it over real WebSockets; the
renderer and viewer tests run under happy-dom against the real markup. Keep it
that way — mocking the thing under test is what the audit found hiding several
of these bugs.

### Lessons carried forward from `ITERATION_LOG.md`

Four, learned the hard way over 41 turns. They are at the end of that file and
worth re-reading:

1. **A test that goes green first time, when you expected red, has probably not
   run.** It happened four times in that run — a debounce that outlasted the
   assertion, a filesystem observable that could not see an open handle, a
   liveness check an `uncaughtException` handler had already made meaningless,
   and a regex that matched the SDK's own doc comment. Each looked like a
   passing test of a broken thing. **Always watch a new guard test fail first.**
2. **Fix the shape you can see and an adjacent one usually stays open.** A
   payload validator that ran *after* the dereference that killed the process; a
   redaction that masked the token field and left the token in the URL; a guard
   that caught a null config and not a null field. The audit found all three.
3. **Ask what a thing is checking, not whether it is correct.** A skip that
   passed, a version nothing bumped, a menu offering a deleted model, a comment
   claiming a check that was never written.
4. **Liveness is the wrong observable for a crash** once anything catches
   exceptions. Look for the throw.

## Known-open risks a session should not re-derive

Full list and status in `docs/OPEN-WORK.md`. The two that shape decisions:

- **No code signing.** `apps/standalone/package.json`'s `win` block sets no
  `publisherName` and ships no certificate, so electron-updater's
  `verifySignature` returns early and the **only** integrity proof for an update
  is the sha512 in `latest.yml`. `isAllowedUpdateFeed()` in
  `packages/shared/src/index.ts` bounds that risk: it requires `https:`, and
  allows `http:` only for loopback (`localhost`, `127.0.0.1`, `[::1]`, `::1`) on
  the grounds that that is a developer serving their own build. An unset feed
  means the packaged GitHub feed and is allowed.
- **In-app archive model downloads (B6)** fail at ~28% on one user's machine
  and cannot be reproduced on the dev desktop, where both failing models install
  cleanly. The instrumented error message is what will settle it - ask for it
  before changing the download path.
