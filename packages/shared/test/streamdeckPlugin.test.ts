import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The Stream Deck plugin cannot be exercised without Stream Deck, and the one
 * thing that was wrong with it needed no runtime to see: every action it
 * declares has to be registered, or the key does nothing when pressed.
 *
 * `@action` only stamps a UUID onto the class. `registerAction` is the sole
 * place listeners are attached, and `connect()` performs no discovery - so a
 * plugin that decorates an action and never registers it connects happily,
 * shows its key, and ignores every press. It shipped that way.
 *
 * Checks against the source and the built bundle both, because the bundle is
 * what Stream Deck loads and it is generated.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const pluginDir = path.join(root, "apps/streamdeck");
const source = fs.readFileSync(path.join(pluginDir, "src/plugin.ts"), "utf8");
const manifest = JSON.parse(
  fs.readFileSync(path.join(pluginDir, "com.callout-relay.sdPlugin/manifest.json"), "utf8"),
) as { Actions: { UUID: string; Name: string }[] };

/** classes carrying an @action decorator, with the UUID each declares */
function declaredActions(): { cls: string; uuid: string }[] {
  const out: { cls: string; uuid: string }[] = [];
  const re = /@action\(\{[^}]*UUID:\s*"([^"]+)"[^}]*\}\)\s*(?:export\s+)?class\s+(\w+)/g;
  for (const m of source.matchAll(re)) out.push({ uuid: m[1], cls: m[2] });
  return out;
}

describe("the plugin registers what it declares", () => {
  it("declares at least one action, so the check means something", () => {
    expect(declaredActions().length).toBeGreaterThan(0);
  });

  it.each(declaredActions().map((a) => [a.cls, a.uuid] as const))(
    "registers %s",
    (cls) => {
      // the exact omission that made every key press a no-op
      expect(source, `${cls} is decorated but never registered`).toMatch(
        new RegExp(`registerAction\\(\\s*new\\s+${cls}\\b`),
      );
    },
  );

  it("connects after registering, not before", () => {
    const register = source.indexOf("registerAction(");
    const connect = source.indexOf("streamDeck.connect(");
    expect(register).toBeGreaterThan(-1);
    expect(connect).toBeGreaterThan(register);
  });
});

describe("the declared actions match the manifest", () => {
  it("gives every declared action an entry Stream Deck can show", () => {
    const inManifest = new Set(manifest.Actions.map((a) => a.UUID));
    const missing = declaredActions().filter((a) => !inManifest.has(a.uuid));
    expect(missing.map((m) => m.uuid), "declared in code, absent from the manifest").toEqual([]);
  });

  it("backs every manifest entry with a declared action", () => {
    const declared = new Set(declaredActions().map((a) => a.uuid));
    const orphans = manifest.Actions.map((a) => a.UUID).filter((u) => !declared.has(u));
    expect(orphans, "offered by the manifest with nothing behind it").toEqual([]);
  });
});

describe("the bundle Stream Deck actually loads", () => {
  const bundlePath = path.join(pluginDir, "com.callout-relay.sdPlugin/bin/plugin.js");

  it("constructs and registers the action", () => {
    if (!fs.existsSync(bundlePath)) return; // built by `pnpm build:sd`
    const bundle = fs.readFileSync(bundlePath, "utf8");
    for (const { cls } of declaredActions()) {
      // Must name the class. The SDK's own doc comment carries
      // `registerAction(new MyCustomAction())`, so a shape-only match passes
      // against a bundle that registers nothing - which is what it did.
      expect(bundle, `${cls} is not registered in the built bundle`).toMatch(
        new RegExp(`registerAction\\(\\s*new\\s+_?${cls}\\(\\)`),
      );
    }
  });
});
