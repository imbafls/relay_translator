import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Every close code a relay can send has to be one a client recognises.
 *
 * This is a protocol contract spread across four packages with no shared
 * constant, and it cannot have one: `packages/viewer/public/app.js` is served
 * to a phone exactly as it sits on disk, with no build step, so it can import
 * nothing. `room.ts` says its constants are "close codes the desktop client
 * already understands" - a claim about a different package, which nothing
 * checked.
 *
 * The cost of getting it wrong is already in the audit. Finding 24 was the
 * uplink fighting a 4409 kick for ever because it did not know the code, with
 * the 4401 branch dead beside it. A code nobody handles falls into whatever
 * the client does for an unexplained drop, which is usually "reconnect" - and
 * reconnecting is exactly wrong when the close means the credential is gone.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");

const SENDERS = [
  "packages/relay/src/server.ts",
  "apps/hosted-relay/src/room.ts",
  "apps/hosted-relay/src/index.ts",
];
const RECEIVERS = [
  "packages/companion/src/relayClient.ts",
  "packages/companion/src/uplinkClient.ts",
  "packages/viewer/public/app.js",
];

/** codes handed to close(), directly or through a named constant */
function sentBy(rel: string): Set<number> {
  const src = read(rel);
  const named = new Map<string, number>();
  for (const m of src.matchAll(/const\s+([A-Z_]+)\s*=\s*(4\d{3})\s*;/g)) named.set(m[1] ?? "", Number(m[2]));

  const out = new Set<number>();
  const take = (tok: string): void => {
    const n = /^\d+$/.test(tok) ? Number(tok) : named.get(tok);
    if (n) out.add(n);
  };
  for (const m of src.matchAll(/close(?:All)?\(\s*(?:[A-Za-z_.]+,\s*)?([A-Z_]+|4\d{3})/g)) take(m[1] ?? "");
  for (const m of src.matchAll(/closedSocket\(\s*([A-Z_]+|4\d{3})/g)) take(m[1] ?? "");
  return out;
}

/** codes a client actually branches on */
function handledBy(rel: string): Set<number> {
  const out = new Set<number>();
  for (const m of read(rel).matchAll(/code\s*===\s*(4\d{3})/g)) out.add(Number(m[1]));
  return out;
}

const union = (files: string[], f: (rel: string) => Set<number>): Set<number> => {
  const all = new Set<number>();
  for (const rel of files) for (const c of f(rel)) all.add(c);
  return all;
};

describe("the close codes the relays and their clients share", () => {
  it("are all recognised by somebody", () => {
    const sent = union(SENDERS, sentBy);
    const handled = union(RECEIVERS, handledBy);
    const orphans = [...sent].filter((c) => !handled.has(c)).sort();
    expect(
      orphans,
      `a relay sends these and no client branches on them, so each one arrives as an ` +
        `unexplained drop and gets whatever that client does about one - usually a retry: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("are none of them handled by a client no relay ever sends", () => {
    // the other half of finding 24: the 4401 branch was dead code for a while
    const sent = union(SENDERS, sentBy);
    const handled = union(RECEIVERS, handledBy);
    const dead = [...handled].filter((c) => !sent.has(c)).sort();
    expect(dead, `no relay sends these and a client still branches on them: ${dead.join(", ")}`).toEqual([]);
  });

  it("were found on both sides, so neither assertion above is vacuous", () => {
    expect(union(SENDERS, sentBy).size, "no close codes were read out of any relay").toBeGreaterThan(1);
    expect(union(RECEIVERS, handledBy).size, "no close codes were read out of any client").toBeGreaterThan(1);
  });
});
