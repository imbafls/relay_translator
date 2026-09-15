import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Whether the state these two pages report reaches somebody who cannot see it.
 *
 * "Live state exposed by more than colour alone" has two halves, and only one of
 * them was ever true here. The state IS spelled out in words - `STANDBY` becomes
 * `ON AIR`, `CONNECTING` becomes `OFF AIR` - so it was never carried by the
 * coloured dot alone. But the words change in place, silently: nothing marked
 * either region as one a screen reader should watch, so the session going live,
 * or failing to start, happened without a sound.
 *
 * The pattern was already in the repo. `#lines` on the viewer carries
 * `aria-live="polite"` so arriving captions are read out - which is the whole
 * product for the person most likely to be using it. The status regions beside
 * it did not, which is this repo's second lesson again: the shape was fixed in
 * one place and left open in the others.
 *
 * REGIONS ARE LISTED RATHER THAN DISCOVERED, deliberately. "Every element whose
 * text the script rewrites" is not a question a parser can answer honestly, and
 * a test that guesses would either miss things or fail on captions, which are
 * already handled. Each entry below says what it is and why it is on the list,
 * so adding a state readout means adding a line here and noticing the question.
 *
 * WHAT THIS CANNOT CHECK: whether the announcement is any *good* - whether it
 * interrupts at the right moment, or reads well aloud. That needs a real screen
 * reader and a person. What it can check is that the region is marked at all,
 * and an unmarked one is silent for certain.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const RENDERER = path.join(root, "apps", "standalone", "renderer", "index.html");
const VIEWER = path.join(root, "packages", "viewer", "public", "index.html");

/** the opening tag carrying `id="..."`, so its attributes can be read */
function tagById(html: string, id: string): string {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) throw new Error(`no element with id="${id}" in the markup`);
  const open = html.lastIndexOf("<", at);
  const close = html.indexOf(">", at);
  return html.slice(open, close + 1);
}

/** the opening tag of the first element carrying `class="... cls ..."` */
function tagByClass(html: string, cls: string): string {
  const m = new RegExp(`<[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`).exec(html);
  if (!m) throw new Error(`no element with class "${cls}" in the markup`);
  return m[0];
}

const isLive = (tag: string): boolean =>
  /\baria-live="(polite|assertive)"/.test(tag) || /\brole="(status|alert|log)"/.test(tag);

const REGIONS = [
  {
    page: "desktop console",
    file: RENDERER,
    id: "status",
    what: "the topbar, which is the only thing on screen saying whether the session is live",
  },
  {
    page: "desktop console",
    file: RENDERER,
    id: "idleError",
    what: "the reason a session could not start, which is hidden until there is one",
  },
  {
    page: "phone viewer",
    file: VIEWER,
    id: "hudState",
    what: "the header that reads CONNECTING, then ON AIR, then OFF AIR",
  },
  {
    page: "phone viewer",
    file: VIEWER,
    id: "lines",
    what: "the captions themselves - already marked, and the precedent for the rest",
  },
];

/** dots drawn in CSS: the state is in the words beside them, so they say nothing */
const DECORATIVE = [
  { page: "desktop console", file: RENDERER, cls: "status-dot" },
  { page: "phone viewer", file: VIEWER, cls: "hud-dot" },
];

describe("state that changes while somebody is reading it", () => {
  for (const r of REGIONS) {
    it(`announces ${r.what} on the ${r.page}`, () => {
      const tag = tagById(fs.readFileSync(r.file, "utf8"), r.id);
      expect(
        isLive(tag),
        `#${r.id} changes in place with nothing telling a screen reader to watch it: ${tag}`,
      ).toBe(true);
    });
  }

  for (const dot of DECORATIVE) {
    it(`keeps the ${dot.page}'s indicator dot out of the way`, () => {
      const tag = tagByClass(fs.readFileSync(dot.file, "utf8"), dot.cls);
      expect(
        /\baria-hidden="true"/.test(tag),
        `.${dot.cls} is a coloured square with no text; it is decoration and should say so: ${tag}`,
      ).toBe(true);
    });
  }

  /**
   * The other half of "more than colour alone", and the half that was always
   * true: the state is written out in words next to the dot. This is here so it
   * stays true - stripping the label and leaving the dot would make the whole
   * status colour-only, and nothing else would notice.
   */
  it("spells the state out in words, not only in the colour of a dot", () => {
    const renderer = fs.readFileSync(RENDERER, "utf8");
    const viewer = fs.readFileSync(VIEWER, "utf8");
    expect(tagById(renderer, "statusText"), "the desktop console lost its written state").toBeTruthy();
    expect(tagById(viewer, "hudText"), "the phone viewer lost its written state").toBeTruthy();
  });
});
