import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Three numbers, in three packages, that have to stay in order.
 *
 * A failure report travels: the file logger bounds `relay.log`, the renderer
 * reads it whole and clamps it, and the Worker accepts or refuses the result.
 *
 *   fileLog `DEFAULT_MAX_BYTES`   packages/companion/src/fileLog.ts
 *   `FEEDBACK_LOG_MAX_BYTES`      apps/standalone/renderer/app.ts
 *   `FEEDBACK_LOG_MAX`            apps/hosted-relay/src/index.ts
 *
 * Nothing connects them. The Worker takes no dependencies by design, and the
 * renderer cannot import from it, so all three are literals typed out
 * separately - the same contract-with-no-shared-constant this repo has already
 * found broken for close codes and viewer messages.
 *
 * **Why the order matters, and it is not symmetry.**
 *
 * `clampUtf8Bytes` keeps the FIRST `maxBytes` - `bytes.slice(0, maxBytes)`.
 * That is safe only while the log cannot be bigger than the clamp, which holds
 * because the file logger rolls at 1 MB and keeps the newest half. Raise that
 * bound past the clamp and the user sends the OLDEST bytes of their log: the
 * failure they are reporting is at the end, and the end is what gets cut. The
 * report arrives looking complete and describing a startup that went fine.
 *
 * And a clamp above the Worker's limit is a 413 that takes the whole report
 * with it - message included, not just the log.
 *
 * This matters more than the numbers suggest. B6 is open and waiting for
 * exactly one artefact: "the instrumented message comes back from a real 0.8.1
 * failure". Either of these two mistakes loses it silently.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");

/** a `const NAME = <expr>;` byte count, evaluated as written */
function byteConst(rel: string, name: string): number {
  const m = new RegExp(`const ${name}\\s*=\\s*([0-9.*\\s]+);`).exec(read(rel));
  expect(m, `${name} is no longer a plain numeric constant in ${rel}`).not.toBeNull();
  const value = Number(
    (m?.[1] ?? "")
      .split("*")
      .map((p) => Number(p.trim()))
      .reduce((a, b) => a * b, 1),
  );
  expect(Number.isFinite(value) && value > 0, `${name} in ${rel} did not evaluate to a size`).toBe(true);
  return value;
}

describe("the sizes a failure report passes through", () => {
  const logRoll = byteConst("packages/companion/src/fileLog.ts", "DEFAULT_MAX_BYTES");
  const clamp = byteConst("apps/standalone/renderer/app.ts", "FEEDBACK_LOG_MAX_BYTES");
  const workerLimit = byteConst("apps/hosted-relay/src/index.ts", "FEEDBACK_LOG_MAX");

  it("found all three, so the comparisons below mean something", () => {
    for (const [name, v] of [
      ["the file log's roll", logRoll],
      ["the renderer's clamp", clamp],
      ["the Worker's limit", workerLimit],
    ] as const) {
      expect(v, `${name} was not found`).toBeGreaterThan(1024);
    }
  });

  it("bounds relay.log below the clamp, because the clamp keeps the head", () => {
    expect(
      logRoll,
      `relay.log may reach ${logRoll} bytes and the renderer clamps at ${clamp}. clampUtf8Bytes keeps the ` +
        "FIRST bytes, so a log over the clamp is sent with its end cut off - and the end is where the failure " +
        "being reported is. The report arrives looking complete and describing a startup that went fine.",
    ).toBeLessThanOrEqual(clamp);
  });

  it("clamps at or below what the Worker will accept", () => {
    expect(
      clamp,
      `the renderer may send ${clamp} bytes and the Worker refuses over ${workerLimit} with a 413 - which ` +
        "throws away the whole report, the person's message included, not just the log",
    ).toBeLessThanOrEqual(workerLimit);
  });
});
