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
