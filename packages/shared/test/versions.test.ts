import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Everything shipped from this repo is shipped together, so everything that
 * states a version has to state the same one. The release workflow already
 * refuses a tag that disagrees with apps/standalone - this covers the rest,
 * which nothing checked.
 *
 * Every workspace package carries the same version, and `pnpm version-bump`
 * did not know about it, and it sat at 0.1.0 through five releases. Elgato both
 * displays that number and uses it to decide a plugin is newer, so a stuck one
 * reads as a plugin that has never been updated.
 */

const root = path.resolve(__dirname, "..", "..", "..");

const read = (rel: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

/** every workspace package.json, plus the root */
function packageFiles(): string[] {
  const out = ["package.json"];
  for (const group of ["apps", "packages"]) {
    for (const name of fs.readdirSync(path.join(root, group))) {
      const rel = `${group}/${name}/package.json`;
      if (fs.existsSync(path.join(root, rel))) out.push(rel);
    }
  }
  return out;
}


const appVersion = read("apps/standalone/package.json").version as string;

describe("everything ships as one version", () => {
  it("found the files it means to check", () => {
    expect(packageFiles().length).toBeGreaterThan(5);
  });

  it("agrees across every workspace package", () => {
    const odd = packageFiles()
      .map((f) => [f, read(f).version as string] as const)
      .filter(([, v]) => v !== appVersion);
    expect(odd, `these disagree with ${appVersion}: ${odd.map(([f, v]) => `${f}=${v}`).join(", ")}`).toEqual([]);
  });


  it("is a version the tooling will accept", () => {
    expect(appVersion).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });
});

describe("the bump script reaches everything above", () => {
  const bump = fs.readFileSync(path.join(root, "scripts/version-bump.mjs"), "utf8");

  it("rewrites package.json files", () => {
    expect(bump).toContain("apps/*/package.json");
    expect(bump).toContain("packages/*/package.json");
  });

});

describe("a release has notes to publish", () => {
  const changelog = fs.readFileSync(path.join(root, "packages/shared/src/changelog.ts"), "utf8");

  it("has a changelog entry for the version being shipped", () => {
    // the release notes and the app's what's-new panel come from one source, so
    // a version with no entry ships a release page with nothing on it
    expect(changelog, `no changelog entry for ${appVersion}`).toContain(`version: "${appVersion}"`);
  });

  it("keeps the generator that turns it into release notes", () => {
    const script = fs.readFileSync(path.join(root, "scripts/release-notes.mjs"), "utf8");
    expect(script).toContain("CHANGELOG");
  });
});

/**
 * CLAUDE.md states the repo's version in the present tense, and that sentence
 * is the first thing a new session reads about what it is working on.
 *
 * `versions.test.ts` above holds every package.json to one number, and the
 * release workflow refuses a tag that disagrees with `apps/standalone`. The
 * PROSE copy of that number was held by nothing, so it stayed at 0.8.0 through
 * the 0.8.1 release and a session reading the orientation page would have taken
 * the wrong version into `pnpm version-bump`.
 *
 * Only the present-tense claim is checked. Elsewhere the file says things like
 * "rewritten at v0.8.0", which is provenance - a statement about when something
 * happened, true for ever - and holding those to the current version would be
 * asking the document to lie about its own history.
 */
describe("what CLAUDE.md says the repo's version is", () => {
  const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");

  it("states one at all, in a form this can find", () => {
    expect(
      claude,
      "CLAUDE.md no longer states the repo version as `version \`x.y.z\``, so this checks nothing",
    ).toMatch(/version `\d+\.\d+\.\d+`/);
  });

  it("states the one the packages actually carry", () => {
    const stated = /version `(\d+\.\d+\.\d+)`/.exec(claude)?.[1];
    expect(
      stated,
      `CLAUDE.md tells a new session this repo is version ${stated}; every package.json says ${appVersion}. ` +
        "That sentence is the first thing read about the tree, and the release process starts from it.",
    ).toBe(appVersion);
  });
});
