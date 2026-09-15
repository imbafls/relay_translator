import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * That a model download's failure reaches the file a user can send.
 *
 * This is the first link in B6's evidence chain and the one with history. The
 * comment above `openFileLog` in `main.ts` says it plainly: the app's log went
 * to stdout, "nobody could read it afterwards - which is why B6 stayed open and
 * unreproducible for days". The fix was to write a file next to the config.
 *
 * Everything downstream of that link is now held. `redact.test.ts` keeps the
 * checksum digests, the staging folder and the percentage readable;
 * `feedbackSizes.test.ts` keeps the log inside the clamp so the end of it - the
 * part with the failure in it - is not the part that gets cut. None of that is
 * worth anything if the message never reaches the file.
 *
 * Checked at the source. `main.ts` imports Electron and cannot be loaded by
 * this suite, which is the same reason `prepareOrder.test.ts` reads rather than
 * runs, and it says so rather than pretending the check is behavioural.
 *
 * What would break it is not exotic: handing `ModelStore` `console.log`, or a
 * small local logger, or dropping the `fileLog` call from `log` while leaving
 * the `console` one - each looks tidy in isolation and each returns B6 to the
 * state that kept it open.
 */

const main = fs.readFileSync(path.resolve(__dirname, "..", "src", "main.ts"), "utf8");

describe("a failed model download leaves something to send", () => {
  it("reads main.ts, so the checks below are not vacuous", () => {
    expect(main.length, "main.ts is empty or unreadable").toBeGreaterThan(1000);
    expect(main, "main.ts no longer constructs a ModelStore").toContain("new ModelStore(");
  });

  it("opens a file log in the data dir, beside the config", () => {
    expect(
      main,
      "nothing opens a file log any more, so every message the app writes is gone the moment it exits",
    ).toMatch(/openFileLog\(\s*defaultDataDir\(\)/);
  });

  it("writes every logged line to that file, not only to the console", () => {
    const body = /function log\(([\s\S]*?)\n}/.exec(main)?.[0] ?? "";
    expect(body, "main.ts has no log() to check").not.toBe("");
    // comments stripped first: `// fileLog(level, message)` still contains the
    // call, so a version with the file write commented out passed this until
    // the sabotage that was supposed to prove it red came back green
    const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(
      /fileLog\(/.test(code),
      "log() no longer writes to the file log. Console output dies with the process, which is exactly the " +
        "state B6 sat in for days - a failure nobody could read afterwards",
    ).toBe(true);
  });

  it("gives the model store that logger rather than a console of its own", () => {
    // to the `);` that ends the statement, not the first `)` - the second
    // argument is `() => broadcastStatus()` and a lazy `[^)]*` stops inside it,
    // which is how the first version of this reported a defect that was not one
    const ctor = /new ModelStore\(([\s\S]*?)\);/.exec(main)?.[1] ?? "";
    expect(ctor, "the ModelStore construction could not be read").not.toBe("");
    const args = ctor.split(",").map((a) => a.trim());
    expect(
      args,
      `ModelStore is constructed with (${ctor}). A download failure has to travel through the same log() that ` +
        "writes the file, or the one message B6 is waiting for goes to a console nobody is looking at",
    ).toContain("log");
  });
});
