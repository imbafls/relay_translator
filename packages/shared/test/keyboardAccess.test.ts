import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Can somebody drive these two pages without a mouse, and can they see where
 * they are while they do it?
 *
 * Both halves are mechanical, which is why they are here rather than in a note.
 * A control the page listens for a click on is reachable if the element under it
 * is one the browser already puts in the tab order, and the focus ring is
 * visible unless a rule took it away and put nothing back. Neither question
 * needs a screen reader or a judgement call.
 *
 * The desktop console is the surface that matters most for this: it is an
 * operator panel used *while a game is running*, so a hand is often on the
 * keyboard and not on the mouse. DESIGN.md gives it a signal-chain strip of
 * selects as its main controls.
 *
 * WHAT THIS DOES NOT CHECK, so the gap is not mistaken for an oversight:
 * whether focus ORDER is sensible, whether anything is announced to a screen
 * reader, and whether hit targets meet DESIGN.md's 44px on phone. The first two
 * need judgement and a real AT; the third needs layout, which happy-dom does not
 * do. They are written down on the card instead of guessed at here.
 */

const root = path.resolve(__dirname, "..", "..", "..");

const SURFACES = [
  {
    name: "desktop renderer",
    dir: path.join(root, "apps", "standalone", "renderer"),
    markup: "index.html",
    script: "app.ts",
    css: "style.css",
  },
  {
    name: "phone/OBS viewer",
    dir: path.join(root, "packages", "viewer", "public"),
    markup: "index.html",
    script: "app.js",
    css: "style.css",
  },
];

/** elements the browser puts in the tab order without being asked */
const FOCUSABLE = new Set(["button", "a", "input", "select", "textarea"]);

const read = (s: (typeof SURFACES)[number], file: string): string =>
  fs.readFileSync(path.join(s.dir, file), "utf8");

/** every element id the page attaches a click handler to */
function clickTargets(script: string): string[] {
  const ids = new Set<string>();
  for (const m of script.matchAll(/\$\("([A-Za-z0-9_]+)"\)\.onclick/g)) ids.add(m[1]);
  for (const m of script.matchAll(/\$\("([A-Za-z0-9_]+)"\)\.addEventListener\("click"/g)) ids.add(m[1]);
  return [...ids].sort();
}

/** the opening tag carrying `id`, or null when the markup has no such element */
function openTagFor(html: string, id: string): string | null {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) return null;
  const open = html.lastIndexOf("<", at);
  const close = html.indexOf(">", at);
  return close < 0 ? null : html.slice(open, close + 1);
}

/** selectors whose rule body sets `outline: none` (or `0`) */
function ringRemovers(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/outline\s*:\s*(none|0)\b/.test(m[2])) continue;
    for (const sel of m[1].split(",")) out.push(sel.trim().replace(/\s+/g, " "));
  }
  return out.filter(Boolean);
}

describe("driving both pages without a mouse", () => {
  for (const surface of SURFACES) {
    describe(surface.name, () => {
      it("listens for clicks only on elements the keyboard can reach", () => {
        const html = read(surface, surface.markup);
        const script = read(surface, surface.script);
        const unreachable: string[] = [];
        for (const id of clickTargets(script)) {
          const tag = openTagFor(html, id);
          // an id with no element is `check-renderer-ids.mjs`'s job, not this one
          if (!tag) continue;
          const name = /^<\s*([a-zA-Z]+)/.exec(tag)?.[1].toLowerCase() ?? "";
          if (FOCUSABLE.has(name) || /tabindex\s*=/.test(tag)) continue;
          unreachable.push(`#${id} is a <${name}>: ${tag.replace(/\s+/g, " ").slice(0, 90)}`);
        }
        expect(
          unreachable,
          "a control that can only be operated by pointing at it",
        ).toEqual([]);
      });

      it("takes no focus ring away without putting something back", () => {
        const css = read(surface, surface.css);
        const naked = ringRemovers(css).filter((sel) => {
          const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return !new RegExp(`${escaped}:focus(-visible|-within)?\\b`).test(css);
        });
        expect(
          naked,
          "`outline: none` with no :focus rule for the same selector - a keyboard user has nothing to follow",
        ).toEqual([]);
      });
    });
  }
});
