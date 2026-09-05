import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

/**
 * What git stores, not what is in the working tree. A Windows checkout having
 * CRLF on disk is fine and expected; a CRLF committed into the index is not,
 * because that is the copy Linux gets - the VPS relay, the Linux server build,
 * and anything deploy/ hands to the box.
 *
 * turn 17 made tryLoadDotenv survive a stray CR. This is the other half: stop
 * one being committed in the first place.
 */

const root = path.resolve(__dirname, "..", "..", "..");

function lsFilesEol(): string[] | null {
  try {
    return execFileSync("git", ["ls-files", "--eol"], { cwd: root, encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    // not a git checkout (a tarball, a vendored copy) - nothing to assert
    return null;
  }
}

/** rows of `git ls-files --eol` that are stored with something other than LF */
function offenders(rows: string[]): string[] {
  return rows
    .filter((r) => !/^i\/(lf|-text|none)\b/.test(r))
    .map((r) => r.split(/\s+/).slice(3).join(" "));
}

describe("the check itself", () => {
  it("flags a blob stored with CRLF and lets the rest through", () => {
    // once the attribute is in place nothing can be committed with CRLF, so
    // the detection is proved against the rows git would print rather than by
    // trying to smuggle one in
    const rows = [
      "i/lf    w/crlf  attr/text=auto eol=lf   apps/standalone/src/main.ts",
      "i/crlf  w/crlf  attr/                   deploy/traefik/relay.yml",
      "i/-text w/-text attr/binary             apps/standalone/assets/icon.png",
      "i/mixed w/mixed attr/                   scripts/vps.mjs",
    ];
    expect(offenders(rows)).toEqual(["deploy/traefik/relay.yml", "scripts/vps.mjs"]);
  });
});

describe("what gets committed", () => {
  it("stores every tracked text file with LF", () => {
    const rows = lsFilesEol();
    if (!rows) return;

    const bad = offenders(rows);
    expect(bad, `these are stored with non-LF endings: ${bad.join(", ")}`).toEqual([]);
  });

  it("found something to check, so the assertion above means something", () => {
    const rows = lsFilesEol();
    if (!rows) return;
    expect(rows.length).toBeGreaterThan(50);
  });
});
