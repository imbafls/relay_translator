# The improvement loop

A Ralph loop runs this file. The same short prompt is fed back every iteration,
so **this document is the only thing carrying intent between iterations** — that,
the kanban board, and git history. Nothing else survives.

Read it fully at the start of every iteration. It is written to be re-read.

---

## What a Ralph loop actually is

The same prompt, repeatedly. There is no memory between iterations except what is
written down: files, commits, and the board. An iteration that does work and
records nothing has done nothing, because the next iteration cannot see it.

The technique is good at well-defined work with clear success criteria, and bad
at open-ended judgement. "Improve the UI" is open-ended judgement. That is why
this document converts it into a queue of specific cards with specific done-tests,
and why **the queue is the deliverable as much as the code is**.

---

## The three hard rules

**1. One card per iteration. Never two.**
Pick the highest-priority card in `In Progress`, else `To Do`. Finish it, or leave
it in `In Progress` with sub-items ticked and `nextAction` rewritten so the next
iteration knows exactly where it stopped. Doing two cards makes the commit history
unreadable and makes a bad change hard to isolate.

**2. Never push, tag, release, or deploy.**
`git commit` locally, and stop there. No `git push`, no `git tag`, no
`pnpm dist:*`, no `pnpm deploy:hosted`, no `gh release`. The owner reviews the
commits and pushes. An unattended loop with push rights on `master` is how a bad
afternoon becomes a bad week — and this repo has already been bitten once by a
local branch diverging from `origin/master`.

**3. A guard test per fix, and you must watch it fail first.**
This repo's own hardest-learned lesson: *a test that goes green first time, when
you expected red, has probably not run.* Write the test, run it, **see it red**,
then write the fix, then see it green. A fix whose test you never watched fail has
not been demonstrated, and claiming otherwise in a commit message is worse than
not writing the test.

---

## Each iteration, in order

### 1. Find out where you are

```bash
git log --oneline -15
git status --short
```

Then read the board — it is the state:

`C:\Users\omert\.claude\project-tracking\relay\board.js`

Read it with the Read tool every iteration. The owner edits it in a browser and
saves, so the copy you remember may be stale. Never git-commit anything under
`~/.claude/project-tracking`; it is deliberately local.

Also read `docs/OPEN-WORK.md` — the repo's own backlog — and `CLAUDE.md`, which
carries the architecture and the conventions this file does not repeat.

### 2. Pick exactly one card

Highest priority in `In Progress` first (something was left half-done), then
`To Do`. If two cards are equal, prefer the one with a failing user-visible
symptom over the one that is only tidiness.

Set its lane to `In Progress` and its `updated` to today before starting.

### 3. Do it test-first

- Write the guard test.
- Run it: `npx vitest run <the one file>`.
- **Confirm it is RED, and that it failed for the reason you intended** — not on a
  typo, not on a missing import. Quote the failure in the commit body.
- Write the smallest change that makes it green.
- Run it again. Green.

No `vi.mock` of the relay or the translation state machine. `vi.mock` appears in
zero test files in this repo and that is deliberate: the relay tests stand up a
real `startRelay` on an ephemeral port, and renderer tests run under happy-dom
against the real markup. Mocking the thing under test is what hid several of the
bugs the original audit found.

### 4. Run the whole gate before committing

```bash
pnpm -r build
pnpm -r typecheck
pnpm typecheck:test
pnpm test
node scripts/check-renderer-ids.mjs
pnpm smoke
```

All six. `shared` must build first — every other package typechecks against its
emitted `.d.ts`. If any step fails, fix it in this iteration; do not commit a red
gate and do not move the card to `Done`.

### 5. Commit

One effect per commit. Subject is a short imperative naming the **effect**, not
the file — "Stop silence flooding the caption stage", not "Update app.ts". The
body explains *why*: what the failure actually was, how it was reproduced, what
changes. Read the last twenty with `git log --format='%s%n%n%b'` before writing
one; the style is consistent and load-bearing.

Stage explicitly. **Never `git add -a` or `-A`** — the tree may hold unrelated
edits, and it usually does.

End the message with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

### 6. Write the iteration back to the board

This is not bookkeeping; it is the only memory the next iteration has.

- Tick the `subItems` that are genuinely done.
- Rewrite `nextAction` to the next concrete step.
- Move to `Done` only when every sub-item is done and the gate is green.
- Bump the card's `updated` and `data.project.updated`.
- Keep the IIFE wrapper intact and the JSON valid, 2-space indent.
- Prose belongs in `detailHtml` as real HTML; structured state belongs in the
  JSON fields. Never store state inside prose.

If you learned something that changes the plan, write it into the card's
`detailHtml`. A future iteration will thank you; a future iteration is you.

---

## Scope guardrails

These exist because UI, UX, performance and quality all sprawl if left alone.

**UI and UX changes conform to `DESIGN.md`. They do not reinvent it.**
`DESIGN.md` is the source of truth: the token palette, `--radius: 0`, Archivo at
13px/1.4, and the rule that amber appears *only* when something is live or needs
attention. Do not introduce a colour that is not a token, a rounded corner, or a
new font. If you believe the spec is wrong, write that in the card and move on —
changing the spec is the owner's call, not the loop's.

**Performance changes need a measurement, before and after.**
Not a guess, not "this should be faster". If there is no measurement, the card is
to build the measurement — that is a complete and valuable iteration on its own.
An optimisation with no number attached is a behaviour change with no
justification.

**Quality changes must not be mass rewrites.**
No reformat-the-world commit. No repo-wide rename. If a tool wants to touch every
file, its run is *its own commit, touching nothing else*, and the message says
plainly what it did and why. `git blame` matters here more than usual, because
this repo's commit bodies carry the reasoning behind the code.

**Refactors move code without changing it.**
One commit relocates; a separate commit changes behaviour. If the existing tests
need editing to pass after a "pure move", it was not a pure move — revert and
split it.

**Do not weaken a test to make it pass.** If a test fails, either the change is
wrong or the test encodes something real. Deleting an assertion to get to green is
the one thing that makes this whole loop worthless.

---

## Seeing the UI

Tests run under happy-dom, which does not paint. To actually look at the desktop
renderer there is a static harness:

```bash
pnpm --filter @callout-relay/standalone build   # produces dist/renderer
node scripts/renderer-harness.mjs               # http://127.0.0.1:8791
```

Notes that will save an iteration:

- The harness itself is tracked, in `scripts/`. It used to live in
  `apps/standalone/dist/harness/`, which is **gitignored build output**, so it
  was never committed and vanished the first time anything cleaned `dist/` -
  taking with it the only way this document offers to look at the UI. What it
  serves is still build output: if `dist/renderer` is missing it says so and
  tells you to build.
- Port **8791** is this project's designated harness port. If it is busy, find out
  what is holding it (`netstat -ano | findstr :8791`) and deal with that. Never
  fall back to a different port. The harness refuses to start rather than
  moving, and `packages/shared/test/rendererHarness.test.ts` holds it to that.
- **It keeps serving until something stops it.** There is no timeout and no
  "one look and exit"; an iteration that starts one and moves on leaves a
  server listening for the rest of the session. That is how the thing holding
  8791 turns out to be you, several hours later, with the collision message
  reading like a real conflict. Find the owner before assuming it is:
  `netstat -ano | findstr :8791` gives the pid, `Get-CimInstance Win32_Process
  -Filter "ProcessId = <pid>"` gives the command line, and `Stop-Process -Id
  <pid>` ends it.
- `cr-stub.js` and `cr-stub-saved.js` are the stubs that feed it sample state,
  including sample saved transcripts.
- Driving it: clicks sent by coordinate mis-map under viewport emulation. Use
  `element.click()` through the page's own JS instead.

**Never launch the packaged app casually.** If an iteration genuinely needs it,
`HANDOFF.md` carries the only safe recipe, and all three of its protections are
required together: a scratch `CALLOUT_RELAY_DATA` on the launch line itself, a
scratch `transcriptDir`, and a dead `updateFeedUrl`. Without them a verification
run overwrites the owner's real config, writes into their real saved transcripts,
or installs a build over their real installation.

---

## When the queue runs dry

Do **not** invent work to look busy. An honest empty queue is the goal.

Run one discovery pass instead:

- Re-read `docs/OPEN-WORK.md` for anything unrecorded on the board.
- Look for the *adjacent shape* of something already fixed. This repo's second
  lesson: fix the shape you can see and an adjacent one usually stays open. The
  v0.8.1 review found exactly that — two layers guarded against wordless finals
  and a third left open.
- Ask what a change made newly reachable. The one regression that review found was
  a cleanup that named one folder when the code had started creating several.

Anything real becomes a new card with a concrete done-test. If the pass finds
nothing, say so and stop:

```
<promise>RELAY POLISH COMPLETE</promise>
```

Emit that **only** when all three hold: the board has nothing in `To Do` or
`In Progress`, a discovery pass added nothing, and the full gate is green. Emitting
it early ends the loop on a false claim.

---

## Things that are not yours to decide

Leave these for the owner and say so in the card:

- Cutting a release, pushing, tagging, deploying the hosted relay.
- Code signing — it is a purchase, not a code change.
- Anything that changes what the product *is* rather than how well it works.
- Editing `DESIGN.md`, or the release process in `CLAUDE.md`.
- `B6` (archive downloads failing on one user's machine). v0.8.1 pinned digests
  and retries in fresh folders, and that is a hypothesis fitting the evidence, not
  a reproduction. It needs the instrumented message from that machine. Do not
  mark it closed.
