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

/**
 * Every step of the gate, rather than the three that happened to be listed.
 *
 * CLAUDE.md calls those six commands "what CI runs and what a release must
 * pass". The check above pins `pnpm test`, `pnpm typecheck:test` and
 * `pnpm smoke`, which left three unwatched - including
 * `node scripts/check-renderer-ids.mjs`, a checker this repo wrote on purpose,
 * made a gate step, and guards the internals of in `checkRendererIds.test.ts`,
 * while nothing asserted CI ever ran it. Drop that line from the workflow and a
 * dangling element id ships in an installer, with the suite green and the page
 * failing silently in a browser nobody is watching - which is the exact failure
 * that checker exists to prevent.
 *
 * The list is read out of CLAUDE.md rather than written here. Four copies of it
 * already exist - the doc, the release workflow, the CI workflow and the
 * protocol the improvement loop follows - and a fifth that could disagree with
 * the others is worth less than none. Adding a seventh step to the documented
 * gate now requires the workflow to run it.
 */
describe("the whole gate, as the orientation doc defines it", () => {
  const claude = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "CLAUDE.md"), "utf8");

  /** the backticked commands in the "full gate" sentence */
  function gateSteps(): string[] {
    const sentence = /The full gate[^.]*?is:\s*([\s\S]*?)\.\s*\n/.exec(claude)?.[1] ?? "";
    return [...sentence.matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
  }

  it("is six steps, read from the doc rather than repeated here", () => {
    // if the sentence is ever reworded past recognition this says so, instead
    // of quietly checking an empty list against the workflow
    expect(gateSteps()).toEqual([
      "pnpm -r build",
      "pnpm -r typecheck",
      "pnpm typecheck:test",
      "pnpm test",
      "node scripts/check-renderer-ids.mjs",
      "pnpm smoke",
    ]);
  });

  it("is run in full before anything a user could install is produced", () => {
    const release = read("release.yml");
    const builder = release.indexOf("electron-builder");
    expect(builder, "the release no longer builds an installer").toBeGreaterThan(-1);

    const missing = gateSteps().filter((step) => !release.includes(`run: ${step}`));
    expect(missing, `the gate says these run and release.yml does not: ${missing.join(", ")}`).toEqual([]);

    const late = gateSteps().filter((step) => release.indexOf(`run: ${step}`) > builder);
    expect(late, `these run after the installer is already built: ${late.join(", ")}`).toEqual([]);
  });
});
