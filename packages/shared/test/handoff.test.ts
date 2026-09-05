import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * HANDOFF.md is the first thing a new session or a new machine reads, so a
 * stale claim in it costs more than a stale comment. It had already misled
 * once: it told this loop the repo had no test runner long after it had one.
 *
 * These are deliberately narrow - a document cannot be asserted true, but a
 * command it tells you to run either exists or does not.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const handoff = fs.readFileSync(path.join(root, "HANDOFF.md"), "utf8");
const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts as Record<
  string,
  string
>;

/** every `pnpm <name>` the document tells you to run, minus pnpm's own verbs */
function pnpmScripts(): string[] {
  const builtin = new Set(["install", "add", "exec", "dlx", "run", "why", "store", "approve-builds"]);
  return [...handoff.matchAll(/\bpnpm (?:--filter \S+ )?([a-z][\w:-]*)/g)]
    .map((m) => m[1])
    .filter((name) => !builtin.has(name));
}

describe("the handoff tells you to run things that exist", () => {
  it("names some commands, so the check means something", () => {
    expect(new Set(pnpmScripts()).size).toBeGreaterThan(3);
  });

  it("names only scripts the repo actually has", () => {
    const unknown = [...new Set(pnpmScripts())].filter((name) => !(name in scripts));
    expect(unknown, `HANDOFF.md tells you to run: ${unknown.join(", ")}`).toEqual([]);
  });

  it("points at files that are still there", () => {
    // longest extension first: alternation is ordered, so `js` before `json`
    // silently truncates package.json to package.js
    const referenced = [...handoff.matchAll(/\b((?:scripts|packages|apps)\/[\w./-]+\.(?:json|mjs|ts|js))/g)].map(
      (m) => m[1],
    );
    const missing = [...new Set(referenced)].filter((rel) => !fs.existsSync(path.join(root, rel)));
    expect(missing, `HANDOFF.md points at: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not still claim there is no test runner", () => {
    // the exact staleness that propagated into a whole run of work
    expect(handoff).not.toMatch(/no test runner/i);
    expect(scripts.test).toBeTruthy();
  });
});
