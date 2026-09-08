import { describe, expect, it } from "vitest";
import { MAX_BRAND_NAME, MAX_SPEAKER_TAG, safeBrandName, safeColor, safeSpeaker } from "../src/room";

/**
 * The publisher is only as trustworthy as the token it holds, and everything it
 * sends is drawn on somebody else's screen. The embedded relay has always
 * known that - `publisherHello()` caps the tag and drops a colour that is not
 * plainly #rrggbb - but this Worker forwarded both raw.
 *
 * That is the worse half to have missed. The embedded relay serves the LAN,
 * where the publisher and the viewer are usually the same person; this one is
 * the hop every internet viewer goes through, and it is the one no developer
 * tests against, because the LAN path works.
 */
describe("what the hosted relay will pass on", () => {
  describe("a speaker tag", () => {
    it("is capped at the length the rest of the system uses", () => {
      expect(MAX_SPEAKER_TAG).toBe(12);
      expect(safeSpeaker("x".repeat(500))).toHaveLength(12);
    });

    it("keeps a normal tag exactly as it was", () => {
      expect(safeSpeaker("OMER")).toBe("OMER");
      expect(safeSpeaker("CHAT")).toBe("CHAT");
    });

    it("passes on nothing when there is nothing to pass on", () => {
      expect(safeSpeaker(undefined)).toBeUndefined();
      expect(safeSpeaker(null)).toBeUndefined();
      // a number would reach `.slice` and throw inside the fan-out, which on a
      // Durable Object means the caption never reaches anybody
      expect(safeSpeaker(42)).toBeUndefined();
      expect(safeSpeaker({ toString: () => "x".repeat(50) })).toBeUndefined();
    });
  });

  describe("a colour", () => {
    it("accepts six-digit hex, in either case", () => {
      expect(safeColor("#e0a43a")).toBe("#e0a43a");
      expect(safeColor("#E0A43A")).toBe("#e0a43a");
      expect(safeColor("  #e0a43a  ")).toBe("#e0a43a");
    });

    it("drops anything that is not that, rather than escaping it", () => {
      // the viewer sets this through style.setProperty, which would ignore junk
      // anyway - but the two relays should agree on what they hand over
      expect(safeColor("red")).toBeUndefined();
      expect(safeColor("#fff")).toBeUndefined();
      expect(safeColor("#e0a43a; background: url(http://evil/)")).toBeUndefined();
      expect(safeColor("javascript:alert(1)")).toBeUndefined();
      expect(safeColor(undefined)).toBeUndefined();
      expect(safeColor(123456)).toBeUndefined();
    });
  });

  describe("a brand name", () => {
    it("is capped at the same 24 the app uses", () => {
      expect(MAX_BRAND_NAME).toBe(24);
      expect(safeBrandName("x".repeat(500))).toHaveLength(24);
    });

    it("keeps an ordinary name and trims a padded one", () => {
      expect(safeBrandName("Omer's stream")).toBe("Omer's stream");
      expect(safeBrandName("  Relay  ")).toBe("Relay");
    });

    it("treats blank and non-strings as unbranded", () => {
      expect(safeBrandName("")).toBeUndefined();
      expect(safeBrandName("   ")).toBeUndefined();
      expect(safeBrandName(undefined)).toBeUndefined();
      // a number would reach `.trim` and throw inside the fan-out, and on a
      // Durable Object that means the hello reaches nobody
      expect(safeBrandName(42)).toBeUndefined();
    });
  });
});
