import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openFileLog } from "../src/fileLog";

/**
 * The desktop app's `log()` wrote to stdout and nowhere else. A packaged
 * Electron app has no console, so every reason it ever gave was discarded the
 * moment it was produced.
 *
 * That is why B6 - "in-app archive model downloads corrupt at ~28%" - has been
 * open for days and unreproducible. The store DOES record why a download failed
 * (`models.ts:164`, "model download failed: <id> - <message>"), the renderer
 * puts it in a tooltip, and nothing keeps it. A user reports "it failed" and
 * there is nothing to read afterwards.
 *
 * So the log goes to a file in the data dir. Bounded, because it runs for the
 * life of a session and nobody is going to prune it.
 */
const dirs: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "relay-log-"));
  dirs.push(d);
  return d;
};

afterEach(() => {
  while (dirs.length) {
    try {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      /* windows can hold a handle briefly */
    }
  }
});

describe("keeping the reason something failed", () => {
  it("writes a line that survives the process", () => {
    const dir = tmp();
    const log = openFileLog(dir);
    log("error", "model download failed: local-whisper-turbo - Error in bzip2: crc32 do not match");
    log.close();

    const text = fs.readFileSync(path.join(dir, "relay.log"), "utf8");
    expect(text, "the reason was not written down").toContain("crc32 do not match");
    expect(text, "no level, so an error cannot be told from chatter").toContain("error");
    expect(text, "no timestamp, so two runs cannot be told apart").toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps the newest lines when it grows past the cap", async () => {
    const dir = tmp();
    const log = openFileLog(dir, { maxBytes: 4096 });
    for (let i = 0; i < 400; i += 1) log("info", `line ${i} ${"x".repeat(60)}`);
    log("error", "the one that matters");
    log.close();

    const text = fs.readFileSync(path.join(dir, "relay.log"), "utf8");
    expect(text.length, "the log grows without bound").toBeLessThan(4096 * 3);
    expect(text, "the newest line was rolled away, which is the one worth keeping").toContain("the one that matters");
    expect(text, "the oldest line survived a roll").not.toContain("line 0 ");
  });

  it("never throws at the caller, whatever the disk does", () => {
    // logging is not worth crashing over. A read-only dir, a full disk, a
    // locked file - the app has to carry on and still print to stdout
    const log = openFileLog(path.join(tmp(), "does", "not", "exist", "\u0000bad"));
    expect(() => log("error", "still fine")).not.toThrow();
    expect(() => log.close()).not.toThrow();
  });

  it("appends across sessions rather than starting again", () => {
    const dir = tmp();
    const first = openFileLog(dir);
    first("info", "first session");
    first.close();

    const second = openFileLog(dir);
    second("info", "second session");
    second.close();

    const text = fs.readFileSync(path.join(dir, "relay.log"), "utf8");
    expect(text, "restarting the app threw away what the last run said").toContain("first session");
    expect(text).toContain("second session");
  });
});
