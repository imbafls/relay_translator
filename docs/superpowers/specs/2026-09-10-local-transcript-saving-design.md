# Local transcript saving — design

Date: 2026-09-10. Status: **draft, awaiting owner approval.**

Every code claim below was read at `feature/last-build` (`10e571b`) and carries
a `file:line`. Where a claim could not be verified it says so.

---

## The ask

> "save transcription locally as well as stream so when user loses session or
> something happens the transcripts r saved locally and add option to open from
> the app and save location specification"

Three things: persist as we go, let the app open what was persisted, and let the
user choose where it lands.

The load-bearing word is **"loses"**. A transcript written when a session ends
cleanly is not the feature — the case that matters is the one where nothing ends
cleanly. That single constraint decides most of what follows.

---

## What exists today

Nothing. Greps over `docs/OPEN-WORK.md`, `ITERATION_LOG.md`, `README.md`,
`DESIGN.md` and `_handoff/docs/**` return only unrelated senses of "transcript"
(the live on-screen caption list) and "record" (a Durable Object row). The only
persistence in the product is `relay-state.json`, the config store, the bounded
`relay.log`, and the 0.7.0 feedback upload.

`docs/GUIDE.md:237` currently tells the user the service "keeps no copy once it
has passed a line on". That sentence is about the **hosted relay** and stays
true. It is adjacent enough to mislead once the desktop app keeps copies, so it
gets rewritten (§8).

---

## 1. Where the writer lives: the Electron main process

`apps/standalone/src/transcripts.ts`, new file. Not the relay package.

Three reasons, in order of weight:

1. **`packages/relay` also ships as a standalone SEA binary** for self-hosters
   (`packages/relay/sea/`, `pnpm dist:relay`). A remote relay writing transcripts
   to a VPS disk is a different product with a different privacy story. The
   feature belongs to the desktop app, so it lives in the desktop app.
2. **Main already receives every finished segment.** `relay.onBroadcast(cb)`
   (`packages/relay/src/server.ts:1004-1007`) hands out `ServerToViewer`
   messages, and `bridgeBroadcasts()` (`apps/standalone/src/main.ts:279-318`)
   already consumes it. The plumbing is proven.
3. **Main owns everything else the writer needs** — the config
   (`applyConfig`, `main.ts:460`), the data dir, and the renderer IPC.

## 2. The tee-off point: the publisher echo, not the viewer fan-out

**This is the correction that matters, and it is not obvious.**

`onFinal` broadcasts each finished segment down two different paths with two
different payloads (`packages/relay/src/session.ts:553-596`):

| | `toViewers` | `toPublisher` |
|---|---|---|
| source text | `this.forViewers(text)` — **profanity-masked** (`:566`) | raw `text` (`:573`) |
| latency | dropped when `latencyVisible === false` (`:564`) | always full (`:573`) |
| seen by `onBroadcast` | **yes** (`server.ts:335-341`) | no |

So the obvious tee — `onBroadcast` — would write `HIDE SWEARING`'s asterisks
into the user's own private record, and would silently lose latency for anyone
who turned the latency badge off. `HIDE SWEARING` is documented as a courtesy to
**viewers** (`docs/GUIDE.md:238-240`). It has no business censoring the
streamer's own archive.

**Therefore:** add a transcript listener set to the relay, fed from the same
place `toPublisher` is called, exposed on `RelayHandle` alongside `onBroadcast`.
Main subscribes to that. Small, additive, and it keeps the writer in the app.

## 3. The double-emit trap

With translation on, the **same `id`** is emitted a second time
(`session.ts:583-596`) carrying `target` — and carrying `source` again. Both are
`final: true`. A naive writer emits two lines per utterance.

**Resolution: append-only, one record per emit, merged on read.**

```jsonl
{"v":1,"kind":"session","startedAt":1757500325123,"app":"0.8.0","languages":{...}}
{"v":1,"kind":"line","id":42,"t":1757500331004,"source":"they're pushing B","ch":1,"speaker":"A","latency":{"stt":410}}
{"v":1,"kind":"tr","id":42,"t":1757500331660,"target":"B'ye geliyorlar","latency":{"stt":410,"translate":656}}
```

The alternative — buffer each segment until its translated twin arrives, then
write one merged line — reads better raw but **loses the buffer on the exact
failure this feature exists for**. Append-on-emit can lose at most the bytes in
flight during a power cut. That trade is the whole point, so it wins.

The cost is that raw `.jsonl` is less pretty. Acceptable: the user reads it
through the app (§6) or through an export (§7), not with a text editor.

## 4. Session identity

**There is no session id in this codebase** — `grep sessionId|roomId` returns
nothing. The only continuity is the monotonic `segId`, and it resets to 1 on
every new publisher socket (`session.ts:429-451`, `server.ts:364`).

So main mints one at session start: a UTC stamp, `2026-09-10T14-32-05`, used as
both the id and the filename. A reconnect inside one session must **not** start
a new file; the file is bound to the app's session lifecycle
(`session:update`, `main.ts`), not to the publisher socket.

The first line of every file is a `kind:"session"` header carrying `startedAt`,
the app version, and the language pair — so a file is self-describing even if
the app that wrote it is three versions gone.

## 5. Configuration — the first path-shaped key in `AppConfig`

`AppConfig` (`packages/shared/src/index.ts:18-106`) has **no path-shaped key
today**. Every directory is derived (`defaultDataDir()`,
`companion/src/config.ts:6`; `modelsDir`, `main.ts:83`). This is the first, and
it needs care, because `ConfigStore.merge` (`companion/src/config.ts:124`)
wholesale-assigns unknown keys through a `Record<string, unknown>` cast with no
allowlist — **validation in this codebase lives at the edges**, modelled by
`validRelayPort` (`shared:308`) and `validIdleBillingStopMinutes` (`shared:333`).

Two keys:

```ts
/** save a copy of every finished line to disk. on by default: a transcript
 *  you have to switch on before the session you lose is no transcript. */
saveTranscripts: boolean;          // required — DEFAULT_CONFIG: true
/** where those files go. absent = the platform default (Documents). */
transcriptDir?: string;            // optional — genuinely absent on a fresh install
```

`saveTranscripts` is **required, not `?:`** — following the essay at
`shared/src/index.ts:63-72` explaining that `?:` on `idleBillingStopMinutes`
forced a `?? 0` fallback meaning the opposite of the intended default. A
`saveTranscripts?: boolean` read as `?? false` would default this feature off.

New in shared: `validTranscriptDir(value: unknown): string | undefined`, shaped
like `validRelayPort` — rejects non-strings, empty and whitespace-only strings,
and relative paths.

The default location resolves in **main**, not shared, because it needs
`app.getPath("documents")` — Electron-only. This is the repo's **first**
`app.getPath` call (`grep` confirms zero today). Default:
`<Documents>/Callout Relay/Transcripts`.

## 6. The app surface

`#chain` — the `01…04` strip — is a literal `repeat(4, 1fr)` grid
(`style.css:402-408`) and there is no `05`. **A fifth block is not an option.**

Instead, a new **view**, alongside `#stage` / `#settings` / `#logView` /
`#onboarding`, toggled by `setView()` (`app.ts:322-341`):

- **`#transcripts`** — a list of past sessions (date, duration, line count,
  size), newest first. Selecting one reads it inline in the same merged form the
  live caption list uses. Per-row: EXPORT, REVEAL, DELETE.
- Reached from a footer entry next to `LOG`, and `Esc` returns to the captions —
  matching how `#logView` already behaves (`docs/GUIDE.md:248-250`).

Settings gets the location control in the **`app` `data-group`** (right column).
It must not go in the left column: `renderer.test.ts` asserts the left column's
first two groups are exactly `["reach","viewers"]`.

## 7. IPC

Each channel is three coordinated edits — `ipcMain.handle` in `registerIpc()`
(`main.ts:513-669`), a method on `RendererBridge` (`preload.ts:13-61`), and an
entry in the `satisfies` object (`preload.ts:63-93`). The `satisfies` clause
makes a missing bridge entry a typecheck error, but **nothing enforces that a
handler exists for a channel name** — which is why the repo pins channel names
with source-text guard tests (`renderer.test.ts:374-387`). New channels get the
same treatment.

| Channel | Returns |
|---|---|
| `transcripts:list` | session summaries, newest first |
| `transcripts:read` | merged records for one session |
| `transcripts:export` | writes `.txt` or `.srt`, returns the path |
| `transcripts:reveal` | `shell.showItemInFolder` |
| `transcripts:delete` | removes one file |
| `transcripts:chooseDir` | `dialog.showOpenDialog` |
| `transcripts:openDir` | `shell.openPath` |

`dialog` is **not imported anywhere in `apps/standalone/src` today**, and `shell`
is used only for `openExternal`. Both are new surface; `showItemInFolder` and
`openPath` are only ever handed paths the app itself resolved under the
transcript dir, never a renderer-supplied string.

## 8. Documentation

- `docs/GUIDE.md:232-240` — the "Where things go" paragraph gains local saving,
  states the default location plainly, and says the hosted relay still keeps no
  copy so the two facts do not blur.
- `packages/shared/src/changelog.ts:29` — a new entry, prepended.
- `docs/OPEN-WORK.md` — the feature and anything it leaves undone.

## 9. Testing

Repo law, verified: **zero `vi.mock(` in 53 test files / 949 tests** — a literal
grep exits non-zero. Seams are constructor injection
(`startRelay({mockStt, mockGemini, makeStt})`, `server.ts:78-91`). Filesystem
tests use `fs.mkdtempSync(path.join(os.tmpdir(), "<prefix>-"))` and never write
into the repo tree. DOM tests opt in with a `// @vitest-environment happy-dom`
pragma on line 1.

Each of these must be watched **failing first** — `ITERATION_LOG.md`'s lesson 1
is that a guard test which goes green immediately has probably not run:

1. Translation on, one utterance, exactly one `line` and one `tr` record, same
   `id`, merged to one row on read. *(Red against a naive `onBroadcast` writer,
   which emits two `line` records.)*
2. `HIDE SWEARING` on, the saved `source` is **unmasked**. *(Red against any
   writer teed off `toViewers`.)*
3. `latencyVisible: false`, latency still recorded. *(Same tee, same red.)*
4. A file truncated mid-line still reads every complete record before it.
5. `validTranscriptDir` rejects `""`, `"   "`, a relative path, a number, null.
6. `DEFAULT_CONFIG.saveTranscripts === true`, and a config file predating the
   key loads as `true`, not `false`.
7. A publisher reconnect inside one session appends to the same file.
8. `check-renderer-ids` passes with the new markup; the new view toggles.
9. Channel names pinned, as `renderer.test.ts:374-387` does.

## 10. Deliberately not built

- **No retention policy / auto-delete.** Silently deleting a user's own record is
  worse than a large folder. The panel shows total size; deletion is manual.
- **No encryption.** These are local files under the user's own Documents.
- **No audio saving.** The ask was transcripts.
- **No cloud sync.** The hosted relay stays fan-out-only; nothing here changes
  what leaves the machine.
- **No `.srt` written live.** Appending valid SRT mid-session is awkward and the
  format cannot hold both languages cleanly. It is an export (§7).

## 11. Open question for the owner

§2 assumes **`HIDE SWEARING` should not censor your own saved transcript** — it
is documented as a courtesy to viewers. If you would rather the archive match
exactly what viewers saw, say so and the tee moves back to `onBroadcast`, which
is a smaller change. Everything else in this spec holds either way.
