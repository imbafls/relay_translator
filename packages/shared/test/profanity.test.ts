import { describe, expect, it } from "vitest";
import { maskProfanity } from "../src/index";

/**
 * The filter runs on every caption that reaches a viewer, including the interim
 * partials that flash on a live broadcast. Two failure modes matter, and they
 * pull in opposite directions:
 *
 *   - a word gets through and lands on stream
 *   - ordinary speech gets mangled, the streamer stops trusting it, and turns
 *     it off - after which nothing is filtered at all
 *
 * The second is the one that actually breaks the feature, so most of what is
 * asserted here is what must NOT be masked.
 */

describe("masks what it is meant to", () => {
  it.each([
    ["fuck", "f***"],
    ["shit", "s***"],
    ["bitch", "b****"],
    ["cunt", "c***"],
  ])("masks %s", (word, masked) => {
    expect(maskProfanity(word)).toBe(masked);
  });

  it("keeps the first letter and the length, so the line does not reflow", () => {
    const out = maskProfanity("what the fuck");
    expect(out).toBe("what the f***");
    expect(out).toHaveLength("what the fuck".length);
  });

  it("catches the ordinary inflections from one stem", () => {
    expect(maskProfanity("fucks fucked fucking fucker fuckers")).toBe(
      "f**** f***** f****** f***** f******",
    );
  });

  it("is case-insensitive but preserves the case it found", () => {
    expect(maskProfanity("Fuck FUCK fuck")).toBe("F*** F*** f***");
  });

  it("masks a word sitting against punctuation", () => {
    expect(maskProfanity("oh, shit! shit? (shit)")).toBe("oh, s***! s***? (s***)");
  });

  it("masks every occurrence, not just the first", () => {
    expect(maskProfanity("shit shit shit")).toBe("s*** s*** s***");
  });
});

describe("leaves ordinary speech alone", () => {
  // the Scunthorpe problem: every one of these contains a masked stem as a
  // substring, and every one is a word a caller says in a normal callout
  it.each([
    "class",
    "pass",
    "passed",
    "assume",
    "assassin",
    "bass",
    "glasses",
    "mass",
    "compass",
    "embassy",
    "cocktail",
    "shitake",
    "titan",
    "titles",
    "analysis",
    "Scunthorpe",
    "dickens",
    "hancock",
    "grass",
    "brass",
  ])("does not touch %s", (word) => {
    expect(maskProfanity(word)).toBe(word);
  });

  it("leaves a whole clean sentence untouched", () => {
    const line = "he is pushing through mid, take the class angle past the bass drum";
    expect(maskProfanity(line)).toBe(line);
  });

  it("does not mask the mild words a broadcast filter is not for", () => {
    const line = "damn, this is hell, what a crap round";
    expect(maskProfanity(line)).toBe(line);
  });
});

describe("degenerate input", () => {
  it("returns empty and whitespace unchanged", () => {
    expect(maskProfanity("")).toBe("");
    expect(maskProfanity("   ")).toBe("   ");
  });

  it("is stable when run twice - a masked line has nothing left to mask", () => {
    const once = maskProfanity("what the fuck");
    expect(maskProfanity(once)).toBe(once);
  });

  it("does not chase obfuscation, and says so by leaving it", () => {
    // documented non-goal: the STT emits ordinary words, and guessing at
    // substitution is where a filter starts eating real speech
    expect(maskProfanity("f*ck sh1t")).toBe("f*ck sh1t");
  });
});
