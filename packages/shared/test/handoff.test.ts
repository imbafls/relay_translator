import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

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

const DOCS = ["HANDOFF.md", "CLAUDE.md", "docs/OPEN-WORK.md"] as const;
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
