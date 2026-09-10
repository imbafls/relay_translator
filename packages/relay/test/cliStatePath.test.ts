import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The relay binary ships for Linux as well as Windows, and on Linux its startup
 * banner told the operator their tokens were in `…/data\relay-state.json`. A
 * backslash is not a separator there, so the path it printed named a file that
 * does not exist. The file on disk was always right - config.ts builds it with
 * path.join - and only the message was wrong. But the message is what someone
 * follows when they go looking for the token.
 */
const cli = fs.readFileSync(path.resolve(__dirname, "..", "src", "cli.ts"), "utf8");
// comments stripped, so this matches the code and not a note explaining it
const code = cli.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("the relay's startup banner", () => {
  it("names the state file with the platform's separator, the way config.ts writes it", () => {
    expect(code).not.toMatch(/\\\\relay-state\.json/);
    expect(code).toMatch(/path\.join\(\s*relayDataDir\(\),\s*"relay-state\.json"\s*\)/);
  });
});
