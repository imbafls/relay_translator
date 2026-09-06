import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Everything shipped from this repo is shipped together, so everything that
 * states a version has to state the same one. The release workflow already
 * refuses a tag that disagrees with apps/standalone - this covers the rest,
 * which nothing checked.
 *
 * The Stream Deck manifest is why: it is not a package.json, `pnpm version-bump`
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

/** any Stream Deck plugin manifest under apps/ */
function manifestFiles(): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(path.join(root, "apps"))) {
    const dir = path.join(root, "apps", name);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".sdPlugin")) continue;
      const rel = `apps/${name}/${entry}/manifest.json`;
      if (fs.existsSync(path.join(root, rel))) out.push(rel);
    }
  }
  return out;
}

const appVersion = read("apps/standalone/package.json").version as string;

describe("everything ships as one version", () => {
  it("found the files it means to check", () => {
    expect(packageFiles().length).toBeGreaterThan(5);
    expect(manifestFiles().length).toBeGreaterThan(0);
  });

  it("agrees across every workspace package", () => {
    const odd = packageFiles()
      .map((f) => [f, read(f).version as string] as const)
      .filter(([, v]) => v !== appVersion);
    expect(odd, `these disagree with ${appVersion}: ${odd.map(([f, v]) => `${f}=${v}`).join(", ")}`).toEqual([]);
  });

  it("agrees in the Stream Deck manifest, which is not a package.json", () => {
    const odd = manifestFiles()
      .map((f) => [f, read(f).Version as string] as const)
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

  it("rewrites the Stream Deck manifest too", () => {
    // without this the manifest is the one file a release cannot move
    expect(bump).toContain("manifest.json");
    expect(bump).toContain('"Version"');
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
