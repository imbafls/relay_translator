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

/**
 * That every test inside those files is actually run, too.
 *
 * The block above proves vitest COLLECTS every file. It says nothing about
 * what happens once a file is open. `it.only` left behind after a debugging
 * session silences every other test in its file; `it.skip` and `it.todo`
 * silence one on purpose and then outlive the purpose. In all three cases the
 * suite is green, the file count is unchanged - and the count of tests is not
 * quoted anywhere, deliberately, because CLAUDE.md found that number drifted
 * twice in two days and dropped it. So nothing at all would notice.
 *
 * Lesson 3 in this repo's own list opens with "a skip that passed".
 *
 * The patterns are assembled rather than written out, because a guard that
 * greps for `.only(` and contains `.only(` reports itself and looks broken on
 * the day it is needed.
 */
describe("tests that are present but not running", () => {
  const MODIFIERS = ["only", "skip", "todo", "skipIf", "runIf", "fails", "concurrent"] as const;
  /** the three that mean "this does not run as written" */
  const SILENCING = ["only", "skip", "todo"] as const;

  const offenders = (): { file: string; hits: string[] }[] =>
    testFiles()
      .map((rel) => {
        const src = fs.readFileSync(path.join(root, rel), "utf8");
        const hits: string[] = [];
        for (const runner of ["it", "test", "describe"]) {
          for (const mod of SILENCING) {
            // built up so this file does not match itself
            const needle = `${runner}.${mod}` + "(";
            if (src.includes(needle)) hits.push(needle);
          }
        }
        return { file: rel, hits };
      })
      .filter((f) => f.hits.length > 0);

  it("reads the files, so an empty answer means something", () => {
    const files = testFiles();
    expect(files.length, "no test files were found at all, so the check below is vacuous").toBeGreaterThan(50);
    // and the matcher must be able to find a modifier when one is there
    const probe = `it.${MODIFIERS[0]}` + "(";
    expect(`${probe} () => {}`.includes(probe), "the matcher cannot find a modifier it built itself").toBe(true);
  });

  it("has none focused, skipped or left as a todo", () => {
    const found = offenders();
    expect(
      found.map((f) => `${f.file}: ${f.hits.join(", ")}`),
      "these files carry tests that do not run as written. A focused test silences the rest of its file and " +
        "leaves the suite green, and nothing here quotes a test count that would drop.",
    ).toEqual([]);
  });
});
