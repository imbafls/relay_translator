import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadState, saveState } from "../src/config";

/**
 * relay-state.json is what keeps a viewer link working across a restart. It
 * lives on a VPS next to a service that gets restarted and redeployed, so it
 * gets read back in states nothing wrote deliberately: truncated by a crash
 * mid-write, hand-edited, or copied in from another machine.
 */

let dir: string;
const ENV_KEYS = ["RELAY_PUBLISHER_TOKEN", "RELAY_VIEWER_TOKEN"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-state-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

const stateFile = (): string => path.join(dir, "relay-state.json");
const write = (contents: string): void => fs.writeFileSync(stateFile(), contents, "utf8");

const isToken = (v: unknown): boolean => typeof v === "string" && v.length >= 8;

describe("token persistence", () => {
  it("keeps the same tokens across a restart", () => {
    const first = loadState(dir, {});
    const second = loadState(dir, {});
    expect(second.publisherToken).toBe(first.publisherToken);
    expect(second.viewerToken).toBe(first.viewerToken);
  });

  it("lets explicit options win over what is on disk", () => {
    loadState(dir, {});
    const forced = loadState(dir, { publisherToken: "explicit-publisher-token" });
    expect(forced.publisherToken).toBe("explicit-publisher-token");
    // and it is persisted, so the next boot agrees
    expect(loadState(dir, {}).publisherToken).toBe("explicit-publisher-token");
  });

  it("generates two different tokens", () => {
    const s = loadState(dir, {});
    expect(s.publisherToken).not.toBe(s.viewerToken);
  });
});

describe("a state file that was not written cleanly", () => {
  it.each([
    ["truncated by a crash mid-write", '{"publisherToken": "abc'],
    ["empty", ""],
    ["not an object", '"just a string"'],
    ["null", "null"],
    ["an array", "[]"],
  ])("recovers from one %s", (_name, contents) => {
    write(contents);
    const state = loadState(dir, {});
    expect(isToken(state.publisherToken), `publisher token was ${JSON.stringify(state.publisherToken)}`).toBe(true);
    expect(isToken(state.viewerToken), `viewer token was ${JSON.stringify(state.viewerToken)}`).toBe(true);
  });

  it.each([
    ["numbers", '{"publisherToken": 123, "viewerToken": 456}'],
    ["booleans", '{"publisherToken": true, "viewerToken": true}'],
    ["objects", '{"publisherToken": {"a": 1}, "viewerToken": {"b": 2}}'],
    ["arrays", '{"publisherToken": ["a"], "viewerToken": ["b"]}'],
    ["empty strings", '{"publisherToken": "", "viewerToken": ""}'],
  ])("does not adopt tokens that are %s", (_name, contents) => {
    write(contents);
    const state = loadState(dir, {});
    // a non-string token can never match the string off a query param, so the
    // relay would come up refusing every connection it is supposed to accept
    expect(isToken(state.publisherToken), `publisher token was ${JSON.stringify(state.publisherToken)}`).toBe(true);
    expect(isToken(state.viewerToken), `viewer token was ${JSON.stringify(state.viewerToken)}`).toBe(true);
  });

  it("always leaves a file that parses back to what it wrote", () => {
    const state = { publisherToken: "p".repeat(32), viewerToken: "v".repeat(32) };
    saveState(dir, state);
    expect(JSON.parse(fs.readFileSync(stateFile(), "utf8"))).toEqual(state);
  });

  it("leaves no stray temp files behind", () => {
    saveState(dir, { publisherToken: "p".repeat(32), viewerToken: "v".repeat(32) });
    expect(fs.readdirSync(dir)).toEqual(["relay-state.json"]);
  });
});

/**
 * The viewer token is not only compared against a query param - it is written
 * into the middle of a URL PATH, and read back out of one. Both ends of that
 * round trip already fix its alphabet, and neither can say so where the relay
 * would see it:
 *
 *   - `packages/viewer/public/app.js` takes the token off the path with
 *     `/\/watch\/([A-Za-z0-9_-]+)/`. That file is served as-is with no build
 *     step, so it can import nothing and the class is a literal.
 *   - `apps/hosted-relay/src/routes.ts` routes `/watch/<x>` on whether `x`
 *     contains a dot: a dot means a filename, so the request is an asset and
 *     not a viewer page. Its comment states the rule as a fact about tokens.
 *
 * So a token with a dot in it - `team.alpha`, a version, an IP - is not a
 * viewer link that half works. The relay starts, serves the page, and every
 * viewer that opens the link is refused, because the page asks with the part
 * before the dot. That is the same failure `persistedToken` above already
 * exists to prevent, one layer down: a token the relay accepts and no viewer
 * can ever present.
 *
 * `RELAY_VIEWER_TOKEN` is the route that matters. It is documented in
 * `packages/relay/sea/vps.env.example` for anyone self-hosting, it reaches
 * `loadState` without passing `persistedToken` at all, and whatever it carries
 * is written straight back to `relay-state.json`.
 *
 * The publisher token is deliberately not held to this. It travels as a query
 * parameter, encoded on the way out and decoded on the way in, so it survives
 * characters the path cannot carry.
 */
describe("a viewer token has to survive being put in a link", () => {
  const PATH_SAFE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
  // each of these breaks the round trip somewhere: a dot reads as a filename
  // to the hosted router, and everything else falls outside the class the
  // viewer page matches with, so the page asks with a different string
  const UNUSABLE = ["team.alpha", "10.0.0.7", "a b", "a/b", "a?b", "a#b", "a%20b", "café", "a+b"];

  it("keeps one that is", () => {
    const state = loadState(dir, { viewerToken: PATH_SAFE });
    expect(state.viewerToken).toBe(PATH_SAFE);
  });

  it.each(UNUSABLE)("does not adopt %j, from the config the app passes in", (token) => {
    const state = loadState(dir, { viewerToken: token });
    expect(state.viewerToken, "a token no viewer can present was adopted and persisted").not.toBe(token);
    expect(isToken(state.viewerToken)).toBe(true);
  });

  it.each(UNUSABLE)("does not adopt %j from RELAY_VIEWER_TOKEN", (token) => {
    process.env.RELAY_VIEWER_TOKEN = token;
    const state = loadState(dir, {});
    expect(state.viewerToken, "the documented operator override is not checked at all").not.toBe(token);
  });

  it.each(UNUSABLE)("does not adopt %j out of the state file", (token) => {
    write(JSON.stringify({ publisherToken: "p".repeat(32), viewerToken: token }));
    const state = loadState(dir, {});
    expect(state.viewerToken).not.toBe(token);
  });

  it("mints one that satisfies its own rule", () => {
    for (let i = 0; i < 20; i++) {
      const state = loadState(fs.mkdtempSync(path.join(os.tmpdir(), "relay-mint-")), {});
      expect(/^[A-Za-z0-9_-]+$/.test(state.viewerToken), state.viewerToken).toBe(true);
    }
  });

  it("says so, rather than quietly handing back a different link", () => {
    // the whole argument for skipping a bad token instead of refusing to start
    // is that whoever set it finds out. Without the line, the relay comes up
    // clean on a link nobody asked for.
    const lines: string[] = [];
    process.env.RELAY_VIEWER_TOKEN = "team.alpha";
    loadState(dir, {}, (level, message) => lines.push(`${level}: ${message}`));
    expect(
      lines.filter((l) => l.startsWith("warn") && l.includes("RELAY_VIEWER_TOKEN")),
      `nothing was logged about the refused token: ${JSON.stringify(lines)}`,
    ).toHaveLength(1);
  });

  it("enforces the class the viewer page actually reads with", () => {
    const app = fs.readFileSync(
      path.join(__dirname, "..", "..", "viewer", "public", "app.js"),
      "utf8",
    );
    expect(
      app,
      "the viewer page no longer reads the token with [A-Za-z0-9_-]. That class and the one the relay " +
        "enforces are the same contract written twice, because app.js is served as-is and can import nothing",
    ).toContain("[A-Za-z0-9_-]");
  });
});
