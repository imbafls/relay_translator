import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A suite nothing runs is decoration. CI checked the build, the typecheck and
 * the renderer ids, and the release workflow went from typecheck straight to
 * publish - so both the tests and the pre-existing smoke run only when someone
 * remembers. These assertions are deliberately crude greps: they are here to
 * notice a step being dropped, not to model GitHub Actions.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const read = (f: string): string => fs.readFileSync(path.join(root, ".github", "workflows", f), "utf8");

describe("CI runs what the repo can check", () => {
  const ci = read("ci.yml");

  it.each([
    ["the unit and integration suite", "pnpm test"],
    ["the tests' own typecheck, which pnpm -r typecheck cannot see", "pnpm typecheck:test"],
    ["the end-to-end smoke test", "pnpm smoke"],
    ["the renderer id check", "check-renderer-ids.mjs"],
  ])("runs %s", (_what, needle) => {
    expect(ci).toContain(needle);
  });

  it("checks the relay on Linux, since that is where it runs", () => {
    // every other job is windows-latest; the VPS is not
    expect(ci).toContain("ubuntu-latest");
    expect(ci).toContain("vitest run packages/relay packages/shared");
  });
});

describe("a release cannot go out unverified", () => {
  const release = read("release.yml");

  it.each([
    ["the suite", "pnpm test"],
    ["the tests' typecheck", "pnpm typecheck:test"],
    ["smoke", "pnpm smoke"],
  ])("runs %s before it builds the installer", (_what, needle) => {
    expect(release).toContain(needle);
    // and before the thing that produces what users install
    expect(release.indexOf(needle)).toBeLessThan(release.indexOf("electron-builder"));
  });

  it("still refuses a tag that disagrees with the app version", () => {
    expect(release).toContain("does not match apps/standalone version");
  });

  it("tests the relay on Linux before it builds the binary the VPS runs", () => {
    // `pnpm test` above runs on windows-latest and says nothing about the
    // platform the relay is deployed to. CI covers Linux on every push to
    // master, but a tag can be cut from any commit - including one CI never
    // saw - so the release needs its own Linux gate.
    const gate = "vitest run packages/relay packages/shared";
    expect(release).toContain(gate);
    // postject is what stamps the SEA blob into the binary that gets uploaded
    expect(release.indexOf(gate)).toBeLessThan(release.indexOf("postject"));
  });
});
