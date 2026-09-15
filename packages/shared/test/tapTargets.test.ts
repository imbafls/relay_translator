// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `DESIGN.md` states one rule about size and it is about this page:
 *
 *   - Interactive hit targets >= 44px on phone.
 *
 * The phone viewer is the page that rule is for, and nothing checked it. It
 * could not be checked the usual way: the suite runs under happy-dom, which
 * applies no stylesheets and lays nothing out, so no test in this repo can ask
 * how big anything actually is. Everything visual is invisible here, which is
 * exactly why a control can sit at 20px for as long as this one did.
 *
 * So this reads the declaration rather than the box. It asks a narrower
 * question that needs no layout: **when a rule gives an interactive element an
 * explicit size in pixels, is that size at least 44?** An element with no
 * declared size is sized by its content and padding and is not judged here -
 * stated plainly, because a guard that quietly skips things reads like
 * coverage. What it does catch is the shape that went wrong: a control handed
 * a small fixed box.
 *
 * Two shapes are deliberately not violations:
 *
 *   - A control inside a `<label>`. Tapping anywhere in the label works the
 *     control, so the label is the target - which is why the settings rows are
 *     54px tall and their checkboxes can be 20. The range slider is the
 *     exception among inputs: it has to be dragged where it sits, so a label
 *     around it would not help and it is judged on its own box.
 *   - Pseudo-elements. `::-webkit-slider-thumb` is the knob drawn inside the
 *     control, not the thing a thumb lands on.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const dir = path.join(root, "packages", "viewer", "public");
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const css = fs.readFileSync(path.join(dir, "style.css"), "utf8");

/** DESIGN.md, "Interactive hit targets >= 44px on phone" */
const MIN = 44;

/** every rule as (one selector, its declarations), minus pseudo-elements */
const rules: { sel: string; body: string }[] = [];
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  for (const sel of m[1].split(",")) {
    const s = sel.trim().replace(/\s+/g, " ");
    if (!s || s.startsWith("@") || s.includes("::")) continue;
    rules.push({ sel: s, body: m[2] });
  }
}

const px = (body: string, prop: string): number | undefined => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([0-9.]+)px`).exec(body);
  return m ? Number(m[1]) : undefined;
};

/**
 * The size a stylesheet declares for `el`, read off the rules that name it
 * directly - its tag, its id, one of its classes, or `input[type=...]`.
 * Descendant and compound selectors are not resolved; a control sized only by
 * one of those is reported as unsized rather than guessed at.
 */
function declared(el: Element): { w?: number; h?: number } {
  const classes = [...el.classList];
  const type = el.getAttribute("type");
  const out: Record<string, number> = {};
  for (const r of rules) {
    const names =
      r.sel === el.tagName.toLowerCase() ||
      (el.id && r.sel === `#${el.id}`) ||
      classes.some((c) => r.sel === `.${c}`) ||
      (type && r.sel === `input[type="${type}"]`);
    if (!names) continue;
    for (const p of ["width", "height", "min-width", "min-height"]) {
      const v = px(r.body, p);
      if (v !== undefined) out[p] = v;
    }
  }
  return { w: out["min-width"] ?? out.width, h: out["min-height"] ?? out.height };
}

/** what a thumb actually lands on: the wrapping label, or the control itself */
function target(el: Element): Element {
  if (el.tagName === "LABEL") return el;
  if (el.getAttribute("type") === "range") return el;
  return el.closest("label") ?? el;
}

describe("the phone viewer's controls are big enough to hit", () => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const controls = [...doc.querySelectorAll("button, input, select, label")];

  // keyed by the target, not by the control: a swatch is both a label in the
  // list and the target of the colour input inside it, and reporting it twice
  // reads as two problems
  const byTarget = new Map<Element, { el: Element; from: Element; size: { w?: number; h?: number } }>();
  for (const from of controls) {
    const el = target(from);
    if (!byTarget.has(el)) byTarget.set(el, { el, from, size: declared(el) });
  }
  const judged = [...byTarget.values()].filter(({ size }) => size.w !== undefined || size.h !== undefined);

  const name = (el: Element): string =>
    `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${[...el.classList].map((c) => `.${c}`).join("")}`;

  it("found the page and the rules that size it", () => {
    // every number below comes from these two lists; if either stops matching,
    // the check reports nothing at all and reads like a pass
    expect(rules.length, "style.css did not parse into rules").toBeGreaterThan(50);
    expect(controls.length, "no controls found in the viewer markup").toBeGreaterThan(10);
    expect(judged.length, "no control has a declared size - the lookup is not matching").toBeGreaterThan(5);
  });

  it("agrees with the one control that already says 44", () => {
    // AA opens the display panel and is the only control written to the rule
    // today, negative margins and all. If this stops reading 44 the lookup is
    // broken, whatever the rest of the test says.
    const aa = doc.querySelector("#openDisplay");
    expect(aa, "#openDisplay is gone").not.toBeNull();
    expect(declared(aa as Element)).toEqual({ w: MIN, h: MIN });
  });

  it("gives every control a box of at least 44px where it gives it one at all", () => {
    const small = judged
      .filter(({ size }) => (size.w !== undefined && size.w < MIN) || (size.h !== undefined && size.h < MIN))
      .map(({ el, from, size }) =>
        `${name(el)}${el === from ? "" : ` (for ${name(from)})`} is ${size.w ?? "auto"}x${size.h ?? "auto"}`,
      );
    expect(
      small,
      `DESIGN.md asks for hit targets of at least ${MIN}px on phone, and these are the ones this page ` +
        "hands a smaller box to outright",
    ).toEqual([]);
  });
});
