import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `checkFloatingPromises.test.ts` asserts the checker gives the right answer
 * about the files it reads. This asserts it reads all of them.
 *
 * The distinction is not academic. The checker shipped carrying a hardcoded
 * list of projects, and that list went stale two iterations later, the first
 * time a package gained a tsconfig: `packages/viewer/public/app.js` - the page
 * a phone actually loads - was never scanned, and the run said "no floating
 * promises" without ever opening it. That is the same shape as the checker
 * exiting 0 having scanned nothing, one level up, and it reads exactly like a
 * clean result.
 *
 * So coverage is asserted against the filesystem rather than against a list
 * anybody has to remember to update.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const script = path.join(root, "scripts/check-floating-promises.mjs");

/** what the checker says it read */
function scanned(): string[] {
  const out = execFileSync(process.execPath, [script, "--list"], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
  return out.split(/\r?\n/).filter(Boolean);
}

/**
 * Every file that ships. Tests are excluded for the reason the checker states:
 * a floating promise in a test shows up as that test failing or going flaky.
 * Build output and vendored code are not ours.
 */
function shippedSources(): string[] {
  const skipDir = new Set(["node_modules", "dist", "test", "sea", "release", "fonts"]);
  const found: string[] = [];

  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDir.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|js|mjs)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
        found.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };

  for (const group of ["packages", "apps"]) {
    const base = path.join(root, group);
    if (!fs.existsSync(base)) continue;
    for (const pkg of fs.readdirSync(base)) {
      walk(path.join(base, pkg, "src"));
      // the two front-ends live outside src/ because they are served, not built
      walk(path.join(base, pkg, "renderer"));
      walk(path.join(base, pkg, "public"));
    }
  }
  return found.sort();
}

describe("the floating-promise checker's reach", () => {
  it("reads every source file that ships", () => {
    const covered = new Set(scanned());
    const missing = shippedSources().filter((f) => !covered.has(f));
    expect(
      missing,
      `the checker never opens these, so a floating promise in one of them would be reported as clean:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("found files on both sides, so the comparison means something", () => {
    // an empty walk would make the assertion above pass while proving nothing,
    // which is the failure this whole test exists to catch
    expect(shippedSources().length).toBeGreaterThan(20);
    expect(scanned().length).toBeGreaterThan(20);
  });

  it("reaches the two front-ends, which are the easiest to leave out", () => {
    // neither lives under src/: one is served as-is, the other is loaded by
    // Electron from its own folder, and the viewer is the one that was missed
    const covered = scanned();
    expect(covered).toContain("packages/viewer/public/app.js");
    expect(covered).toContain("apps/standalone/renderer/app.ts");
  });
});
