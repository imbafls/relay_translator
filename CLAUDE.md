# CLAUDE.md — Callout Relay

Read this first. It is the orientation document for a session working in this
repo. `README.md` is the product, `DESIGN.md` is the UI spec, `HANDOFF.md` is a
point-in-time handoff (partly stale — see below), `docs/OPEN-WORK.md` is the
consolidated backlog, `ITERATION_LOG.md` is the history of what was found and
fixed.

Everything here was verified against the tree at v0.5.3. Where a claim could not
be verified from this machine it says so.

---

## What this is

Real-time game comms translation. Audio is captured on a Windows desktop,
transcribed (Deepgram cloud STT, or sherpa-onnx locally), translated (Gemini),
and pushed as subtitles to a friend's phone or an OBS browser source.

pnpm monorepo, TypeScript throughout, Node >= 20. Root package is
`callout-relay`, private, version `0.5.3` — every workspace package carries the
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
subtitles** to a remote relay (the VPS at `relay.supr.systems`) so viewers on
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

The renderer says so: `apps/standalone/renderer/app.ts` (~line 853) pushes a
`LAN ONLY` / `RELAY NOT SET · LAN ONLY` warning chip when `config.relayUrl` is
unset, and ~line 1415 shows `RELAY SET` vs `LAN ONLY` in the output meta. If a
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

## Package and app map

| Path | Responsibility |
|------|----------------|
| `packages/shared` | The contract: `AppConfig` + defaults, the STT model catalogue, `CONTROL_PORT` (47477), control-API patch policy, `isAllowedUpdateFeed()`. One file, `src/index.ts`. Every other package typechecks against its emitted `.d.ts`, so **it must be built first on a clean checkout**. |
| `packages/relay` | The relay server itself: HTTP + WebSocket (`server.ts`), publisher session and broadcast (`session.ts`), Deepgram STT (`deepgram.ts`), Gemini translation (`gemini.ts`), local sherpa-onnx STT and its worker (`localStt.ts`, `localSttWorker.ts`), token/state/dotenv handling (`config.ts`), and the `cli.ts` entry that becomes the SEA binary shipped to the VPS. |
| `packages/companion` | Shared client side: audio capture and the downsampling worklet (`capture/`), the relay client (`relayClient.ts`), the uplink client (`uplinkClient.ts`), config store and merge (`config.ts`), and the loopback control API (`controlServer.ts` / `controlClient.ts`) the Stream Deck talks to. |
| `packages/viewer` | The phone/OBS subtitle page (`public/`) that the relay serves. Plain JS, no build step (`build` and `typecheck` are `node -e "1"`). |
| `apps/standalone` | The Electron desktop app, **Windows-only**. `src/main.ts` (embedded relay, uplink, tray, IPC), `src/models.ts` (local model download/extract), `src/updater.ts` (electron-updater), `renderer/` (the UI). This is the app users install. |
| `apps/streamdeck` | Elgato Stream Deck plugin. Talks to the desktop app's control API on `127.0.0.1:47477`; the app must be running. Carries its own `manifest.json` version, which `version-bump` also updates. |

## Commands

All verified against `package.json` at v0.5.3.

| Command | What it does |
|---------|--------------|
| `pnpm test` | vitest, the whole suite. **31 files, 375 tests** at v0.5.3. ~15 s. |
| `pnpm test:watch` | vitest in watch mode. |
| `pnpm typecheck:test` | `tsc -p tsconfig.test.json --noEmit`. **Separate on purpose** — see gotchas. |
| `pnpm -r typecheck` | Per-package typecheck. Needs `pnpm -r build` first on a clean checkout. |
| `pnpm -r build` | Build every package. `shared` emits the `.d.ts` the others need. |
| `pnpm smoke` | `packages/relay/scripts/smoke.mjs` — end-to-end against a real `startRelay` on an ephemeral port (`port: 0`): token auth, the subtitle pipeline, two channels, the admin endpoints. Requires `packages/relay/dist`, so build first. |
| `node scripts/check-renderer-ids.mjs` | Every element id the renderer, the viewer and the Stream Deck inspector reference must exist in the markup. Prints the counts and exits non-zero if one dangles. |
| `pnpm build:sd` | Build the Stream Deck plugin. |
| `pnpm dist:relay` | Build the relay + bundle + inject the SEA binary (`packages/relay/sea/`). |
| `pnpm dist:app` | electron-builder, Windows. |
| `pnpm version-bump <v>` | Set the version across the root, every workspace package.json, **and** the Stream Deck manifest. Prints the exact next commands. |
| `pnpm dev:relay` / `pnpm dev:app` | Run the relay CLI / the Electron app. |

The full gate — what CI runs and what a release must pass — is:
`pnpm -r build`, `pnpm -r typecheck`, `pnpm typecheck:test`, `pnpm test`,
`node scripts/check-renderer-ids.mjs`, `pnpm smoke`.

## Release process, end to end

```bash
pnpm version-bump 0.5.4
git commit -am "Release v0.5.4"
git tag -a v0.5.4 -m "v0.5.4"          # annotated; every release tag is
git push origin master v0.5.4
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

**A release is not finished when the workflow goes green.** The VPS still has
to be mirrored — download the assets, verify the checksums, upload the
installer and blockmap to `/opt/callout-relay/data/updates/`, upload
`latest.yml` **last** so the manifest never points at a file that is not there,
replace the Linux relay binary and restart the service. `HANDOFF.md` carries the
exact commands. **This step has not been done since v0.5.1** — see
`docs/OPEN-WORK.md`.

Auto-update defaults to the GitHub feed. The VPS feed only serves installs that
explicitly set `updateFeedUrl`.

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
- **`HANDOFF.md` is partially stale.** It still says the latest release is
  v0.5.1 and describes a `ralph/pipeline-hardening` branch as unmerged. That
  work is in `master` and v0.5.3 is released. Its *procedures* (the VPS mirror,
  audio routing, the model-download investigation) are still good. There is a
  guard test over it — `packages/shared/test/handoff.test.ts` checks that every
  `pnpm <script>` and every file and doc it names actually exists — but a guard
  test cannot catch a stale claim, only a dangling pointer. **There is no
  equivalent guard test over this file.**
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
`vi.mock` appears in **zero** of the 31 test files. The relay tests stand up a
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

Full list and status in `docs/OPEN-WORK.md`. The three that shape decisions:

- **No code signing.** `apps/standalone/package.json`'s `win` block sets no
  `publisherName` and ships no certificate, so electron-updater's
  `verifySignature` returns early and the **only** integrity proof for an update
  is the sha512 in `latest.yml`. `isAllowedUpdateFeed()` in
  `packages/shared/src/index.ts` bounds that risk: it requires `https:`, and
  allows `http:` only for loopback (`localhost`, `127.0.0.1`, `[::1]`, `::1`) on
  the grounds that that is a developer serving their own build. An unset feed
  means the packaged GitHub feed and is allowed.
- **The local control API has no credential.** `GET /link` in
  `packages/companion/src/controlServer.ts` carries an explicit `STILL OPEN`
  comment: it returns the unredacted viewer link, `allowedOrigin` admits
  `Origin: null` (what a sandboxed iframe on any page sends), and there is
  nothing to check. `GET /status` is masked by `redact()`; `/link` is not.
  Closing it needs a per-launch token the Stream Deck property inspector can
  present.
- **The VPS is behind and cannot be updated from this machine.** See
  `docs/OPEN-WORK.md` for what unblocks it.
