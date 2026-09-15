import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Every colour the viewer puts readable text in, against the background it sits
 * on, in every theme the display bar offers.
 *
 * The phone viewer is read at a distance, often in bright light, by somebody who
 * is reading it *because* they cannot hear the room. Contrast is the one part of
 * that which needs no judgement at all - WCAG gives a number, the palette gives
 * hexes, and the two can be multiplied out. Nothing in this repo had ever done
 * so, and DESIGN.md's own annotation for `--dim` turned out to be off.
 *
 * WCAG 2.1 AA wants 4.5:1 for normal text. Every colour checked here lands on
 * text at 10.5-21px, so 4.5 is the bar for all of them.
 *
 * `--mute` is deliberately exempt: DESIGN.md calls it "for disabled/ghost only -
 * never for text the user must read", so holding it to a readability threshold
 * would assert the opposite of the spec.
 *
 * WHAT THIS DOES NOT CHECK, so the gap is not mistaken for an oversight: the
 * reader's OWN colours. The display bar lets them pick any three they like, and
 * that is their screen. What the product is answerable for is the themes it
 * ships, and those are what this reads out of the source.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const viewerDir = path.join(root, "packages", "viewer", "public");
const appJs = fs.readFileSync(path.join(viewerDir, "app.js"), "utf8");
const css = fs.readFileSync(path.join(viewerDir, "style.css"), "utf8");

/** WCAG 2.1 relative luminance */
function luminance(hex: string): number {
  const n = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(n[0]) + 0.7152 * lin(n[1]) + 0.0722 * lin(n[2]);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** the themes the display bar ships, read out of app.js rather than restated here */
function themes(): Record<string, { fg: string; accent: string; bg: string }> {
  const dark = /const DARK = \{([^}]*)\}/.exec(appJs);
  const table = /const THEMES = \{([\s\S]*?)\n  \};/.exec(appJs);
  if (!dark || !table) throw new Error("could not find DARK / THEMES in the shipped app.js");
  const fields = (body: string): { fg: string; accent: string; bg: string } => {
    const pick = (k: string): string => {
      const m = new RegExp(`${k}:\\s*"(#[0-9a-fA-F]{6})"`).exec(body);
      if (!m) throw new Error(`no ${k} in theme body: ${body}`);
      return m[1].toLowerCase();
    };
    return { fg: pick("fg"), accent: pick("accent"), bg: pick("bg") };
  };
  const out: Record<string, { fg: string; accent: string; bg: string }> = { dark: fields(dark[1]) };
  for (const m of table[1].matchAll(/"?([\w-]+)"?:\s*\{([^}]*)\}/g)) out[m[1]] = fields(m[2]);
  return out;
}

/** the token values in force for a theme: `:root`, with `body.light` layered over it */
function tokensFor(theme: string): Record<string, string> {
  const block = (re: RegExp): string => re.exec(css)?.[1] ?? "";
  const collect = (body: string, into: Record<string, string>): void => {
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) into[m[1]] = m[2].toLowerCase();
  };
  const out: Record<string, string> = {};
  collect(block(/:root\s*\{([\s\S]*?)\}/), out);
  if (theme === "light") collect(block(/body\.light\s*\{([\s\S]*?)\}/), out);
  return out;
}

/**
 * Every token that ends up colouring text a reader has to read, and what it is,
 * so a failure names the thing on screen rather than a variable.
 */
const READABLE = [
  { token: "--ink", what: "the caption itself" },
  { token: "--ink-2", what: "the original line under a translation" },
  { token: "--dim", what: "labels and the timestamp gutter" },
  { token: "--chat", what: "the second speaker's tag on the newest line" },
  { token: "--chat-2", what: "the second speaker's tag in the history" },
];

const AA = 4.5;

describe("what the phone viewer asks people to read", () => {
  const table = themes();

  for (const [name, theme] of Object.entries(table)) {
    // obs-clear paints onto whatever is behind it in OBS; its own `bg` is the
    // colour the shadow and the black theme are built against, so it is judged
    // the same way rather than skipped
    describe(`the ${name} theme`, () => {
      it("puts the caption text far enough from its background", () => {
        expect(
          Number(contrast(theme.fg, theme.bg).toFixed(2)),
          `captions at ${theme.fg} on ${theme.bg} are unreadable to WCAG AA`,
        ).toBeGreaterThanOrEqual(AA);
      });

      it("puts the newest speaker's tag far enough from its background", () => {
        expect(
          Number(contrast(theme.accent, theme.bg).toFixed(2)),
          `the accent ${theme.accent} on ${theme.bg} - it colours the tag saying who is speaking now`,
        ).toBeGreaterThanOrEqual(AA);
      });

      for (const { token, what } of READABLE) {
        it(`puts ${what} far enough from its background`, () => {
          const value = tokensFor(name)[token];
          expect(value, `${token} is not declared`).toBeDefined();
          expect(
            Number(contrast(value, theme.bg).toFixed(2)),
            `${token} is ${value} on ${theme.bg}, and it colours ${what}`,
          ).toBeGreaterThanOrEqual(AA);
        });
      }
    });
  }

  /**
   * The two speaker tags have to be told apart, not merely be readable. Forcing
   * both to the threshold and no further is the obvious way to fix a contrast
   * failure and it would collapse them onto each other - on the light theme the
   * naive answer came out as #4d6f84 and #4c6f85, one unit apart.
   */
  it("keeps the newest speaker's tag clearly stronger than the history's", () => {
    for (const [name, theme] of Object.entries(table)) {
      const t = tokensFor(name);
      const latest = contrast(t["--chat"], theme.bg);
      const history = contrast(t["--chat-2"], theme.bg);
      expect(
        Number((latest - history).toFixed(2)),
        `on the ${name} theme the two speaker tags sit at ${latest.toFixed(2)}:1 and ${history.toFixed(2)}:1, which is not a difference anyone can see`,
      ).toBeGreaterThan(1.5);
    }
  });
});
