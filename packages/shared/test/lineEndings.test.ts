import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
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

/**
 * The path in a row of `git ls-files --eol`, which git puts after a TAB.
 *
 * This split on whitespace and took the fourth column on, but the attribute
 * column is `attr/text=auto eol=lf` - two words - so every real row came out
 * as `eol=lf <path>`. Here that only garbled a failure message. The first draft
 * of the control-byte check below used the same split to open files, opened
 * none of them, and reported a clean tree.
 */
function pathOf(row: string): string {
  return row.slice(row.indexOf("\t") + 1);
}

/** rows of `git ls-files --eol` that are stored with something other than LF */
function offenders(rows: string[]): string[] {
  return rows.filter((r) => !/^i\/(lf|-text|none)\b/.test(r)).map(pathOf);
}

describe("the check itself", () => {
  it("flags a blob stored with CRLF and lets the rest through", () => {
    // once the attribute is in place nothing can be committed with CRLF, so
    // the detection is proved against the rows git would print rather than by
    // trying to smuggle one in - in git's own layout, a two-word attribute
    // column and a TAB before the path
    const rows = [
      "i/lf    w/crlf  attr/text=auto eol=lf \tapps/standalone/src/main.ts",
      "i/crlf  w/crlf  attr/text=auto eol=lf \tdeploy/traefik/relay.yml",
      "i/-text w/-text attr/binary           \tapps/standalone/assets/icon.png",
      "i/mixed w/mixed attr/                 \tscripts/vps.mjs",
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

/**
 * A control byte in a source file is a backslash some tool ate.
 *
 * A shell or a heredoc hands `\b` on as a backspace, `\t` as a tab and `\x1b`
 * as an escape - silently, and into a file that still parses. It happened to a
 * regex in `renderer.test.ts`: `\bhidden\b` became two 0x08 bytes around the
 * word, so the lookahead could never match and the test passed whatever the
 * markup said, for as long as it existed. CLAUDE.md records the same thing
 * happening to a heredoc. Nothing in a test run can see it, because the file
 * is valid; this looks at the bytes.
 *
 * Tab, LF and CR are text. Everything else below 0x20, and DEL, is not.
 */
function controlBytes(buf: Buffer): number[] {
  const at: number[] = [];
  buf.forEach((b, i) => {
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) at.push(i);
  });
  return at;
}

describe("stray control bytes", () => {
  it("flags a backspace, and lets tab, LF and CR through", () => {
    expect(controlBytes(Buffer.from("a\tb\r\nc\n"))).toEqual([]);
    expect(controlBytes(Buffer.from("/(?![^>]*\bhidden\b)/"))).toEqual([9, 16]);
    expect(controlBytes(Buffer.from("\x1b[2K\x7f"))).toEqual([0, 4]);
  });

  it("are in no tracked text file", () => {
    const rows = lsFilesEol();
    if (!rows) return;

    let read = 0;
    const bad: string[] = [];
    for (const row of rows) {
      // git's own verdict on what is text; a binary blob is allowed any byte
      if (/^i\/(-text|none)\b/.test(row)) continue;
      const file = path.join(root, pathOf(row));
      // tracked but deleted in this checkout: nothing on disk to read
      if (!fs.existsSync(file)) continue;
      read += 1;
      const at = controlBytes(fs.readFileSync(file));
      if (at.length) bad.push(`${pathOf(row)} (${at.length} at byte ${at[0]})`);
    }

    // a check that opened nothing reports a clean tree - which is exactly what
    // this one's first draft did
    expect(read, "no tracked text file was opened, so a clean result means nothing").toBeGreaterThan(50);
    expect(bad, `control bytes - a backslash some tool ate - in: ${bad.join(", ")}`).toEqual([]);
  });
});
