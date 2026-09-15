import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ts from "typescript";

/**
 * The repo has no linter and does not need one for the rules that matter. The
 * compiler already offers them, they cost no dependency, and `pnpm -r build`,
 * `pnpm -r typecheck` and `pnpm typecheck:test` already run it - so turning
 * them on in tsconfig.base.json wires them into the gate and into CI with no
 * new step to forget.
 *
 * What this guards is not the text of the base config but the options every
 * project RESOLVES to. A package that extends the base and quietly sets
 * `"noUnusedLocals": false` for itself would leave the base looking correct
 * and the rule off where the code is, which is exactly the shape a guard
 * written against the base file would miss.
 *
 * Style is deliberately absent. There is no formatter and no brace rule here;
 * every one of these reports a thing that is wrong, not a thing that is
 * untidy.
 */

const root = path.resolve(__dirname, "..", "..", "..");

/** what every project must resolve to, and why it is worth an error */
const REQUIRED: Record<string, boolean> = {
  // a value that is never read is usually the residue of a mistake - a result
  // meant to be checked, an import whose only use moved away
  noUnusedLocals: true,
  noUnusedParameters: true,
  // a function that returns a value on one path and falls off the end on
  // another returns undefined to a caller that is not expecting it
  noImplicitReturns: true,
  // the classic missing `break`
  noFallthroughCasesInSwitch: true,
  // code after a return is either dead or the return is in the wrong place
  allowUnreachableCode: false,
  allowUnusedLabels: false,
  // a method that no longer overrides anything still looks like it does
  noImplicitOverride: true,
  strict: true,
};

/**
 * Required of the projects that ship, and deliberately NOT of the test project.
 *
 * `noUncheckedIndexedAccess` types every `arr[i]` as possibly undefined. In
 * shipping code that is the point: it found the mock STT publishing
 * `undefined` as a caption when handed an empty script. In tests it is
 * ceremony - they index straight after asserting what they just built, a wrong
 * index fails the test it is in, and turning it on there reports 232 sites that
 * would each gain a guard against nothing. Measured, not assumed - see the card.
 */
const SOURCE_ONLY: Record<string, boolean> = {
  noUncheckedIndexedAccess: true,
};

/** the one project whose files are tests rather than shipped code */
const TEST_PROJECT = "tsconfig.test.json";

/** every tsconfig the gate actually runs, found rather than listed */
function projectConfigs(): string[] {
  const dirs = [root, ...["packages", "apps"].flatMap((group) => {
    const base = path.join(root, group);
    if (!fs.existsSync(base)) return [];
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(base, e.name));
  })];

  return dirs
    .flatMap((dir) =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && /^tsconfig\..*json$|^tsconfig\.json$/.test(e.name))
        .map((e) => path.join(dir, e.name)),
    )
    .filter((p) => path.basename(p) !== "tsconfig.base.json")
    .sort();
}

/** the resolved compilerOptions of one config, inheritance applied */
function resolved(configPath: string): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, " "));
    },
  } as ts.ParseConfigFileHost);
  if (!parsed) throw new Error(`could not parse ${configPath}`);
  return parsed.options;
}

/** "<config>: <flag> is <actual>, not <required>" for each rule not in force */
function violations(configPath: string): string[] {
  const options = resolved(configPath) as Record<string, unknown>;
  const rel = path.relative(root, configPath).split(path.sep).join("/");
  const rules = rel === TEST_PROJECT ? REQUIRED : { ...REQUIRED, ...SOURCE_ONLY };
  return Object.entries(rules)
    .filter(([flag, want]) => options[flag] !== want)
    .map(([flag, want]) => `${rel}: ${flag} is ${String(options[flag])}, not ${String(want)}`);
}

describe("the check itself", () => {
  it("catches a project that extends the base and opts back out", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-tsconfig-"));
    try {
      const optedOut = path.join(dir, "tsconfig.json");
      fs.writeFileSync(
        optedOut,
        JSON.stringify({
          extends: path.join(root, "tsconfig.base.json"),
          compilerOptions: { noUnusedLocals: false, allowUnreachableCode: true },
        }),
        "utf8",
      );

      // the base is correct and this config still is not, which is the whole
      // reason the assertion is written against the resolved options. It also
      // means this fixture only reports the two it opted out of, so a base
      // that stopped setting the rest would turn this red too.
      const flags = violations(optedOut).map((v) => v.split(": ")[1]?.split(" ")[0]);
      expect(flags?.sort()).toEqual(["allowUnreachableCode", "noUnusedLocals"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("correctness rules", () => {
  it("are in force in every project the gate typechecks", () => {
    const bad = projectConfigs().flatMap(violations);
    expect(bad, `these projects do not enforce the rules:\n${bad.join("\n")}`).toEqual([]);
  });

  it("found the configs to check, so the assertion above means something", () => {
    const found = projectConfigs().map((p) => path.relative(root, p).split(path.sep).join("/"));
    // the root test config plus one per package and app that has source
    expect(found).toContain("tsconfig.test.json");
    expect(found).toContain("packages/relay/tsconfig.json");
    expect(found).toContain("apps/standalone/tsconfig.typecheck.json");
    expect(found.length).toBeGreaterThanOrEqual(7);
  });
});
