import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultWorkerPath } from "../src/localStt";

/**
 * Who is supposed to find the local STT worker, and who is not.
 *
 * `defaultWorkerPath()` is exported from this package and called by nothing,
 * which reads like a loose end. It is not one, and the shape of the thing is
 * worth pinning because the obvious "fix" is to wire it into the CLI:
 *
 * - the CLI never passes `localStt`, so a self-hosted relay is cloud STT by
 *   construction - `ServerOptions.localStt` says "Absent = cloud only", and
 *   `createLocalSttStream` refuses a missing worker with "local models need the
 *   desktop app"
 * - the desktop app cannot use this helper, because it has to resolve a path
 *   inside its own packaging, so it carries its own resolver
 *
 * That leaves an embedder using this package as a library. If the CLI ever does
 * grow local STT, the first test below goes red - and the comment on
 * `defaultWorkerPath` is what it should be read against, because at that point
 * the helper stops being decorative and becomes the thing to call.
 */

const root = path.resolve(__dirname, "..");

describe("local STT, and which build is expected to have it", () => {
  it("is not wired into the relay CLI, which is cloud-only by construction", () => {
    const cli = fs.readFileSync(path.join(root, "src", "cli.ts"), "utf8");
    expect(cli.length, "cli.ts is empty, so this checks nothing").toBeGreaterThan(200);

    expect(
      /localStt\s*:/.test(cli),
      "the relay CLI now passes localStt options. That is a real feature and this test is not against it - but " +
        "a self-hosted relay was cloud-only by construction, several comments say so, and defaultWorkerPath() " +
        "was documented as decorative on exactly that basis. Read them before deleting this.",
    ).toBe(false);
  });

  it("gives the worker a path beside the compiled module, which is the only promise it makes", () => {
    const at = defaultWorkerPath();
    expect(path.basename(at), "the worker filename moved and this helper did not follow").toBe("localSttWorker.js");
    expect(path.isAbsolute(at), "a relative worker path would resolve against the caller's cwd, not this package").toBe(
      true,
    );
  });

  it("is resolved separately by the desktop app, because packaging moves it", () => {
    const main = fs.readFileSync(path.resolve(root, "..", "..", "apps", "standalone", "src", "main.ts"), "utf8");
    expect(
      main,
      "the desktop app no longer resolves the worker itself. If it now uses defaultWorkerPath(), that only works " +
        "while the app is unpacked - the packed case is the whole reason it had its own resolver.",
    ).toMatch(/localSttWorker\.js/);
  });
});
