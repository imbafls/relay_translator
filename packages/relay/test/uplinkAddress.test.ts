import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claimUrlFor, uplinkUrlFor } from "@callout-relay/shared";
import { startRelay } from "../src/server";
import type { RelayHandle } from "../src/server";
import { UplinkClient } from "../../companion/src/uplinkClient";

/**
 * A relay address with a slash on the end.
 *
 * `wss://relay.example.com/` is what a browser's address bar hands you and
 * what a person pastes. The app's own check accepts it and SETTINGS reads SET,
 * and every other use of the address strips the slash - the phone link, the
 * claim, the link rotation. The uplink did not: it built
 * `wss://relay.example.com//ws/uplink`. The relay reads `//ws/uplink` as a
 * protocol-relative url with host `ws` and drops the socket; the hosted Worker
 * routes it to not-found. Either way the client sees a transport error and
 * retries for ever, while every internet viewer sits on OFF AIR - with nothing
 * on screen saying why, because the address looks fine.
 *
 * Held against a real relay, with the address built the way main.ts builds it.
 */

let relay: RelayHandle | undefined;
let client: UplinkClient | undefined;
const dirs: string[] = [];

afterEach(async () => {
  client?.disconnect();
  client = undefined;
  await relay?.close();
  relay = undefined;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

describe("the address the uplink dials", () => {
  it("does not grow a double slash from an address ending in one", () => {
    expect(uplinkUrlFor("wss://relay.example.com/", "p1_a_b")).toBe("wss://relay.example.com/ws/uplink?token=p1_a_b");
    expect(uplinkUrlFor("wss://relay.example.com", "p1_a_b")).toBe("wss://relay.example.com/ws/uplink?token=p1_a_b");
  });

  // An address works everywhere or visibly nowhere. The claim and the phone
  // link accept one trailing slash; if the uplink took more, `wss://host//`
  // would read UPLINK OK beside a footer quietly handing out the LAN link.
  it("reaches the relay for exactly the addresses the rest of the app accepts", () => {
    for (const address of ["wss://r.example.com", "wss://r.example.com/", "wss://r.example.com//", "ws://10.0.0.5:8787/"]) {
      const reaches = new URL(uplinkUrlFor(address, "t")).pathname === "/ws/uplink";
      expect(reaches, `${address}: the uplink and the claim disagree about whether this is an address`).toBe(
        claimUrlFor(address) !== undefined,
      );
    }
  });

  // the fix lives in the helper, so the app has to build the address through it:
  // an inlined copy of the old concatenation would bring the double slash back
  it("is built by the helper in the app, not by hand", () => {
    const main = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "apps", "standalone", "src", "main.ts"), "utf8");
    expect(main, "main.ts no longer builds the uplink address through uplinkUrlFor").toContain("uplinkUrlFor(cfg.relayUrl");
    expect(main, "main.ts spells out an uplink path by hand again").not.toMatch(/\/ws\/uplink/);
  });

  it("reaches a real relay from an address ending in a slash", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-uplink-addr-"));
    dirs.push(dataDir);
    relay = await startRelay({ port: 0, dataDir, publisherToken: "pub", mockStt: true, mockGemini: true, log: () => undefined });

    client = new UplinkClient(uplinkUrlFor(`ws://127.0.0.1:${relay.port}/`, "pub"));
    client.connect({ languages: { source: "en", target: "vi" }, translates: false });

    expect(
      await until(() => client?.state === "connected", 3000),
      `an address ending in "/" never connected - the uplink retries for ever while viewers sit on OFF AIR (state: ${client?.state})`,
    ).toBe(true);
  });
});
