import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The Worker's bindings, between `wrangler.toml` and the code that reads them.
 *
 * `env.ROOM`, `env.ASSETS`, `env.FEEDBACK`, `env.CLAIM_LIMIT` and
 * `env.FEEDBACK_LIMIT` are names, matched at deploy time against a TOML file.
 * Nothing in this repo can catch a mismatch: `Env` is hand-declared in
 * `cf.d.ts` precisely so this app can carry no dependency on
 * `@cloudflare/workers-types`, so the compiler agrees with whatever the code
 * asks for. Rename a binding in the TOML and `env.FEEDBACK` is `undefined` at
 * runtime, in a service that cannot be exercised from here at all.
 *
 * The file says as much about itself already - `run_worker_first` carries the
 * note "Caught by deploying; no unit test could see it." That is true of the
 * platform's BEHAVIOUR. It is not true of the names, and the names are the half
 * that can be held here.
 *
 * Both directions matter and they fail differently:
 *
 *  - code reads a binding the TOML does not declare: `undefined` at the first
 *    request that touches it, live
 *  - the TOML declares one nothing reads: a configured resource - an R2
 *    bucket, a rate-limit namespace - that exists, may bill, and does nothing
 *
 * The trap, for whoever edits this next: `name =` appears twice over in this
 * file. At the top it is the WORKER's name, `callout-relay-hosted`; inside a
 * `[[durable_objects.bindings]]` or `[[ratelimits]]` table it is a binding.
 * Telling them apart by shape - a binding is UPPER_SNAKE, a worker name is not
 * - is what keeps `callout-relay-hosted` out of the binding list.
 */

const root = path.resolve(__dirname, "..");
const toml = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8").replace(/^\s*#.*$/gm, "");

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sources(full, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}
const code = sources(path.join(root, "src"))
  .map((f) => fs.readFileSync(f, "utf8"))
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** every binding the TOML declares, by either spelling */
const declared = new Set<string>();
for (const m of toml.matchAll(/^\s*binding\s*=\s*"([^"]+)"/gm)) declared.add(m[1] ?? "");
// a binding is UPPER_SNAKE; the worker's own `name` at the top is not
for (const m of toml.matchAll(/^\s*name\s*=\s*"([A-Z][A-Z0-9_]*)"/gm)) declared.add(m[1] ?? "");

/** every binding the code reaches for */
const used = new Set<string>();
for (const m of code.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) used.add(m[1] ?? "");

describe("the Worker's bindings", () => {
  it("found both sides, so the checks below are not vacuous", () => {
    expect(declared.size, "no binding was parsed out of wrangler.toml at all").toBeGreaterThan(3);
    expect(used.size, "no env.BINDING use was found in the source at all").toBeGreaterThan(3);
    expect(
      declared.has("callout-relay-hosted"),
      "the worker's own name was parsed as a binding, so this list is wrong",
    ).toBe(false);
  });

  it("reaches for nothing wrangler does not declare", () => {
    const missing = [...used].filter((b) => !declared.has(b));
    expect(
      missing,
      "the Worker reads these off env and wrangler.toml declares no such binding, so each is undefined at the " +
        "first live request that touches it - and the hand-written Env in cf.d.ts means tsc will not say so",
    ).toEqual([]);
  });

  it("declares nothing the Worker never reads", () => {
    const unused = [...declared].filter((b) => !used.has(b));
    expect(
      unused,
      "wrangler.toml configures these and no code reads them - a bucket or a rate-limit namespace that exists, " +
        "may bill, and does nothing. Either a use was removed and this is the other half, or it was never wired up",
    ).toEqual([]);
  });

  it("binds a Durable Object class this app actually exports", () => {
    const bound = [...toml.matchAll(/class_name\s*=\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(bound.length, "no durable object class_name found in wrangler.toml").toBeGreaterThan(0);
    for (const cls of bound) {
      expect(
        new RegExp(`export class ${cls}\\b`).test(code),
        `wrangler.toml binds a Durable Object class "${cls}" and nothing in src exports it, so the deploy has ` +
          "nothing to instantiate",
      ).toBe(true);
    }
  });

  it("carries every bound class in a migration, as a SQLite class", () => {
    const bound = [...toml.matchAll(/class_name\s*=\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
    const migrated = [...toml.matchAll(/new_sqlite_classes\s*=\s*\[([^\]]*)\]/g)]
      .flatMap((m) => [...(m[1] ?? "").matchAll(/"([^"]+)"/g)].map((q) => q[1] ?? ""));
    for (const cls of bound) {
      expect(
        migrated,
        `"${cls}" is bound but appears in no new_sqlite_classes migration. The TOML says why that word matters: ` +
          "SQLite-backed objects are what the current free tier covers",
      ).toContain(cls);
    }
  });
});
