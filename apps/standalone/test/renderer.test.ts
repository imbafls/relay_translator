// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG, FALLBACK_STT } from "@callout-relay/shared";
import type { AppConfig } from "@callout-relay/shared";

/**
 * The renderer booting for real: the shipped index.html in a DOM, the real
 * app.ts imported so its own boot() runs, and the preload bridge stood in for -
 * that bridge is the process boundary, and everything behind it is Electron.
 *
 * What this reaches that nothing else could: the decision boot() makes about
 * which view to open, and the fallback for a config naming a model that has
 * left the catalogue. Turn 5 hardened that fallback and could only argue for it
 * by reading.
 */

const rendererDir = path.resolve(__dirname, "..", "renderer");
const html = fs.readFileSync(path.join(rendererDir, "index.html"), "utf8");

interface Calls {
  setConfig: Partial<AppConfig>[];
  validateKey: string[];
}

let calls: Calls;
/**
 * boot() starts a clock and a level meter on intervals and never stops them -
 * correct for a window that lives as long as the app, and a leak in a test,
 * where they go on firing into a page that has been torn down.
 */
let timers: ReturnType<typeof setInterval>[] = [];
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

/** everything behind the preload bridge, answering the way the app would */
function bridge(config: AppConfig) {
  let current = { ...config };
  return {
    getConfig: async () => current,
    setConfig: async (patch: Partial<AppConfig>) => {
      calls.setConfig.push(patch);
      current = { ...current, ...patch };
      return current;
    },
    prepareSession: async () => ({ viewerUrl: "", localViewerUrl: "", relayUrl: "" }),
    rotateLink: async () => undefined,
    validateKey: async (provider: "deepgram" | "gemini") => {
      calls.validateKey.push(provider);
      return { valid: true };
    },
    checkForUpdate: async () => undefined,
    installUpdate: async () => false,
    onUpdate: () => {},
    openExternal: async () => {},
    reportState: () => {},
    reportDevices: () => {},
    modelStatus: async () => [],
    downloadModel: async () => [],
    cancelModel: async () => [],
    removeModel: async () => [],
    onCommand: () => {},
    onConfigChanged: () => {},
    onStatus: () => {},
  };
}

/** let boot()'s awaits settle */
const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The onboarding key checks are debounced by 500 ms - they are wired to
 * keystrokes - so reopening setup does not validate anything immediately.
 */
async function waitFor(cond: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`${what} never happened within ${ms}ms`);
    await settle(20);
  }
}

async function bootWith(config: Partial<AppConfig>): Promise<void> {
  calls = { setConfig: [], validateKey: [] };
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, "");

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { mediaDevices: { enumerateDevices: async () => [] } },
  });
  // happy-dom has no document.fonts; the renderer waits on it while laying out
  // and an exception there stops boot() before it chooses a view
  if (!(document as unknown as { fonts?: unknown }).fonts) {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
  }
  (window as unknown as { cr: unknown }).cr = bridge({ ...DEFAULT_CONFIG, ...config } as AppConfig);

  const realSetInterval = globalThis.setInterval;
  (globalThis as unknown as { setInterval: unknown }).setInterval = ((
    fn: Parameters<typeof setInterval>[0],
    ms?: number,
  ) => {
    const id = realSetInterval(fn, ms);
    timers.push(id);
    return id;
  }) as typeof setInterval;

  try {
    vi.resetModules();
    await import("../renderer/app");
    await settle();
  } finally {
    (globalThis as unknown as { setInterval: unknown }).setInterval = realSetInterval;
  }
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const t of timers) clearInterval(t);
  timers = [];
  vi.restoreAllMocks();
  if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
  document.body.innerHTML = "";
});

const visible = (id: string): boolean => {
  const el = document.getElementById(id);
  return !!el && !el.classList.contains("hidden") && el.getAttribute("hidden") === null;
};

describe("what the app opens on", () => {
  it("opens setup on a fresh install", async () => {
    await bootWith({ setupDone: false });
    expect(visible("onboarding")).toBe(true);
  });

  it("goes straight to the stage once setup is done", async () => {
    await bootWith({ setupDone: true });
    expect(visible("onboarding")).toBe(false);
  });
});

describe("setup reopening on keys that are already saved", () => {
  /**
   * The bug this guards was real enough to get its own commit. A key saved in
   * an earlier run has no validation cached in this one, so step 2 opened
   * showing EMPTY with CONTINUE dead, and the only enabled way out was SKIP -
   * which turns off the very translation the key was there for.
   */
  it("re-checks a saved Gemini key instead of showing it as empty", async () => {
    await bootWith({ setupDone: false, geminiApiKey: "gm-saved-earlier" });
    await waitFor(() => calls.validateKey.includes("gemini"), "the gemini re-check");
  });

  it("re-checks a saved Deepgram key too", async () => {
    await bootWith({ setupDone: false, deepgramApiKey: "dg-saved-earlier" });
    await waitFor(() => calls.validateKey.includes("deepgram"), "the deepgram re-check");
  });

  it("does not check a key that was never saved", async () => {
    await bootWith({ setupDone: false });
    // well past the debounce, so this is absence rather than impatience
    await settle(700);
    expect(calls.validateKey).toEqual([]);
  });

  it("puts the saved keys back in the fields", async () => {
    await bootWith({
      setupDone: false,
      deepgramApiKey: "dg-saved-earlier",
      geminiApiKey: "gm-saved-earlier",
    });
    expect((document.getElementById("obDeepgramKey") as HTMLInputElement).value).toBe("dg-saved-earlier");
    expect((document.getElementById("obGeminiKey") as HTMLInputElement).value).toBe("gm-saved-earlier");
  });

  it("always opens on the first step", async () => {
    await bootWith({ setupDone: false, deepgramApiKey: "dg-saved-earlier" });
    expect(document.getElementById("app")?.dataset.view).toBe("onboarding");
    expect(document.getElementById("blkStt")?.classList.contains("current")).toBe(true);
  });
});

describe("a config naming a model that is gone", () => {
  it("falls back instead of stranding on it", async () => {
    // whisper-small was dropped from the catalogue for aborting the process;
    // a config still naming it must not leave the app pointing at nothing
    await bootWith({ setupDone: true, stt: "local-whisper-small" });

    expect(calls.setConfig).toContainEqual({ stt: FALLBACK_STT });
  });

  it("says so in the log rather than changing things silently", async () => {
    await bootWith({ setupDone: true, stt: "local-whisper-small" });
    expect(document.getElementById("log")?.textContent).toContain("no longer available");
  });

  it("leaves a config naming a model that still exists alone", async () => {
    await bootWith({ setupDone: true, stt: "deepgram-nova-3" });
    expect(calls.setConfig.some((p) => "stt" in p)).toBe(false);
  });
});
