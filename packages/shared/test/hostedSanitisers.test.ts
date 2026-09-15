import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_BRAND_NAME, MAX_SPEAKER_TAG, safeBrandName, safeSpeakerColor } from "../src/index";

/**
 * The hosted Worker keeps its own copy of three of this package's rules, and
 * says so: "Local copies of shared's `safeSpeakerColor` and `MAX_SPEAKER_TAG`,
 * because this Worker takes no dependencies on purpose."
 *
 * That is a deliberate duplication and it is fine. What was not fine is what
 * held the copies to the originals, which was nothing.
 * `apps/hosted-relay/test/sanitise.test.ts` has a test called "is capped at the
 * length the rest of the system uses" and another called "is capped at the same
 * 24 the app uses", and both assert a literal - `toBe(12)`, `toBe(24)`. Neither
 * reads what the rest of the system uses. Change the number here and every one
 * of them stays green while the two relays start cutting the same tag to
 * different lengths, which a viewer sees as the tag changing when they move
 * between a LAN link and an internet one.
 *
 * Read as text rather than imported, for the same reason `feedbackSizes.test.ts`
 * does it: importing `room.ts` would pull the Worker runtime's types into this
 * package's test, and the Worker not being importable is the whole reason the
 * copies exist.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const room = fs.readFileSync(path.join(root, "apps", "hosted-relay", "src", "room.ts"), "utf8");

/** `export const NAME = <number>;` as written in the Worker */
function constant(name: string): number | undefined {
  const m = new RegExp(`export const ${name} = (\\d+);`).exec(room);
  return m ? Number(m[1]) : undefined;
}

describe("the copies the hosted Worker keeps of this package's rules", () => {
  it("still has all three of them to compare against", () => {
    // a rename here is not a failure, it is a question: the copy moved, and
    // somebody has to say what it moved to
    expect(constant("MAX_SPEAKER_TAG"), "MAX_SPEAKER_TAG is not declared in room.ts any more").toBeDefined();
    expect(constant("MAX_BRAND_NAME"), "MAX_BRAND_NAME is not declared in room.ts any more").toBeDefined();
    expect(room, "room.ts no longer declares safeColor").toContain("export function safeColor");
  });

  it("cuts a speaker tag at the same length", () => {
    expect(
      constant("MAX_SPEAKER_TAG"),
      `shared caps a tag at ${MAX_SPEAKER_TAG} and the hosted relay at ${constant("MAX_SPEAKER_TAG")}, so the ` +
        "same tag is a different length depending on which relay a viewer happens to be on",
    ).toBe(MAX_SPEAKER_TAG);
  });

  it("cuts a brand name at the same length", () => {
    expect(constant("MAX_BRAND_NAME"), "the two relays disagree about how long a stream's name may be").toBe(
      MAX_BRAND_NAME,
    );
  });

  it("accepts the same colours", () => {
    // the pattern rather than the function: what can be imported here is this
    // package's, and what the Worker uses is a literal in its own file
    const m = /const v = value\.trim\(\)\.toLowerCase\(\);\s*return (\/[^/]+\/)\.test\(v\)/.exec(room);
    expect(m?.[1], "safeColor in room.ts no longer matches on a literal pattern this can read").toBeDefined();

    const shared = /^#[0-9a-f]{6}$/;
    expect(safeSpeakerColor("#e0a43a"), "the pattern this compares against is not the one shared uses").toBe(
      "#e0a43a",
    );
    expect(
      m?.[1],
      "the hosted relay accepts a different set of colours from the embedded one, so a colour that " +
        "reaches a LAN viewer may be dropped on the way to an internet one",
    ).toBe(shared.source.replace(/^/, "/").concat("/"));
  });

  it("keeps a brand name the same way", () => {
    // trim, then cut, then treat empty as absent - in that order. Cutting
    // before trimming turns 24 characters of spaces into a name.
    const body = /export function safeBrandName[\s\S]*?\n}/.exec(room)?.[0] ?? "";
    expect(body, "safeBrandName is gone from room.ts").not.toBe("");
    expect(
      body.replace(/\s+/g, " "),
      "the hosted relay builds a brand name differently from this package, so the header reads " +
        "differently depending on which relay the viewer reached",
    ).toBe(
      (
        "export function safeBrandName(value: unknown): string | undefined { " +
        "if (typeof value !== 'string') return undefined; " +
        "const v = value.trim().slice(0, MAX_BRAND_NAME); " +
        "return v.length > 0 ? v : undefined; }"
      ).replace(/'/g, '"'),
    );
    expect(safeBrandName("  a  "), "the shared one stopped trimming").toBe("a");
  });
});
