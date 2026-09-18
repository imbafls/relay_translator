import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "@callout-relay/shared";
import type { AppConfig } from "@callout-relay/shared";
import { restartAfterConfigChange } from "../src/relayRestart";

/**
 * Saving anything the relay reads - a key, the port, the relay address -
 * restarts the embedded relay, and a restart that fails used to put the old
 * settings back, always. That is right when the save broke a working relay: a
 * port typo would otherwise persist, fail every START and fail again on
 * relaunch.
 *
 * It is wrong when there was no working relay to go back to. Another program
 * holding 8787 from launch means the relay never started; every restart fails
 * the same way whatever is saved, so the rollback only destroyed input. On a
 * fresh install that input is the Deepgram key from setup step 1, put back to
 * nothing - and setup, which stays on a step whose save failed, could not get
 * past it, while the port that would fix it lives in SETTINGS, which a first
 * run cannot reach.
 */

const before: AppConfig = { ...DEFAULT_CONFIG, deepgramApiKey: "" };
const after: AppConfig = { ...before, deepgramApiKey: "dg-pasted-in-setup" };

function harness(opts: { relayWasUp: boolean; restarts: ("ok" | "fail")[] }) {
  const stored: Partial<AppConfig>[] = [];
  const lines: string[] = [];
  let attempts = 0;
  const run = restartAfterConfigChange({
    relayWasUp: opts.relayWasUp,
    before,
    after,
    restart: async () => {
      const outcome = opts.restarts[attempts++] ?? "fail";
      if (outcome === "fail") throw new Error("listen EADDRINUSE: address already in use 0.0.0.0:8787");
    },
    store: (patch) => stored.push(patch),
    log: (level, message) => lines.push(`${level}: ${message}`),
  });
  return { run, stored, lines, attempts: () => attempts };
}

describe("a relay restart that fails after a save", () => {
  it("puts the previous settings back when the save broke a working relay", async () => {
    const h = harness({ relayWasUp: true, restarts: ["fail", "ok"] });

    await expect(h.run).rejects.toThrow(/relay could not restart: listen EADDRINUSE/);
    expect(h.stored, "the settings that broke the relay were left saved").toEqual([{ deepgramApiKey: "" }]);
    expect(h.attempts(), "the previous settings were not restarted on").toBe(2);
  });

  it("keeps the new settings when the relay was not running before them either", async () => {
    const h = harness({ relayWasUp: false, restarts: ["fail"] });

    await expect(h.run).rejects.toThrow(/relay could not start: listen EADDRINUSE/);
    expect(h.stored, "the pasted key was rolled back to settings that could not run the relay either").toEqual([]);
    expect(h.attempts(), "restarted again on settings it did not put back").toBe(1);
  });

  it("says in the error that the settings were kept, so nobody reads it as lost", async () => {
    const h = harness({ relayWasUp: false, restarts: ["fail"] });

    await expect(h.run).rejects.toThrow(/settings were saved/);
    expect(h.lines.join("\n")).toMatch(/keeping the new settings/);
  });

  /**
   * main.ts is Electron and does not run here, so what it hands this function
   * is read off its source, the way publisherIsLocal.test.ts reads it. The
   * whole decision rests on `relayWasUp` meaning "before this save": read after
   * the store writes, or after a restart has nulled the handle, it is always
   * false and every failed save keeps its settings - a port typo included.
   */
  it("is handed whether the relay was up BEFORE the save, by main", () => {
    const main = fs
      .readFileSync(path.resolve(__dirname, "..", "src", "main.ts"), "utf8")
      .replace(/(^|\s)\/\/.*$/gm, "$1");
    const at = main.indexOf("async function applyConfig(");
    expect(at, "applyConfig is gone from main.ts").toBeGreaterThan(-1);
    const body = main.slice(at, main.indexOf("\n}", at));

    const read = body.indexOf("const relayWasUp = relay !== null;");
    const write = body.indexOf("configStore.update(patch)");
    expect(read, "applyConfig no longer reads whether the relay was up").toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(read, "relayWasUp is read after the store has already written the new settings").toBeLessThan(write);
    // the variable itself - `relayWasUp,` or `relayWasUp: relayWasUp` - not a
    // literal, which would decide every failed save the same way
    expect(body, "applyConfig does not hand the relayWasUp it read to the restart decision").toMatch(
      /restartAfterConfigChange\(\{[^}]*\brelayWasUp\s*(?:,|\}|:\s*relayWasUp\b)/,
    );
  });

  /**
   * And when the relay is down, main says why. startEmbeddedRelay records the
   * failure, status carries it while there is no relay, and START's error
   * names it - read off main.ts's source, since it does not run here. The
   * renderer's half, the chip in 04 OUTPUT, is in renderer.test.ts.
   */
  it("hands the console the reason the relay is down, by main", () => {
    const main = fs
      .readFileSync(path.resolve(__dirname, "..", "src", "main.ts"), "utf8")
      .replace(/(^|\s)\/\/.*$/gm, "$1");
    const body = (name: string): string => {
      const at = main.indexOf(name);
      expect(at, `${name} is gone from main.ts`).toBeGreaterThan(-1);
      return main.slice(at, main.indexOf("\n}", at));
    };

    const start = body("async function startEmbeddedRelay(");
    expect(start, "a failed start is not recorded").toMatch(/catch \(err\) \{[^}]*relayStartError = /);
    expect(start, "a good start does not clear the last failure").toMatch(/relayStartError = undefined/);
    expect(body("function currentStatus("), "status does not carry the reason").toMatch(
      /localError: relay \? undefined : relayStartError/,
    );
    expect(main, "START's error does not name the reason").toMatch(/local relay not running: \$\{relayStartError\}/);
  });

  it("does nothing else when the restart works", async () => {
    for (const relayWasUp of [true, false]) {
      const h = harness({ relayWasUp, restarts: ["ok"] });

      await expect(h.run).resolves.toBeUndefined();
      expect(h.stored).toEqual([]);
      expect(h.attempts()).toBe(1);
    }
  });
});
