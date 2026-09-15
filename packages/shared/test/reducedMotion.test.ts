import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Every surface that moves has to offer a way to stop.
 *
 * `home.html` already did, and said why in its own comment: the page animates
 * a great deal, none of it carries meaning, so all of it goes when asked. The
 * two surfaces somebody actually sits in front of did not. The desktop
 * renderer and the phone/OBS viewer both run `rl-pulse ... infinite` on the ON
 * AIR dot, and the viewer's is a dot on a phone screen or an overlay that is
 * on top of a game for hours.
 *
 * `prefers-reduced-motion` is not a style preference. It is the accommodation
 * for vestibular disorders, and an animation with no end is the case it exists
 * for. Nothing is lost by honouring it here: the state is carried by the amber
 * token and the words ON AIR, and the interim row by its amber timestamp and
 * its position - the motion was never the only signal.
 *
 * The surfaces are found rather than listed, so a stylesheet added tomorrow is
 * covered the day it arrives.
 */

const root = path.resolve(__dirname, "..", "..", "..");

/** every stylesheet and every page that carries its own <style>, as text */
function surfaces(): { name: string; css: string }[] {
  const out: { name: string; css: string }[] = [];
  const dirs = [
    path.join(root, "apps", "standalone", "renderer"),
    path.join(root, "packages", "viewer", "public"),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (e.name.endsWith(".css")) {
        out.push({ name: rel, css: fs.readFileSync(full, "utf8") });
      } else if (e.name.endsWith(".html")) {
        const html = fs.readFileSync(full, "utf8");
        const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
        if (styles.trim()) out.push({ name: rel, css: styles });
      }
    }
  }
  return out;
}

/** does this stylesheet put anything in motion */
const moves = (css: string): boolean => /(^|[\s;{])(animation|transition)\s*:|@keyframes/i.test(css);

/** does it neutralise that motion when the viewer has asked for less */
function honoursTheRequest(css: string): boolean {
  const block = /@media[^{]*prefers-reduced-motion\s*:\s*reduce[^{]*\{([\s\S]*)$/i.exec(css);
  if (!block) return false;
  const body = block[1] ?? "";
  return /animation\s*:\s*none/i.test(body) && /transition\s*:\s*none/i.test(body);
}

describe("the check itself", () => {
  it("tells a stylesheet that moves from one that does not", () => {
    expect(moves(".a { animation: rl-pulse 1.6s infinite; }")).toBe(true);
    expect(moves(".a { transition: opacity 120ms; }")).toBe(true);
    expect(moves("@keyframes rl-pulse { 0% { opacity: 1 } }")).toBe(true);
    // a word that merely contains one of the property names is not a declaration
    expect(moves(".no-transition-here { color: red; }")).toBe(false);
    expect(moves(".a { color: red; }")).toBe(false);
  });

  it("requires the block to actually switch the motion off", () => {
    const halfHearted = "@media (prefers-reduced-motion: reduce) { .a { animation: none } }";
    expect(honoursTheRequest(halfHearted)).toBe(false);
    const real = "@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important } }";
    expect(honoursTheRequest(real)).toBe(true);
  });
});

describe("anything that moves", () => {
  it("lets the viewer ask it to stop", () => {
    const offenders = surfaces()
      .filter((s) => moves(s.css) && !honoursTheRequest(s.css))
      .map((s) => s.name);
    expect(
      offenders,
      `these animate with no prefers-reduced-motion escape:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("found the surfaces, and found that some of them move", () => {
    const all = surfaces();
    expect(all.length, "no stylesheets found at all").toBeGreaterThan(2);
    expect(all.filter((s) => moves(s.css)).length, "nothing in this repo animates, which cannot be right").toBeGreaterThan(1);
  });
});
