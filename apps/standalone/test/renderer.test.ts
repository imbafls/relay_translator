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
  /** provider + the exact string validated - a count alone cannot tell a
   *  re-check of the saved key from a second debounce of the typed one */
  validated: { provider: string; key: string }[];
  /** text handed to the main process for the OS clipboard */
  clipboard: string[];
}

let calls: Calls;
/**
 * boot() starts a clock and a level meter on intervals and never stops them -
 * correct for a window that lives as long as the app, and a leak in a test,
 * where they go on firing into a page that has been torn down.
 */
let timers: ReturnType<typeof setInterval>[] = [];
/** what cr.appVersion() answers; the what's-new panel keys off it */
let appVersion = "0.5.4";
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
    validateKey: async (provider: "deepgram" | "gemini", key: string) => {
      calls.validateKey.push(provider);
      calls.validated.push({ provider, key });
      return { valid: true };
    },
    checkForUpdate: async () => undefined,
    installUpdate: async () => false,
    onUpdate: () => {},
    openExternal: async () => {},
    writeClipboard: async (text: string) => {
      calls.clipboard.push(text);
    },
    appVersion: async () => appVersion,
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
  calls = { setConfig: [], validateKey: [], validated: [], clipboard: [] };
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

  /**
   * The one a real user hit: they pasted a new Deepgram key into KEYS, clicked
   * RUN SETUP AGAIN without saving, and setup came up showing the OLD key as
   * VALID. Continuing wrote the dead key back, so the pasted one vanished and
   * they had to paste it again - which is exactly what they reported.
   *
   * The cause was a verdict cache keyed by provider rather than by the string
   * it was earned for, so the verdict for the newly typed key was read back
   * against the old saved one and used to suppress the re-check.
   */
  it("re-checks the saved key rather than trusting a verdict for a different string", async () => {
    await bootWith({ setupDone: true, deepgramApiKey: "dg-saved-earlier" });
    (document.getElementById("keysBtn") as HTMLButtonElement).click();
    await settle();

    // type a different key, and let it earn a verdict of its own
    const field = document.getElementById("deepgramApiKey") as HTMLInputElement;
    field.value = "dg-freshly-pasted";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(
      () => calls.validated.some((v) => v.key === "dg-freshly-pasted"),
      "the check for the typed key",
    );

    // reopen setup without saving: the field refills from the saved config, so
    // the cached verdict belongs to a string that is no longer in play
    // boot may already have validated the saved key, so only entries recorded
    // AFTER this click count - otherwise the assertion is satisfied by history
    const before = calls.validated.length;
    (document.getElementById("keysSetup") as HTMLButtonElement).click();
    // the saved key itself must be re-validated. Counting calls is not enough:
    // a second debounce of the typed key would satisfy a count and prove
    // nothing, which is how the first version of this test passed against the
    // very bug it was written for.
    await waitFor(
      () =>
        calls.validated
          .slice(before)
          .some((v) => v.provider === "deepgram" && v.key === "dg-saved-earlier"),
      "the saved key to be re-checked instead of reusing the other key's verdict",
    );
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

describe("copying the viewer link", () => {
  /**
   * A real user's log had two consecutive "link copy failed" lines, and they
   * said out loud that the button did not work. navigator.clipboard.writeText
   * needs the "clipboard-sanitized-write" permission, and main.ts denies every
   * permission except media - so the promise rejected with NotAllowedError and
   * the bare catch turned it into that one useless line.
   *
   * Nothing in the renderer may reach for navigator.clipboard again: it is not
   * available to this window, and reintroducing it silently breaks copying.
   */
  it("goes through the main process, not navigator.clipboard", () => {
    const src = fs.readFileSync(path.join(rendererDir, "app.ts"), "utf8");
    expect(src).toContain("cr.writeClipboard(");
    // comments stripped: this file explains the denial in prose, and matching
    // that would be matching the explanation rather than the code
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code, "navigator.clipboard is denied by the permission handler").not.toMatch(
      /navigator\s*\.\s*clipboard/,
    );
  });

  it("declares the channel on the preload bridge", () => {
    const preload = fs.readFileSync(path.resolve(__dirname, "..", "src", "preload.ts"), "utf8");
    expect(preload).toContain("writeClipboard");
    expect(preload).toContain('ipcRenderer.invoke("clipboard:write"');
  });

  it("handles that channel in the main process", () => {
    const main = fs.readFileSync(path.resolve(__dirname, "..", "src", "main.ts"), "utf8");
    expect(main).toContain('ipcMain.handle("clipboard:write"');
    expect(main, "Electron's clipboard module is what bypasses the permission").toMatch(
      /clipboard\s*\.\s*writeText/,
    );
  });
});

describe("what's new after an auto-update", () => {
  /**
   * The update happens on restart without being asked for, so the panel is the
   * only thing that tells the user why the app looks different. It must appear
   * exactly once, and never on a machine that has just installed.
   */
  it("appears when the running version is newer than the last one seen", async () => {
    appVersion = "0.5.4";
    await bootWith({ setupDone: true, lastSeenVersion: "0.5.2" });
    await settle(60);

    expect(document.getElementById("whatsnew")?.hidden).toBe(false);
    expect(document.getElementById("wnVersion")?.textContent).toBe("0.5.4");
    // the jump skipped 0.5.3, so both releases are listed
    expect(document.getElementById("wnBody")?.textContent).toContain("Linux");
    expect(document.getElementById("wnFrom")?.textContent).toContain("0.5.2");
  });

  it("records the version it showed, so it does not come back", async () => {
    appVersion = "0.5.4";
    await bootWith({ setupDone: true, lastSeenVersion: "0.5.2" });
    await settle(60);

    expect(calls.setConfig.some((p) => p.lastSeenVersion === "0.5.4")).toBe(true);
  });

  it("stays shut on a fresh install, which has updated from nothing", async () => {
    appVersion = "0.5.4";
    await bootWith({ setupDone: true });
    await settle(60);

    expect(document.getElementById("whatsnew")?.hidden).toBe(true);
    // but the version is still recorded, so the NEXT update does show one
    expect(calls.setConfig.some((p) => p.lastSeenVersion === "0.5.4")).toBe(true);
  });

  it("stays shut when nothing has changed", async () => {
    appVersion = "0.5.4";
    await bootWith({ setupDone: true, lastSeenVersion: "0.5.4" });
    await settle(60);

    expect(document.getElementById("whatsnew")?.hidden).toBe(true);
  });

  it("closes on GOT IT", async () => {
    appVersion = "0.5.4";
    await bootWith({ setupDone: true, lastSeenVersion: "0.5.2" });
    await settle(60);
    expect(document.getElementById("whatsnew")?.hidden).toBe(false);

    (document.getElementById("wnClose") as HTMLButtonElement).click();
    expect(document.getElementById("whatsnew")?.hidden).toBe(true);
  });
});

describe("LINK MODE", () => {
  /**
   * The worst defect found in the UI review, because it is visible on a live
   * broadcast. The control was bound with an empty callback, so a pick lived
   * only in the DOM. Any other save in the same pane ran syncControlsFromConfig,
   * which reset the buttons to the stored value; SAVE then read the reset DOM
   * and wrote the old value back. A streamer who chose "fixed" so their OBS
   * browser source kept working silently ended up on "unique", and the next
   * START rotated the viewer token - painting THIS LINK HAS ENDED on stream.
   */
  const pick = (value: string): void => {
    const seg = document.getElementById("linkModeSeg") as HTMLElement;
    const btn = seg.querySelector(`button[data-value="${value}"]`) as HTMLButtonElement;
    btn.click();
  };

  it("saves the pick immediately, like every other segmented control", async () => {
    await bootWith({ setupDone: true, linkMode: "unique" });
    (document.getElementById("keysBtn") as HTMLButtonElement).click();
    await settle();

    pick("fixed");
    await settle(40);

    expect(calls.setConfig.some((p) => p.linkMode === "fixed")).toBe(true);
  });

  it("survives an unrelated save in the same pane", async () => {
    await bootWith({ setupDone: true, linkMode: "unique" });
    (document.getElementById("keysBtn") as HTMLButtonElement).click();
    await settle();

    pick("fixed");
    await settle(40);

    // anything else in this pane that writes config re-syncs the controls
    (document.getElementById("autoUpdate") as HTMLButtonElement).click();
    await settle(40);

    const seg = document.getElementById("linkModeSeg") as HTMLElement;
    const active = seg.querySelector("button.active") as HTMLElement | null;
    expect(active?.dataset.value, "the pick was reset by the re-sync").toBe("fixed");

    // and the value that would reach main.ts is still the one chosen
    const last = calls.setConfig[calls.setConfig.length - 1];
    expect(last.linkMode === undefined || last.linkMode === "fixed").toBe(true);
  });
});

describe("reaching the OBS overlay link", () => {
  /**
   * A user put the phone link into an OBS browser source and got an opaque
   * page with an amber bar instead of a transparent overlay, then asked how to
   * get rid of the bar. He was not picking the wrong link: on the DEFAULT
   * output ("phone") the PHONE/OBS switcher was hidden and currentLink()
   * ignored the choice, so the overlay URL had no path in the UI at all.
   */
  it("offers both destinations on the default output", async () => {
    await bootWith({ setupDone: true, output: "phone" });
    await settle();

    const seg = document.getElementById("linkSeg") as HTMLElement;
    expect(seg.hidden, "the OBS link is unreachable when this is hidden").toBe(false);
    expect(seg.querySelector('button[data-value="obs"]')).not.toBeNull();
    expect(seg.querySelector('button[data-value="phone"]')).not.toBeNull();
  });

  it("still offers them when output is obs-only", async () => {
    await bootWith({ setupDone: true, output: "obs" });
    await settle();
    expect((document.getElementById("linkSeg") as HTMLElement).hidden).toBe(false);
  });

  it("markup does not ship the switcher hidden", () => {
    const src = fs.readFileSync(path.join(rendererDir, "index.html"), "utf8");
    expect(src).toMatch(/id="linkSeg"(?![^>]*hidden)/);
  });
});
