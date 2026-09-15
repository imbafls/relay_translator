import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Every message the relay declares it may send a publisher, held to having
 * somewhere it is actually sent from.
 *
 * `ServerToPublisher` is a promise made to whoever writes a publisher - the
 * desktop app here, and anyone running `packages/relay`'s binary as their own
 * relay. A member nobody builds is a promise the relay does not keep: the
 * reader handles it, waits for it, and it never comes. Nothing else can catch
 * that. TypeScript is happy with a union member no one constructs, and the
 * client narrows with an `if` chain, so a branch for a message that is never
 * sent looks exactly like a branch for a message that is rare.
 *
 * This is the shape CLAUDE.md's sixth lesson names - a declared surface with no
 * consumer is unfinished until you can say what it was for - pointed at the
 * producing end, which is the end that can be checked from the source.
 *
 * Two routes reach a publisher and there are only two:
 *
 *   - `sendPublisher(ws, msg)` in `server.ts`, the socket write itself
 *   - `deps.toPublisher(msg)` from `session.ts`, whose parameter is declared as
 *     `Extract<ServerToPublisher, { type: "subtitle" | "partial" }>` - so what
 *     it can carry is read off that declaration rather than guessed at
 *
 * The viewer and uplink directions were swept by hand the same way when this
 * was written and every member of both has a producer, so nothing is asserted
 * about them here; a guard that is green from birth proves only that it ran.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");

/**
 * The `type:` literals of a union in shared's `index.ts`.
 *
 * Sliced to the first blank line rather than to the first `;`, because every
 * member of these unions is an object type and each of its fields ends in one.
 */
function unionMembers(src: string, name: string): string[] {
  const at = src.indexOf(`export type ${name} =`);
  if (at < 0) return [];
  const end = src.indexOf("\n\n", at);
  const body = src.slice(at, end < 0 ? src.length : end);
  return [...new Set([...body.matchAll(/type:\s*"([a-z]+)"/g)].map((m) => m[1]))];
}

/** the text of each `call(` argument list, from the `(` to its matching `)` */
function callArgs(src: string, call: string): string[] {
  const out: string[] = [];
  let from = -1;
  for (;;) {
    const hit = src.indexOf(call, from + 1);
    if (hit < 0) return out;
    from = hit;
    let depth = 0;
    for (let i = hit + call.length - 1; i < src.length; i += 1) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          out.push(src.slice(hit, i + 1));
          break;
        }
      }
    }
  }
}

describe("every message the relay says it may send a publisher", () => {
  const shared = read("packages/shared/src/index.ts");
  const members = unionMembers(shared, "ServerToPublisher");

  it("has a union this test can actually read", () => {
    // the parse is the whole test; a union it failed to find would report
    // every message as produced and pass in silence
    expect(members.length, "ServerToPublisher was not parsed out of shared/src/index.ts").toBeGreaterThan(3);
    expect(members, "the parse lost the two messages every publisher gets").toEqual(
      expect.arrayContaining(["ready", "subtitle"]),
    );
  });

  it("is built somewhere", () => {
    const server = read("packages/relay/src/server.ts");
    const session = read("packages/relay/src/session.ts");

    const sent = new Set<string>();
    for (const args of callArgs(server, "sendPublisher(")) {
      for (const m of args.matchAll(/type:\s*"([a-z]+)"/g)) sent.add(m[1]);
    }
    // guards the guard: `ready` is the first thing any publisher is sent, so a
    // scan that stopped matching would lose it before it lost anything subtle
    expect([...sent], "the sendPublisher scan found nothing - it is not reading the call sites").toContain("ready");

    // what the session hands the publisher is declared, not scanned: the
    // parameter names the members it may carry
    const carried = /toPublisher\?\(msg: Extract<ServerToPublisher, \{ type: ([^}]*)\}>\)/.exec(session)?.[1] ?? "";
    for (const m of carried.matchAll(/"([a-z]+)"/g)) sent.add(m[1]);
    expect([...sent], "the toPublisher declaration was not read").toContain("subtitle");

    const orphans = members.filter((m) => !sent.has(m));
    expect(
      orphans,
      `ServerToPublisher declares ${orphans.join(", ")} and the relay never sends ${
        orphans.length === 1 ? "it" : "them"
      }. Either build it where it belongs, or take it out of the union - a publisher client that ` +
        "handles it is waiting for something that does not come",
    ).toEqual([]);
  });
});
