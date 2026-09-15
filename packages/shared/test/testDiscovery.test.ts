import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * That every test in this repo is actually run.
 *
 * Nothing said so. `vitest.config.ts` collects by glob, and narrowing one -
 * `packages/*​/test/*.test.ts` instead of `**​/*.test.ts`, say - drops whole
 * files silently. The suite still passes, faster, with a smaller number beside
 * it that nobody has a reason to question. It is this run's fifth lesson in its
 * purest form: a checker that reports success having read less than it should
 * looks exactly like one that read everything.
 *
 * Neither half of this proves it alone, and together they do:
 *
 *  1. every test file on disk sits under `<package>/test/`, and
 *  2. the config collects exactly `{packages,apps}/*​/test/**​/*.test.ts`
 *
 * so every test file is collected. Written as two plain assertions rather than
 * by re-implementing glob matching, because a hand-rolled matcher would be a
 * second opinion about what vitest does - and this repo has spent a run
 * deleting second opinions about what other code does.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const config = fs.readFileSync(path.join(root, "vitest.config.mts"), "utf8");

/** the `include: [...]` array, as written */
function includePatterns(): string[] {
  const body = /include\s*:\s*\[([\s\S]*?)\]/.exec(config)?.[1] ?? "";
  return [...body.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1] ?? "");
}

/** every file that looks like a test, wherever it is */
function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  for (const group of ["packages", "apps"]) walk(path.join(root, group));
  return out.sort();
}

describe("running every test there is", () => {
  it("collects from exactly the two places tests are kept", () => {
    expect(
      includePatterns().sort(),
      "the collection globs changed; anything they no longer reach stops running silently",
    ).toEqual(["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"]);
  });

  it("keeps every test file somewhere those globs reach", () => {
    const stranded = testFiles().filter((f) => !/^(packages|apps)\/[^/]+\/test\/.+\.test\.ts$/.test(f));
    expect(
      stranded,
      "these look like tests and sit where the globs do not reach, so they never run:\n" + stranded.join("\n"),
    ).toEqual([]);
  });

  it("found the config and the files, so neither assertion above is vacuous", () => {
    expect(includePatterns().length, "no include globs were read out of vitest.config.mts").toBe(2);
    expect(testFiles().length).toBeGreaterThan(50);
  });
});
