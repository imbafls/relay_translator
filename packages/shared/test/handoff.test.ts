import { describe, expect, it } from "vitest";
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
