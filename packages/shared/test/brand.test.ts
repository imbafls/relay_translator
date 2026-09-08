import { describe, expect, it } from "vitest";
import { MAX_BRAND_NAME, safeBrandName } from "../src/index";

/**
 * A brand name is drawn on a public page, chosen by whoever holds the publish
 * token. It is capped rather than trusted, and a value that is not a string is
 * dropped rather than coerced - `String(x)` on an object would put "[object
 * Object]" on somebody's screen.
 */
describe("a brand name", () => {
  it("keeps an ordinary name as it was", () => {
    expect(safeBrandName("Omer's stream")).toBe("Omer's stream");
  });

  it("caps a long one at the documented limit", () => {
    expect(MAX_BRAND_NAME).toBe(24);
    expect(safeBrandName("x".repeat(500))).toHaveLength(24);
  });

  it("trims, because a padded name looks like a layout bug", () => {
    expect(safeBrandName("  Relay  ")).toBe("Relay");
  });

  it("treats blank as unbranded rather than as an empty label", () => {
    expect(safeBrandName("")).toBeUndefined();
    expect(safeBrandName("   ")).toBeUndefined();
  });

  it("drops anything that is not a string", () => {
    expect(safeBrandName(undefined)).toBeUndefined();
    expect(safeBrandName(null)).toBeUndefined();
    expect(safeBrandName(42)).toBeUndefined();
    expect(safeBrandName({ toString: () => "sneaky" })).toBeUndefined();
  });
});
