import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The environment variables this project tells people to set, against the ones
 * it reads.
 *
 * This contract has already failed here once. Commits `85706ca` and `9f0c393`
 * exist because the app's KEYS field carried a placeholder naming a variable
 * the code did not read, so a self-hoster set it, the relay minted random
 * tokens instead (`loadState` step 4), and the token the desktop app needed
 * existed only inside a file on the box. CLAUDE.md still records the fix as
 * "the name the code actually reads".
 *
 * Nothing holds it. A name lives in four user-facing places - the `.env`
 * template a self-hoster copies, README's self-hosting steps, CLAUDE.md, and
 * an `<input placeholder>` a user reads while pasting a token - and in
 * `process.env.X` lookups scattered across the source. Rename the lookup and
 * all four go on instructing people to set something nothing will ever read.
 * There is no error to see: the variable is simply ignored.
 *
 * **One direction only, and deliberately.** A name in a document that the code
 * does not read is a false instruction. The reverse - a variable the code reads
 * and no document mentions - is ordinary: `RELAY_MOCK_STT`, `RELAY_MOCK_GEMINI`
 * and `CALLOUT_RELAY_DATA` are internal and belong in no self-hosting guide.
 *
 * **Only names this project defines.** `APPDATA` is Windows',
 * `PORTABLE_EXECUTABLE_FILE` is electron-builder's and `GITHUB_REF_NAME` is
 * Actions'; this project cannot rename any of them, so their appearance in a
 * document says nothing about this repo's consistency.
 *
 * **History files are not instructions.** `ITERATION_LOG.md` and `HANDOFF.md`
 * describe what happened, and a turn that names a variable since renamed is
 * accurate history rather than a stale instruction - the same distinction
 * `versions.test.ts` draws between a present-tense claim and provenance.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");

/**
 * Source with its comments removed. A commented-out `process.env.X` is not a
 * read, and counting it as one is not academic: comment out the
 * `RELAY_VIEWER_TOKEN` lookup and every document goes on telling self-hosters
 * to set it while this stays green - which is the incident `85706ca` exists
 * because of, arriving through the guard meant to prevent it.
 */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** the namespaces this project owns, and can therefore rename */
const OURS = /^(RELAY|CALLOUT_RELAY|DEEPGRAM|GEMINI)_[A-Z0-9_]+$/;

/** every source file, found rather than listed - the id checker's lesson */
function sourceFiles(dir: string, out: string[] = []): string[] {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return out;
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") sourceFiles(rel, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
      out.push(rel);
    }
  }
  return out;
}

function readByCode(): Set<string> {
  const found = new Set<string>();
  const files = [
    ...sourceFiles("packages/relay/src"),
    ...sourceFiles("packages/companion/src"),
    ...sourceFiles("packages/shared/src"),
    ...sourceFiles("apps/standalone/src"),
  ];
  for (const rel of files) {
    const src = code(read(rel));
    for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) if (OURS.test(m[1] ?? "")) found.add(m[1] ?? "");
    for (const m of src.matchAll(/process\.env\[\s*["'`]([A-Z0-9_]+)["'`]\s*\]/g)) {
      if (OURS.test(m[1] ?? "")) found.add(m[1] ?? "");
    }
  }
  return found;
}

/** the places that tell a person to set one */
const TELLERS = [
  // the file a self-hoster copies to /opt/callout-relay/.env
  "packages/relay/sea/vps.env.example",
  "README.md",
  "CLAUDE.md",
  // the placeholder in the KEYS field - the one that was wrong before
  "apps/standalone/renderer/index.html",
];

describe("environment variables the project tells people to set", () => {
  const known = readByCode();

  it("finds the ones the code reads, so the checks below mean something", () => {
    expect(
      [...known].sort(),
      "the scan for process.env lookups found nothing recognisable, so every document below would pass",
    ).toContain("RELAY_PUBLISHER_TOKEN");
    expect(known.size, "too few env lookups found - the source walk is broken, not the docs").toBeGreaterThan(4);
  });

  describe.each(TELLERS)("%s", (rel) => {
    it("names only variables the code actually reads", () => {
      const text = read(rel);
      const named = new Set<string>();
      for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) if (OURS.test(m[1] ?? "")) named.add(m[1] ?? "");

      const unread = [...named].filter((n) => !known.has(n));
      expect(
        unread,
        `${rel} tells a reader to set ${unread.join(", ")}, and nothing in the source reads it. There is no ` +
          "error when that happens - the variable is ignored and the relay falls back, which is how a " +
          "self-hoster ends up with tokens that exist only on the box",
      ).toEqual([]);
    });
  });

  it("still names some, or every document above passes by saying nothing", () => {
    const total = TELLERS.reduce((n, rel) => {
      const text = read(rel);
      return n + [...text.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)].filter((m) => OURS.test(m[1] ?? "")).length;
    }, 0);
    expect(total, "no document names any of this project's environment variables any more").toBeGreaterThan(5);
  });
});
