import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { LANGUAGES, STT_MODELS, TRANSLATION_MODELS } from "../src/index";

/**
 * The Stream Deck property inspector is a plain script in the plugin folder
 * with no build step, so it cannot import the catalogue - it keeps its own copy
 * of every id. A copy drifts: whisper-small was dropped from the catalogue for
 * aborting the process and the inspector went on offering it, and the seven
 * archive models added later never appeared there at all.
 *
 * Picking an id the app does not know is a setting that silently does nothing.
 * A model missing from the list cannot be picked even when it is installed,
 * because the inspector filters the downloaded ones against this same list.
 */

const piPath = path.resolve(
  __dirname,
  "..", "..", "..",
  "apps/streamdeck/com.callout-relay.sdPlugin/pi/pi.js",
);
const pi = fs.readFileSync(piPath, "utf8");

/** the ids out of one `const NAME = [ ["id", "Label"], ... ];` block */
function ids(name: string): string[] {
  const start = pi.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`${name} is not declared in pi.js any more`);
  const end = pi.indexOf("];", start);
  return [...pi.slice(start, end).matchAll(/\["([^"]+)",/g)].map((m) => m[1]);
}

const catalogue = new Set(STT_MODELS.map((m) => m.id));

describe("what the property inspector offers", () => {
  it("only offers speech models the app still has", () => {
    const listed = [...ids("STT_MODELS"), ...ids("LOCAL_MODELS")];
    const gone = listed.filter((id) => !catalogue.has(id));
    expect(gone, `offered but not in the catalogue: ${gone.join(", ")}`).toEqual([]);
  });

  it("offers every local model the catalogue has", () => {
    // the downloaded-models filter runs over this list, so one missing here is
    // one that cannot be chosen from the Stream Deck however it was installed
    const listed = new Set(ids("LOCAL_MODELS"));
    const missing = STT_MODELS.filter((m) => m.provider === "local")
      .map((m) => m.id)
      .filter((id) => !listed.has(id));
    expect(missing, `installed but unreachable from the inspector: ${missing.join(", ")}`).toEqual([]);
  });

  it("offers every cloud model the catalogue has", () => {
    const listed = new Set(ids("STT_MODELS"));
    const missing = STT_MODELS.filter((m) => m.provider !== "local")
      .map((m) => m.id)
      .filter((id) => !listed.has(id));
    expect(missing).toEqual([]);
  });

  it("only offers translation models the app still has", () => {
    // the catalogue types these as literals, so the set has to be widened
    const known = new Set<string>(TRANSLATION_MODELS.map((m) => m.id));
    const gone = ids("TRANSLATION_MODELS").filter((id) => !known.has(id));
    expect(gone, `offered but unknown: ${gone.join(", ")}`).toEqual([]);
  });

  it("only offers languages the app still has", () => {
    const known = new Set(LANGUAGES.map((l) => l.code));
    const gone = ids("LANGUAGES").filter((code) => !known.has(code));
    expect(gone, `offered but unknown: ${gone.join(", ")}`).toEqual([]);
  });

  it("gives every entry a label", () => {
    for (const name of ["STT_MODELS", "LOCAL_MODELS", "TRANSLATION_MODELS", "LANGUAGES"]) {
      const start = pi.indexOf(`const ${name} = [`);
      const block = pi.slice(start, pi.indexOf("];", start));
      for (const [, id, label] of block.matchAll(/\["([^"]+)",\s*"([^"]*)"\]/g)) {
        expect(label.trim().length, `${name}/${id} has no label`).toBeGreaterThan(0);
      }
    }
  });
});
