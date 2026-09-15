import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

/**
 * The rule `room.ts` states in capitals at the top of itself: EVICTION IS
 * NORMAL AND MID-STREAM, so nothing a viewer depends on may live in an
 * instance field.
 *
 * It is the most consequential rule in this app and it was enforced by prose.
 * Three comments reason about it - the header, the one beside the segment-id
 * write, and one in `room.test.ts` - and no test asserted it. A field added as
 * a cache would pass every test here, because a test harness keeps one object
 * alive for the whole run; it would then be reset between messages in
 * production, on every deploy, and on every quiet stretch. That failure is
 * silent, intermittent, and looks like the relay losing its place - which is
 * precisely the shape the `epoch` work had to fix once already.
 *
 * So this asserts the structure rather than a behaviour: a Durable Object may
 * hold the state handle it needs to reach storage, and nothing else.
 */

const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src");

/** the handle a Durable Object is given to reach its own storage */
const STATE_TYPES = new Set(["DurableObjectState", "DurableObjectStorage"]);

interface Held {
  file: string;
  cls: string;
  /** what the class keeps alive between calls, by name */
  fields: string[];
}

/** every class in this app that a Durable Object namespace could instantiate */
function durableObjects(files: string[]): Held[] {
  const out: Held[] = [];

  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const rel = path.relative(root, file).split(path.sep).join("/");

    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        const ctor = node.members.find(ts.isConstructorDeclaration);
        const looksDurable = ctor?.parameters.some((p) =>
          STATE_TYPES.has(p.type?.getText(sf).replace(/\s/g, "") ?? ""),
        );
        if (looksDurable) {
          const fields: string[] = [];
          for (const m of node.members) {
            if (ts.isPropertyDeclaration(m)) fields.push(m.name.getText(sf));
          }
          for (const p of ctor?.parameters ?? []) {
            const mods = ts.canHaveModifiers(p) ? ts.getModifiers(p) ?? [] : [];
            if (!mods.length) continue; // a plain parameter is not kept
            const name = p.name.getText(sf);
            // the state handle is the one thing it is allowed to keep: it is
            // how storage is reached at all, and it is handed back on every
            // wake-up rather than carried across one
            if (STATE_TYPES.has(p.type?.getText(sf).replace(/\s/g, "") ?? "")) continue;
            fields.push(name);
          }
          out.push({ file: rel, cls: node.name.text, fields });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(full);
    }
  };
  walk(srcDir);
  return out;
}

describe("the check itself", () => {
  it("sees a field a hibernating object would lose, and ignores the state handle", () => {
    const dir = fs.mkdtempSync(path.join(root, "..", "..", "node_modules", ".tmp-do-"));
    try {
      const file = path.join(dir, "sample.ts");
      fs.writeFileSync(
        file,
        [
          "export class Keeps {",
          "  private cached = 0;",
          "  constructor(private readonly ctx: DurableObjectState, private readonly env: unknown) {}",
          "}",
          "export class KeepsNothing {",
          "  constructor(private readonly ctx: DurableObjectState, _env: unknown) {}",
          "}",
          "export class NotDurable {",
          "  private whatever = 1;",
          "  constructor(private readonly thing: string) {}",
          "}",
        ].join("\n"),
        "utf8",
      );

      const found = durableObjects([file]);
      // NotDurable is not one of these and must not be reported at all
      expect(found.map((f) => f.cls).sort()).toEqual(["Keeps", "KeepsNothing"]);
      expect(found.find((f) => f.cls === "Keeps")?.fields.sort()).toEqual(["cached", "env"]);
      expect(found.find((f) => f.cls === "KeepsNothing")?.fields).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a Durable Object in this app", () => {
  it("keeps nothing alive between calls but the handle to its own storage", () => {
    const held = durableObjects(sources());
    const offenders = held
      .filter((h) => h.fields.length > 0)
      .map((h) => `${h.file}: ${h.cls} holds ${h.fields.join(", ")}`);

    expect(
      offenders,
      "eviction is normal and mid-stream, so an instance field is state that vanishes " +
        "between messages, on every deploy, and after every quiet stretch:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("found one to check, so the assertion above is about something", () => {
    const held = durableObjects(sources());
    expect(held.map((h) => h.cls)).toContain("Room");
  });
});
