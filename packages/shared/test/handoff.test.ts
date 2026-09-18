import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { updateFeedAction, validTranscriptDir } from "../src/index";

/**
 * The documents a session reads before it touches anything, checked for the one
 * kind of staleness a test can catch: a pointer that no longer resolves.
 *
 * HANDOFF.md had already misled once - it told this loop the repo had no test
 * runner long after it had one. CLAUDE.md is now the file a session reads
 * FIRST and had no equivalent guard at all; docs/OPEN-WORK.md is the backlog,
 * and a backlog that names a deleted script is a backlog nobody trusts.
 *
 * These are deliberately narrow. A document cannot be asserted true, but a
 * command it tells you to run either exists or does not.
 */

/**
 * Source with its comments removed, for checks that mean to look at code.
 *
 * A block comment preserves the text inside it exactly, so a construct that has
 * been commented OUT still matches a raw-text search - the check passes while
 * the program no longer contains it. Found by sabotage rather than by reading:
 * wrapping the uplink gate in a block comment left the quote check below green.
 *
 * The `[^:]` guard before a line comment is there to leave `https://` alone.
 */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const root = path.resolve(__dirname, "..", "..", "..");
const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts as Record<
  string,
  string
>;

// README.md is in here because it is the one document a new person reads,
// and it was the one nothing checked: it spent a day telling people to SSH
// into a server that had been powered off, and to look in a directory that
// is gitignored. A guard cannot catch a stale claim, only a dangling
// pointer - but it would have caught several of those.
const DOCS = ["HANDOFF.md", "CLAUDE.md", "docs/OPEN-WORK.md", "README.md"] as const;
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");

/**
 * Only the parts of a document that are actually code: fenced blocks and
 * inline `code spans`. Searching the prose as well finds "pnpm monorepo" in the
 * sentence describing what this repo IS, and reports it as a missing script.
 */
function codeOnly(text: string): string {
  const fences = [...text.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]);
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  return [...fences, ...spans].join("\n");
}

/** every `pnpm <name>` a document tells you to run, minus pnpm's own verbs */
function pnpmScripts(text: string): string[] {
  const builtin = new Set(["install", "add", "exec", "dlx", "run", "why", "store", "approve-builds"]);
  return [...codeOnly(text).matchAll(/\bpnpm (?:-r )?(?:--filter \S+ )?([a-z][\w:-]*)/g)]
    .map((m) => m[1])
    .filter((name) => !builtin.has(name));
}

/** a path a document names, resolved the way a reader would: beside it, or from the root */
function resolves(doc: string, rel: string): boolean {
  return (
    fs.existsSync(path.join(root, rel)) || fs.existsSync(path.join(root, path.dirname(doc), rel))
  );
}

describe.each(DOCS)("%s tells you to run things that exist", (doc) => {
  const text = read(doc);

  it("names some commands or files, so the check means something", () => {
    const referenced =
      new Set(pnpmScripts(text)).size +
      new Set([...text.matchAll(/\b(?:scripts|packages|apps)\/[\w./-]+\.(?:json|mjs|cjs|ts|js)/g)].map((m) => m[0]))
        .size;
    expect(referenced, `${doc} names nothing checkable, so this suite is vacuous for it`).toBeGreaterThan(3);
  });

  it("names only scripts the repo actually has", () => {
    const unknown = [...new Set(pnpmScripts(text))].filter((name) => !(name in scripts));
    expect(unknown, `${doc} tells you to run: ${unknown.join(", ")}`).toEqual([]);
  });

  it("points at files that are still there", () => {
    // longest extension first: alternation is ordered, so `js` before `json`
    // silently truncates package.json to package.js
    const referenced = [
      ...text.matchAll(/\b((?:scripts|packages|apps|deploy)\/[\w./-]+\.(?:json|toml|mjs|cjs|ts|js))/g),
    ].map((m) => m[1]);
    const missing = [...new Set(referenced)].filter((rel) => !resolves(doc, rel));
    expect(missing, `${doc} points at: ${missing.join(", ")}`).toEqual([]);
  });

  it("points at documents that exist, not just code", () => {
    // the audit and the iteration log are where the unfinished work lives, so
    // a dangling pointer to either loses it
    const docs = [...text.matchAll(/\b((?:docs\/)?[A-Z][\w-]*\.md)\b/g)].map((m) => m[1]);
    const missing = [...new Set(docs)].filter((rel) => !resolves(doc, rel));
    expect(missing, `${doc} points at: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("the handoff and the orientation doc stay honest about the basics", () => {
  it("still points somewhere for the work that is not done", () => {
    const handoff = read("HANDOFF.md");
    expect(handoff).toMatch(/AUDIT-\d{4}-\d{2}-\d{2}\.md/);
    expect(handoff).toContain("ITERATION_LOG.md");
  });

  it("does not still claim there is no test runner", () => {
    // the exact staleness that propagated into a whole run of work
    expect(read("HANDOFF.md")).not.toMatch(/no test runner/i);
    expect(scripts.test).toBeTruthy();
  });

  it("does not send anyone to a VPS that was retired", () => {
    // relay.supr.systems is a Cloudflare Worker now; the Hostinger box was
    // stopped on 2026-09-06. A backlog that still says "SSH in and mirror the
    // release" is worse than one that says nothing.
    for (const doc of DOCS) {
      const text = read(doc);
      const claimsBlockedOnSsh = /Blocked on: (?:the )?(?:same )?SSH credentials/i.test(text);
      expect(claimsBlockedOnSsh, `${doc} still describes work blocked on SSH to the retired VPS`).toBe(false);
    }
  });
});

/**
 * Every line of every fenced block, with `\`-continued lines joined back into
 * the one command they are, so a launch split over two lines still reads as
 * one launch rather than as a bare exe path.
 */
function fencedLines(text: string): string[] {
  return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].flatMap((m) =>
    m[1].replace(/\\\r?\n/g, " ").split(/\r?\n/),
  );
}

// the desktop app itself, whichever build: win-unpacked or an installed copy
const LAUNCHES_APP = /Callout\\? Relay\.exe/;

describe("a documented launch of the packaged app brings its own data dir", () => {
  // HANDOFF's CDP recipe used to launch win-unpacked against the real
  // %APPDATA%\callout-relay. On 2026-09-10 one page reload rewrote config.json
  // twice: the uplink pulled the hosted room's viewer token, lastSeenVersion
  // moved on, and the two saves left neither the original file nor its .bak on
  // disk. The variable has to sit on the launch line itself - unset or empty,
  // defaultDataDir() means the real dir, and a launch run in a shell of its own
  // never sees what an earlier line exported.
  const launches = DOCS.flatMap((doc) =>
    fencedLines(read(doc))
      .filter((line) => LAUNCHES_APP.test(line) && !line.trimStart().startsWith("#"))
      .map((line) => ({ doc, line: line.trim() })),
  );

  it("finds the launch in HANDOFF.md, so the check means something", () => {
    expect(
      launches.map((l) => l.doc),
      "HANDOFF.md no longer launches the packaged app anywhere",
    ).toContain("HANDOFF.md");
  });

  it("sets a non-empty CALLOUT_RELAY_DATA as a prefix of the launch command", () => {
    const unsafe = launches.filter(({ line }) => {
      const before = line.slice(0, line.search(LAUNCHES_APP));
      // `VAR=value cmd` and nothing else: an empty value is the real dir, and a
      // separator before the exe hands the variable to some other command
      return !/^CALLOUT_RELAY_DATA=(?!""|''|\s|$)/.test(before) || /;|&&|\|/.test(before);
    });
    expect(
      unsafe.map((l) => `${l.doc}: ${l.line}`),
      "these launch the app against the real %APPDATA%\\callout-relay",
    ).toEqual([]);
  });
});

/**
 * The JSON each fenced `printf '...' > .../config.json` line writes, with its
 * `%s` filled in the way the shell would. A seed that does not parse reads as
 * no config at all: setup comes back, transcripts go to the real Documents
 * folder, and the updater is back on the release feed.
 */
function seeds(text: string): { line: string; json: Record<string, unknown> | undefined }[] {
  return fencedLines(text)
    .filter((line) => /\bprintf '[^']*'/.test(line) && line.includes("config.json") && !line.trimStart().startsWith("#"))
    .map((line) => {
      const format = /\bprintf '([^']*)'/.exec(line)?.[1] ?? "";
      let json: Record<string, unknown> | undefined;
      try {
        json = JSON.parse(format.replace(/%s/g, "C:/scratch").replace(/\\n$/, ""));
      } catch {
        json = undefined;
      }
      return { line: line.trim(), json };
    });
}

// a feed here can only be answered by something on this machine
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]", "::1"];

describe("a documented launch of the packaged app cannot update itself", () => {
  // win-unpacked ships resources/app-update.yml, so its updater is live:
  // Updater.start() checks 15 s after launch with nobody clicking CHECK, and a
  // build behind the latest release downloads it into the updater cache the
  // installed app shares, then on a clean quit runs that installer over the
  // owner's own install. The seed stops that by naming a dead loopback feed -
  // but only while updateFeedAction() applies it. A feed it refuses leaves the
  // release feed on, and so does a seed that no longer parses. (The block
  // above already fails if no doc launches the app, so these are not vacuous.)
  const launching = DOCS.filter((doc) =>
    fencedLines(read(doc)).some((line) => LAUNCHES_APP.test(line) && !line.trimStart().startsWith("#")),
  );

  it("seeds the config it launches against, as JSON that parses", () => {
    const problems = launching.flatMap((doc) => {
      const found = seeds(read(doc));
      if (found.length === 0) return [`${doc}: launches the app with no config.json seed`];
      return found.filter((s) => !s.json).map((s) => `${doc}: seed does not parse: ${s.line}`);
    });
    expect(problems).toEqual([]);
  });

  it("points the updater at a loopback feed it applies rather than refuses", () => {
    const problems = launching.flatMap((doc) =>
      seeds(read(doc)).flatMap(({ line, json }) => {
        if (!json) return []; // reported by the test above
        const feed = json.updateFeedUrl;
        if (typeof feed !== "string" || !feed.trim()) {
          return [`${doc}: seed names no updateFeedUrl, so the release feed stays on: ${line}`];
        }
        const decision = updateFeedAction(feed, undefined);
        if (decision.action !== "set") {
          return [`${doc}: the updater would not apply ${feed} (${decision.action}), so the release feed stays on`];
        }
        const host = new URL(decision.url).hostname;
        return LOOPBACK.includes(host) ? [] : [`${doc}: ${feed} is not loopback, so a real server could answer it`];
      }),
    );
    expect(problems).toEqual([]);
  });

  // The third protection, and the one nothing held. Transcripts do NOT live
  // in the data dir, so CALLOUT_RELAY_DATA does not cover them: without a
  // transcriptDir of its own a documented run writes its test captions into
  // the owner's real Documents\\Callout Relay\\Transcripts, among the sessions
  // they actually kept. `%s` is the scratch dir the same block builds, so a
  // seed that no longer derives the folder from it is caught here too.
  it("keeps a documented run's transcripts out of the owner's own folder", () => {
    const problems = launching.flatMap((doc) =>
      seeds(read(doc)).flatMap(({ line, json }) => {
        if (!json) return []; // reported by the parse test above
        const dir = json.transcriptDir;
        if (typeof dir !== "string" || !dir.trim()) {
          return [`${doc}: seed names no transcriptDir, so the run saves into the owner's Documents: ${line}`];
        }
        if (!validTranscriptDir(dir)) {
          return [`${doc}: the app refuses ${dir} and falls back to the owner's Documents: ${line}`];
        }
        return dir.startsWith("C:/scratch")
          ? []
          : [`${doc}: ${dir} is not built from the scratch dir the same block makes: ${line}`];
      }),
    );
    expect(problems).toEqual([]);
  });
});

/**
 * The header above says a document cannot be asserted true, only checked for a
 * pointer that still resolves. That is right about most of a document and
 * wrong about a claim the tree can be asked about directly - and CLAUDE.md
 * makes three of those. All three had drifted, two of them because this repo's
 * own improvement loop changed the thing being described and left the sentence
 * behind.
 */
describe("the claims CLAUDE.md makes about the tree", () => {
  const claude = (): string => fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");

  /** what vitest's own include globs would collect */
  function testFiles(): string[] {
    const found: string[] = [];
    for (const group of ["packages", "apps"]) {
      const base = path.join(root, group);
      if (!fs.existsSync(base)) continue;
      for (const pkg of fs.readdirSync(base)) {
        const dir = path.join(base, pkg, "test");
        if (!fs.existsSync(dir)) continue;
        const walk = (d: string): void => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith(".test.ts")) found.push(full);
          }
        };
        walk(dir);
      }
    }
    return found;
  }

  it("quotes the number of test files the repo actually has", () => {
    const real = testFiles().length;
    expect(real).toBeGreaterThan(10);

    // every "N files" / "N test files" in the doc has to be that number. It is
    // quoted twice, and the drift that prompted this updated neither.
    const quoted = [...claude().matchAll(/(\d+)\s+(?:test\s+)?files\b/g)].map((m) => Number(m[1]));
    expect(quoted.length, "CLAUDE.md no longer quotes a file count anywhere").toBeGreaterThan(0);
    expect(
      quoted.filter((n) => n !== real),
      `the suite has ${real} test files and CLAUDE.md says ${quoted.join(" and ")}`,
    ).toEqual([]);
  });

  it("is right that nothing mocks a module", () => {
    // the claim is about `vi.mock`, module mocking - not `vi.mocked`, which is
    // a type helper over a spy and does appear once, nor the two comments that
    // say the words while promising not to do it
    const offenders = testFiles().filter((f) => /vi\.mock\(/.test(fs.readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(root, f)), "CLAUDE.md says zero, and means it").toEqual([]);
  });

  it("does not call the viewer's typecheck a no-op while it runs tsc", () => {
    const script = (
      JSON.parse(fs.readFileSync(path.join(root, "packages", "viewer", "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      }
    ).scripts?.typecheck;
    if (!script?.includes("tsc")) return;

    const row = claude()
      .split(/\r?\n/)
      .find((l) => l.includes("| `packages/viewer` |"));
    expect(row, "the package table no longer has a packages/viewer row").toBeDefined();
    expect(
      /typecheck[^|]*node -e/.test(row ?? ""),
      `packages/viewer typecheck is ${JSON.stringify(script)}, but CLAUDE.md still calls it a no-op`,
    ).toBe(false);
  });
});

/**
 * CLAUDE.md sends a session to the lessons in ITERATION_LOG.md and says they
 * are "at the end of that file". They were, once. Fifty turns were appended
 * after them, and they now sit a third of the way in, so following that
 * sentence lands a reader in the middle of a turn about staging folders.
 *
 * A position in a growing file is a pointer that decays on its own. A heading
 * does not, so the doc names one and this asserts the heading is really there
 * and really holds the number of lessons CLAUDE.md promises.
 */
/**
 * CLAUDE.md quotes source code, and a quotation is a copy that can rot.
 *
 * The one that matters most sits under "The two relays - read this before
 * debugging anything network-shaped", which the file itself calls the single
 * biggest source of wasted time in this project. It shows the gate in
 * `startUplink()` that silently turns the uplink off, and a reader trusts it
 * enough not to go and look. If that gate gains a condition, the quotation
 * keeps describing the old one and sends people to debug a branch that no
 * longer exists.
 *
 * Matched on normalised whitespace, because markdown and TypeScript disagree
 * about indentation and a guard that breaks on re-indentation is one somebody
 * deletes rather than satisfies. The source list is read from the tree rather
 * than written down here, for the reason lesson five gives.
 */
describe("the TypeScript CLAUDE.md quotes", () => {
  const flat = (t: string): string => t.replace(/\s+/g, " ").trim();

  /** every tracked .ts under apps/ and packages/, minus build output */
  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "sea") continue;
        sources(full, out);
      } else if (entry.name.endsWith(".ts")) {
        out.push(full);
      }
    }
    return out;
  }

  const blocks = [...read("CLAUDE.md").matchAll(/```ts\r?\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");

  it("quotes some, so this checks something", () => {
    expect(blocks.length, "CLAUDE.md has no ```ts blocks left, so there is nothing to hold to the tree").toBeGreaterThan(0);
  });

  it("quotes only code the tree still contains", () => {
    const files = [...sources(path.join(root, "apps")), ...sources(path.join(root, "packages"))];
    expect(files.length, "no TypeScript was discovered to check against").toBeGreaterThan(20);
    // comments stripped first, or a gate wrapped in /* */ still satisfies this
    // while being gone from the program - which is the state it was in until a
    // sabotage meant to prove this red came back green
    const haystacks = files.map((f) => flat(code(fs.readFileSync(f, "utf8"))));

    const missing = blocks.filter((b) => !haystacks.some((h) => h.includes(flat(b))));
    expect(
      missing,
      `CLAUDE.md quotes TypeScript that is in no source file any more:\n${missing.join("\n---\n")}`,
    ).toEqual([]);
  });
});

/**
 * The other quotation in CLAUDE.md: the release workflow's tag guard.
 *
 * It was quoted with its first line abridged to `tag="$GITHUB_REF_NAME"`,
 * and the half it dropped - `github.event.inputs.tag` - is the half the very
 * next paragraph depends on: "To exercise the workflow, use
 * `workflow_dispatch` with an existing tag." Under the quoted version a
 * dispatched run compares a branch name against the version and always fails,
 * so a reader who trusts the page concludes the documented workaround cannot
 * work, or "fixes" the workflow to match it. The TypeScript quotes had a guard
 * and this one did not, because it is shell inside YAML rather than a `ts`
 * fence, and that is the whole reason it drifted unnoticed.
 *
 * Held the same way: normalised whitespace, and the block has to appear in the
 * workflow as it stands. Found by what it quotes, not by where it sits, so a
 * re-ordered page cannot quietly stop it being checked.
 */
describe("the tag guard CLAUDE.md quotes from the release workflow", () => {
  const flat = (t: string): string => t.replace(/\s+/g, " ").trim();
  const quotes = [...read("CLAUDE.md").matchAll(/```bash\r?\n([\s\S]*?)```/g)]
    .map((m) => m[1] ?? "")
    .filter((b) => b.includes("apps/standalone/package.json').version"));

  it("is there, so this checks something", () => {
    expect(quotes, "CLAUDE.md no longer quotes the tag guard, or quotes it more than once").toHaveLength(1);
  });

  it("is the guard the workflow actually runs, dispatch half included", () => {
    const workflow = flat(read(".github/workflows/release.yml"));
    expect(
      workflow.includes(flat(quotes[0] ?? "")),
      "CLAUDE.md quotes a tag guard that is not in .github/workflows/release.yml - and the paragraph under it " +
        "tells a reader what that guard allows",
    ).toBe(true);
  });
});

describe("the pointer from CLAUDE.md into the iteration log", () => {
  const claude = (): string => fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
  const log = (): string => fs.readFileSync(path.join(root, "ITERATION_LOG.md"), "utf8");

  /** the lessons are numbered list items in bold, under their own heading */
  function lessonSection(): { heading: string; lessons: string[] } | null {
    const lines = log().split(/\r?\n/);
    const at = lines.findIndex((l) => /^\s*1\.\s+\*\*A test that goes green first time/.test(l));
    if (at < 0) return null;
    let heading = "";
    for (let i = at; i >= 0; i -= 1) {
      const m = /^#{1,6}\s+(.*)$/.exec(lines[i] ?? "");
      if (m) {
        heading = (m[1] ?? "").trim();
        break;
      }
    }
    const lessons: string[] = [];
    for (let i = at; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (/^#{1,6}\s/.test(line) && i > at) break;
      if (/^\s*\d+\.\s+\*\*/.test(line)) lessons.push(line);
    }
    return { heading, lessons };
  }

  it("does not call them the end of the file while they sit a third of the way in", () => {
    const lines = log().split(/\r?\n/);
    const at = lines.findIndex((l) => /^\s*1\.\s+\*\*A test that goes green first time/.test(l));
    expect(at, "the first lesson is no longer in ITERATION_LOG.md at all").toBeGreaterThan(-1);

    const nearTheEnd = at > lines.length * 0.8;
    const claimsTheEnd = /lessons[\s\S]{0,400}?at the end of that file/i.test(claude());
    expect(
      claimsTheEnd && !nearTheEnd,
      `CLAUDE.md says the lessons are at the end of ITERATION_LOG.md; they are at line ${at + 1} of ${lines.length}`,
    ).toBe(false);
  });

  it("names a heading that exists, holding the number of lessons it promises", () => {
    const section = lessonSection();
    expect(section, "the lessons are not in ITERATION_LOG.md under any heading").not.toBeNull();

    const heading = section?.heading ?? "";
    expect(heading.length, "the lessons sit under no heading at all").toBeGreaterThan(0);
    // whitespace-normalised: markdown wraps, and a guard that breaks when a
    // paragraph is re-flowed is a guard somebody deletes
    const flat = (t: string): string => t.replace(/\s+/g, " ");
    expect(
      flat(claude()).includes(flat(heading)),
      `CLAUDE.md should point at the heading the lessons live under - "${heading}" - rather than at a position that moves`,
    ).toBe(true);

  });

  /** the numbered, bolded lessons CLAUDE.md itself lists */
  function quotedLessons(): string[] {
    const body = /### Lessons carried forward[\s\S]*?(?=\n## )/.exec(claude())?.[0] ?? "";
    return [...body.matchAll(/^\d+\.\s+\*\*(.+?)\*\*/gms)].map((m) => (m[1] ?? "").replace(/\s+/g, " ").trim());
  }

  it("says how many lessons it lists, and lists that many", () => {
    const words: Record<string, number> = { One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6 };
    const said = /\n(\w+), learned the hard way/.exec(claude())?.[1] ?? "";
    expect(words[said], "CLAUDE.md no longer says how many lessons there are").toBeDefined();
    expect(words[said], `CLAUDE.md says ${said} and then lists ${quotedLessons().length}`).toBe(
      quotedLessons().length,
    );
  });

  /**
   * A count of commits is a position dressed up as a fact: it is true on the
   * day it is written and wrong on every day after, in a file that is appended
   * to. This is the same decay the test above is about - CLAUDE.md calling the
   * lessons "the end of that file" while fifty turns piled up behind them - and
   * the same fix applies, which is to say what the section covers and anchor it
   * to something that does not move.
   *
   * It is enforced on headings only. A count inside the prose, next to the
   * commit it was true at, is a dated statement rather than a decaying one.
   */
  it("heads its sections without a commit count, which only decays", () => {
    const NUMBER =
      "\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|" +
      "sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred";
    const counting = new RegExp(`\\b(?:${NUMBER})(?:[- ](?:${NUMBER}))?\\s+commits\\b`, "i");

    const headings = log()
      .split(/\r?\n/)
      .filter((l) => /^#{1,6}\s/.test(l));
    expect(headings.length, "ITERATION_LOG.md has no headings at all, so this checks nothing").toBeGreaterThan(10);

    const decaying = headings.filter((h) => counting.test(h));
    expect(
      decaying,
      "a heading counts commits, and the run it counts keeps growing:\n" +
        decaying.join("\n") +
        "\nSay what the section covers and anchor it to a commit, the way the lessons pointer was fixed.",
    ).toEqual([]);
  });

  it("quotes no lesson the log does not carry", () => {
    // the log is where a lesson is EARNED - CLAUDE.md is the summary. One that
    // exists only in the summary has no evidence behind it, and the evidence is
    // the half that makes it persuasive to a future session.
    // normalised on both sides - whitespace because markdown wraps, case
    // because a headline that opens a sentence in one document sits mid-sentence
    // in the other. A guard over prose that cannot survive re-wrapping or a
    // capital letter is a guard somebody deletes rather than satisfies.
    const flatLog = log().replace(/\s+/g, " ").toLowerCase();
    const missing = quotedLessons().filter((headline) => !flatLog.includes(headline.toLowerCase()));
    expect(
      missing,
      `CLAUDE.md lists these and ITERATION_LOG.md does not carry them:\n${missing.join("\n")}`,
    ).toEqual([]);
  });
});

/**
 * The board this run works from is not in the repo, and says so in print.
 *
 * `ITERATION_LOG.md` explains that the kanban board lives at
 * `~/.claude/project-tracking/relay/board.js`, is deliberately not committed,
 * and that the section around it is therefore the only account of the run that
 * ships with the code. `docs/RALPH-IMPROVEMENT-LOOP.md` states the rule
 * directly: never git-commit anything under `~/.claude/project-tracking`.
 *
 * Nothing checked it. The board is a working file full of half-formed notes
 * and unfinished reasoning that nobody outside this machine should inherit,
 * and it sits one `git add` away from the tree every time somebody copies it in
 * to look at it. If it were ever committed the claim above would be false and
 * the rule broken in the same move - which is exactly the pair this file exists
 * to catch.
 */
describe("the tracking board", () => {
  const tracked = (): string[] =>
    execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);

  it("lists files at all, so the check below is not vacuous", () => {
    expect(tracked().length, "git ls-files returned nothing, so nothing was actually checked").toBeGreaterThan(50);
  });

  it("is not in the repo, which is what the log says about it", () => {
    const vendored = tracked().filter((f) => /project-tracking|(^|\/)board\.js$/i.test(f));
    expect(
      vendored,
      "the loop's board has been committed. docs/RALPH-IMPROVEMENT-LOOP.md says never to, ITERATION_LOG.md " +
        "tells a reader it is not, and it carries working notes that were never written to be shipped",
    ).toEqual([]);
  });
});

/**
 * The Stream Deck plugin is gone, and stays gone.
 *
 * `1acd94e` - "Drop the Stream Deck plugin, and the control API it was the only
 * user of" - removed both. What can still be sitting in a working copy is the
 * generated `bin/` and `imgs/` from a build before that, which `.gitignore`
 * keeps out of the repo and which nothing here rebuilds.
 *
 * That leftover is not harmless to a reader. `apps/streamdeck/.../bin/plugin.js`
 * is about 4,700 lines of bundled code from before the drop, including a copy
 * of `packages/companion`'s config migration - so a sweep that walks `apps/*`
 * finds a setting "read" by code that has not shipped since 0.5.11. This
 * iteration's own config sweep did exactly that with `obsOverlay` before
 * anybody looked at where the hit came from.
 *
 * So CLAUDE.md's gotchas say what that directory is, and this keeps the claim
 * true: the drop was deliberate and nothing under it belongs in the tree again.
 */
describe("the dropped Stream Deck plugin", () => {
  const tracked = (): string[] =>
    execFileSync("git", ["ls-files", "apps/streamdeck"], { cwd: root, encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);

  it("has nothing of it in the repo", () => {
    expect(
      tracked(),
      "apps/streamdeck has tracked files again. It was dropped in 1acd94e along with the control API it drove, " +
        "and CLAUDE.md tells a reader that anything found there is retired build output rather than a component",
    ).toEqual([]);
  });

  it("is described as retired where a sweep would look", () => {
    const claude = read("CLAUDE.md");
    expect(
      /apps\/streamdeck/.test(claude),
      "CLAUDE.md no longer mentions apps/streamdeck, so the next sweep that walks apps/* has nothing telling " +
        "it that the bundle it found is dead code",
    ).toBe(true);
  });
});

/**
 * The viewer page takes three URL parameters and README.md is the only place
 * they are written down. Neither side can see the other: `app.js` is served as
 * is and imports nothing, and a document cannot be typechecked.
 *
 * Both directions matter and they fail differently. A parameter the page reads
 * and nobody documents is a feature that exists for whoever reads the source -
 * `?settings=1` was exactly that for a while, and the iteration log records a
 * user never finding it. A parameter the README names and the page does not
 * read is worse: somebody follows the instruction, nothing happens, and there
 * is nothing to see - no error, no log, no wrong-looking page.
 */
describe("the viewer's URL parameters", () => {
  const app = read("packages/viewer/public/app.js");
  const readme = read("README.md");

  /** `params.get("x")` in the shipped page */
  const inCode = [...app.matchAll(/params\.get\("([a-z]+)"\)/g)].map((m) => m[1]);
  /** `?x=` or `&x=` in a code span in the README's viewer section */
  const inDocs = [...readme.matchAll(/`[?&]([a-z]+)=/g)].map((m) => m[1]);

  it("found some on both sides, so neither list is empty by accident", () => {
    expect(new Set(inCode).size, "app.js no longer reads any URL parameter").toBeGreaterThan(1);
    expect(new Set(inDocs).size, "README.md no longer names any").toBeGreaterThan(1);
  });

  it("documents every one the page acts on", () => {
    const undocumented = [...new Set(inCode)].filter((p) => !inDocs.includes(p));
    expect(
      undocumented,
      "the viewer page acts on a parameter README.md does not mention, so it exists for whoever reads the source",
    ).toEqual([]);
  });

  it("names none the page ignores", () => {
    const unread = [...new Set(inDocs)].filter((p) => !inCode.includes(p));
    expect(
      unread,
      "README.md tells a reader to add a parameter the page never looks at. They follow the instruction, " +
        "nothing happens, and nothing anywhere says why",
    ).toEqual([]);
  });
});
