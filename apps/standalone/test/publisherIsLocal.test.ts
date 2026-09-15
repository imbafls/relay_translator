import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The publisher socket never leaves the machine, and something now depends on
 * that being true.
 *
 * `6fcfaaf` gave the UPLINK client a heartbeat timeout: it pings, and a peer
 * that misses two rounds is treated as gone so the reconnect can run. The
 * publisher client has the same gap and was deliberately left with it, on one
 * argument - `publisherWsUrl()` hardcodes `ws://127.0.0.1`, and a TCP
 * connection to loopback does not go half-open. There is no laptop lid, no
 * NAT, no wifi between the two ends; they are the same process.
 *
 * That is a sound reason and an invisible dependency. Point the publisher at a
 * remote relay and the argument evaporates silently: the app would sit
 * "connected" to a machine that stopped answering, streaming audio into a dead
 * socket, with no heartbeat to notice and no reconnect to run. This is that
 * dependency written down where it will be read.
 */

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "src", "main.ts"), "utf8");

describe("the socket the desktop app publishes on", () => {
  /** the body of publisherWsUrl(), which is the only place the URL is built */
  function publisherUrlBody(): string {
    const at = main.indexOf("function publisherWsUrl");
    expect(at, "publisherWsUrl is gone - the publisher URL is built somewhere else now").toBeGreaterThan(-1);
    return main.slice(at, main.indexOf("\n}", at));
  }

  it("goes to loopback and nowhere else", () => {
    const body = publisherUrlBody();
    expect(
      /ws:\/\/127\.0\.0\.1:/.test(body),
      "the publisher URL is no longer loopback. RelayPublisherClient has no heartbeat timeout - it pings " +
        "and never checks for an answer - which was safe only because this socket could not go half-open. " +
        "Give it what uplinkClient got in 6fcfaaf before pointing it anywhere remote.",
    ).toBe(true);

    // a host taken from config would defeat the check above while still reading
    // like loopback in the source
    expect(body, "the host is interpolated, so it is not fixed at loopback after all").not.toMatch(
      /ws:\/\/\$\{/,
    );
  });

  it("is the only place a publisher URL is built, so the check means something", () => {
    const builders = [...main.matchAll(/ws:\/\/[^`"]*\/ws\/publisher/g)].length;
    expect(builders, "a second publisher URL appeared somewhere in main.ts").toBe(1);
  });
});
