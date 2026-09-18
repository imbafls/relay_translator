// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG, FALLBACK_STT, HOSTED_RELAY_URL, STT_MODELS } from "@callout-relay/shared";
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
import type { Transcript, TranscriptStatus, TranscriptSummary } from "@callout-relay/shared";

interface Calls {
  /** saved-transcript ids handed to main to export, reveal or delete */
  exported: { id: string; format: string }[];
  revealed: string[];
  deleted: string[];
  /** how many times OPEN FOLDER asked main to open the transcripts folder */
  openedDir: number;
  setConfig: Partial<AppConfig>[];
  validateKey: string[];
  /** provider + the exact string validated - a count alone cannot tell a
   *  re-check of the saved key from a second debounce of the typed one */
  validated: { provider: string; key: string }[];
  /** text handed to the main process for the OS clipboard */
  clipboard: string[];
  /** URLs the renderer asked the OS to open */
  opened: string[];
  /** relay addresses a room was claimed on; undefined means "the default one" */
  claimed: (string | undefined)[];
  /** each time the viewer link was actually rotated */
  rotated: number[];
}

/** the status callback boot() registers, so a test can push a live relay in */
let pushStatus: ((s: unknown) => void) | undefined;

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
      if (setConfigFails) throw new Error("EADDRINUSE: port 3000 is already in use");
      calls.setConfig.push(patch);
      current = { ...current, ...patch };
      return current;
    },
    // matches RendererBridge.prepareSession's real shape (preload.ts):
    // publisherUrl and config are not optional, and startSession() reads both
    // (config = prep.config) - a click that drives a real START through this
    // mock left config undefined and renderIdle()'s config.stt read threw an
    // unhandled rejection once the preflight failed and setState("error", ...)
    // tried to redraw the stage.
    prepareSession: async () => ({ publisherUrl: "ws://127.0.0.1:0/publish", viewerUrl: "", obsUrl: "", phoneUrl: "", config: current }),
    rotateLink: async () => {
      calls.rotated.push(Date.now());
      return undefined;
    },
    claimRelayRoom: async (relayUrl?: string) => {
      calls.claimed.push(relayUrl);
      if (claimFails) return { ok: false, message: claimFails };
      // the real handler stores the room through applyConfig, so the config the
      // renderer reads back afterwards is the one carrying the new room
      current = { ...current, relayUrl: relayUrl || HOSTED_RELAY_URL, publisherToken: "p1_room_secret" };
      return { ok: true };
    },
    validateKey: async (provider: "deepgram" | "gemini", key: string) => {
      calls.validateKey.push(provider);
      calls.validated.push({ provider, key });
      return { valid: true };
    },
    checkForUpdate: async () => undefined,
    installUpdate: async () => false,
    onUpdate: () => {},
    openExternal: async (url: string) => {
      calls.opened.push(url);
    },
    writeClipboard: async (text: string) => {
      calls.clipboard.push(text);
    },
    appVersion: async () => {
      if (appVersionFails) throw new Error("ipc timeout");
      return appVersion;
    },
    reportState: () => {},
    reportDevices: () => {},
    modelStatus: async () => fakeModels,
    downloadModel: async () => [],
    cancelModel: async () => [],
    removeModel: async () => [],
    onCommand: () => {},
    onConfigChanged: () => {},
    onStatus: (cb: (s: unknown) => void) => {
      pushStatus = cb;
    },
    readRelayLog: async () => {
      if (readRelayLogGate) await readRelayLogGate;
      return fakeRelayLog;
    },
    sendFeedback: async (payload: unknown) => {
      feedbackSends.push({ payload });
      return feedbackResult;
    },
    listTranscripts: async () => fakeSaved,
    readTranscript: async (id: string) => fakeSavedBodies[id],
    exportTranscript: async (id: string, format: "txt" | "srt") => {
      calls.exported.push({ id, format });
      return `C:\\Transcripts\\${id}.${format}`;
    },
    revealTranscript: async (id: string) => {
      calls.revealed.push(id);
    },
    deleteTranscript: async (id: string) => {
      calls.deleted.push(id);
      fakeSaved = fakeSaved.filter((s) => s.id !== id);
      return true;
    },
    chooseTranscriptDir: async () => undefined,
    openTranscriptDir: async () => {
      calls.openedDir += 1;
    },
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

/** what enumerateDevices() answers; the built-in two are added by the app */
let fakeDevices: { kind: string; deviceId: string; label: string; groupId: string }[] = [];
/** make the main process refuse the save, the way a relay that cannot bind does */
let setConfigFails = false;
/** when set, claiming a room fails with this message */
let claimFails: string | null = null;
/** what cr.modelStatus() answers: the local models on disk */
let fakeModels: { id: string; downloaded: boolean; sizeMb: number }[] = [];
/** what cr.readRelayLog() answers - the raw, unredacted relay.log text */
let fakeRelayLog = "";
/**
 * Delays cr.readRelayLog()'s resolution until released, so a test can create
 * a real race between ticking INCLUDE MY LOG and unticking it again before
 * the read comes back. null (the default) means "resolve immediately".
 */
let readRelayLogGate: Promise<void> | null = null;
let releaseReadRelayLogGate: (() => void) | null = null;
/** when set, cr.appVersion() rejects instead of answering - a local IPC hiccup */
let appVersionFails = false;
/** what cr.listTranscripts() answers, newest first */
let fakeSaved: TranscriptSummary[] = [];
/** what cr.readTranscript(id) answers, by id */
let fakeSavedBodies: Record<string, Transcript> = {};
/**
 * Every call to cr.sendFeedback() actually made. The real network I/O for
 * this feature happens in the main process now (packages/companion's
 * sendFeedback, over IPC - a fetch() from this renderer's file:// origin is
 * CORS-blocked against the hosted relay by design, see main.ts), so this
 * stands in for that IPC call the same way every other `calls.*` array
 * stands in for the rest of the bridge. Empty until SEND is pressed is
 * exactly what proves nothing leaves the machine before that.
 */
let feedbackSends: { payload: unknown }[] = [];
/** what the mocked cr.sendFeedback() answers with - a FeedbackResult */
let feedbackResult: { delivered: true; id: string; logFailed: boolean } | { delivered: false; message: string } = {
  delivered: true,
  id: "a1b2c3d4e5f6a7b8",
  logFailed: false,
};

async function bootWith(config: Partial<AppConfig>, devices = fakeDevices): Promise<void> {
  calls = {
    setConfig: [],
    validateKey: [],
    validated: [],
    clipboard: [],
    opened: [],
    claimed: [],
    rotated: [],
    exported: [],
    revealed: [],
    deleted: [],
    openedDir: 0,
  };
  pushStatus = undefined;
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, "");

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { mediaDevices: { enumerateDevices: async () => devices } },
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
  feedbackSends = [];
  feedbackResult = { delivered: true, id: "a1b2c3d4e5f6a7b8", logFailed: false };
});

afterEach(() => {
  fakeDevices = [];
  setConfigFails = false;
  claimFails = null;
  fakeModels = [];
  fakeRelayLog = "";
  readRelayLogGate = null;
  releaseReadRelayLogGate = null;
  appVersionFails = false;
  fakeSaved = [];
  fakeSavedBodies = {};
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
    (document.getElementById("settingsBtn") as HTMLButtonElement).click();
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
    (document.getElementById("settingsSetup") as HTMLButtonElement).click();
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

describe("saved transcripts", () => {
  const T0 = Date.UTC(2026, 8, 10, 12, 0, 0);
  const NEWER = "2026-09-10T13-00-00";
  const OLDER = "2026-09-10T12-00-00";

  const summary = (id: string, lines = 2, startedAt = T0): TranscriptSummary => ({
    id,
    startedAt,
    endedAt: startedAt + 5000,
    lines,
    bytes: 512,
    languages: { source: "en", target: "vi" },
  });
  const body = (id: string): Transcript => ({
    id,
    header: {
      v: 1,
      kind: "session",
      id,
      startedAt: T0,
      app: "0.8.0",
      languages: { source: "en", target: "vi" },
      translates: true,
    },
    rows: [
      { n: 1, id: 1, t: T0 + 2000, source: "push B", target: "B'ye geliyorlar" },
      { n: 2, id: 2, t: T0 + 5000, source: "one on A", speaker: "CHAT" },
    ],
  });
  /** a status push carrying only what the renderers read, plus the transcript part */
  const statusWith = (transcript: TranscriptStatus) => ({
    companion: { version: "0.8.0" },
    session: { state: "idle" },
    relay: { mode: "embedded", url: "ws://127.0.0.1:8787", viewers: 0, remoteViewers: 0 },
    devices: [],
    config: { ...DEFAULT_CONFIG, setupDone: true },
    transcript,
  });
  const click = async (id: string): Promise<void> => {
    (document.getElementById(id) as HTMLButtonElement).click();
    await settle();
  };
  async function enterSaved(): Promise<void> {
    await bootWith({ setupDone: true });
    await click("savedBtn");
  }

  it("opens from the footer and lists every saved session", async () => {
    fakeSaved = [summary(NEWER, 7), summary(OLDER, 3)];
    await enterSaved();

    expect(visible("savedView")).toBe(true);
    expect(visible("stage")).toBe(false);
    const items = [...document.querySelectorAll("#savedList .saved-item")];
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("7 LINES");
  });

  /**
   * The case the feature exists for: the app has just been reopened after a
   * session died. That last session is the one wanted, so it is already open
   * in the reader rather than waiting to be found in a list.
   */
  it("opens the newest session straight into the reader", async () => {
    fakeSaved = [summary(NEWER), summary(OLDER)];
    fakeSavedBodies = { [NEWER]: body(NEWER) };
    await enterSaved();

    const text = document.getElementById("savedLines")!.textContent || "";
    expect(text).toContain("push B");
    expect(text).toContain("B'ye geliyorlar");
    expect(text).toContain("00:00:02");
    expect(text).toContain("CHAT");
  });

  it("renders transcript text as text, never as markup", async () => {
    fakeSaved = [summary(NEWER)];
    const t = body(NEWER);
    t.rows[0].source = '<img src=x onerror="window.__pwned=1">';
    fakeSavedBodies = { [NEWER]: t };
    await enterSaved();

    expect(document.querySelector("#savedLines img")).toBeNull();
    expect(document.getElementById("savedLines")!.textContent).toContain("<img src=x");
  });

  it("says so when nothing has been saved yet", async () => {
    await enterSaved();
    expect(document.getElementById("savedList")!.textContent).toContain("Nothing saved yet");
    expect((document.getElementById("savedDelete") as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks before deleting, then deletes", async () => {
    fakeSaved = [summary(NEWER)];
    fakeSavedBodies = { [NEWER]: body(NEWER) };
    await enterSaved();

    await click("savedDelete");
    expect(document.getElementById("savedDelete")!.textContent).toBe("SURE?");
    expect(calls.deleted, "one press only arms it").toEqual([]);

    await click("savedDelete");
    expect(calls.deleted).toEqual([NEWER]);
  });

  /**
   * The file main is writing right now. Deleting it mid-session would leave the
   * writer appending to a path that has gone, and main refuses it anyway - so
   * the button does not offer what would be refused.
   */
  /**
   * DELETE arms to SURE? before it does anything, and the arming has to belong to
   * the session it was pressed on. Picking a different row while it is armed, or
   * leaving the view and coming back, must both put it back - otherwise a press
   * meant for one recording lands on another, and what it destroys is the only
   * copy of what somebody said.
   *
   * The arm-then-confirm path is covered above. These are the two ways out of it,
   * and neither was.
   */
  it("forgets an armed DELETE when a different session is opened", async () => {
    fakeSaved = [summary(NEWER), summary(OLDER)];
    fakeSavedBodies = { [NEWER]: body(NEWER), [OLDER]: body(OLDER) };
    await enterSaved();

    await click("savedDelete");
    expect(document.getElementById("savedDelete")!.textContent, "the first press did not arm it").toBe(
      "SURE?",
    );

    // the other session in the list
    const rows = [...document.querySelectorAll<HTMLElement>("#savedList .saved-item")];
    const other = rows.find((r) => !r.classList.contains("open")) ?? rows[1];
    other.click();
    await settle(40);

    expect(
      document.getElementById("savedDelete")!.textContent,
      "DELETE stayed armed after moving to another session - the next press would delete the wrong one",
    ).not.toBe("SURE?");
    expect(calls.deleted, "nothing should have been deleted yet").toEqual([]);
  });

  it("forgets an armed DELETE when the view is left", async () => {
    fakeSaved = [summary(NEWER)];
    fakeSavedBodies = { [NEWER]: body(NEWER) };
    await enterSaved();

    await click("savedDelete");
    expect(document.getElementById("savedDelete")!.textContent).toBe("SURE?");

    await click("savedBack");
    await click("savedBtn");
    await settle(40);

    expect(
      document.getElementById("savedDelete")!.textContent,
      "DELETE was still armed on the way back in, so one press would destroy a transcript",
    ).not.toBe("SURE?");
    expect(calls.deleted).toEqual([]);
  });

  it("will not offer to delete the session still being recorded", async () => {
    fakeSaved = [summary(NEWER)];
    fakeSavedBodies = { [NEWER]: body(NEWER) };
    await bootWith({ setupDone: true });
    pushStatus?.(statusWith({ state: "saving", dir: "C:\\Transcripts", session: NEWER }));
    await click("savedBtn");

    expect((document.getElementById("savedDelete") as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById("savedList")!.textContent).toContain("RECORDING");
  });

  it("says NOT SAVING, in amber, when a write has failed", async () => {
    await bootWith({ setupDone: true });
    pushStatus?.(statusWith({ state: "failed", dir: "E:\\Gone", error: "ENOENT: no such file or directory" }));
    await click("savedBtn");

    const state = document.getElementById("savedState")!;
    expect(state.textContent).toBe("NOT SAVING");
    expect(state.classList.contains("failed")).toBe(true);
    expect(state.title).toContain("ENOENT");
  });

  it("switches saving off from SETTINGS, and the toggle follows", async () => {
    await bootWith({ setupDone: true });
    await click("settingsBtn");
    const toggle = document.getElementById("saveTranscripts")!;
    expect(toggle.classList.contains("on")).toBe(true);

    toggle.click();
    await settle();
    expect(calls.setConfig).toContainEqual({ saveTranscripts: false });
    expect(toggle.classList.contains("on")).toBe(false);
  });

  it("exports and reveals the session open in the reader", async () => {
    fakeSaved = [summary(NEWER)];
    fakeSavedBodies = { [NEWER]: body(NEWER) };
    await enterSaved();

    await click("savedTxt");
    await click("savedSrt");
    await click("savedReveal");
    expect(calls.exported).toEqual([
      { id: NEWER, format: "txt" },
      { id: NEWER, format: "srt" },
    ]);
    expect(calls.revealed).toEqual([NEWER]);
  });

  it("OPEN FOLDER asks main to open the transcripts folder", async () => {
    await enterSaved();
    await click("savedFolder");
    expect(calls.openedDir).toBe(1);
  });

  it("goes back to the stage on Escape", async () => {
    await enterSaved();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();
    expect(visible("stage")).toBe(true);
    expect(visible("savedView")).toBe(false);
  });
});

describe("saved transcripts over the bridge", () => {
  const CHANNELS = [
    "transcripts:list",
    "transcripts:read",
    "transcripts:export",
    "transcripts:reveal",
    "transcripts:delete",
    "transcripts:chooseDir",
    "transcripts:openDir",
  ];
  const source = (file: string): string => fs.readFileSync(path.resolve(__dirname, "..", "src", file), "utf8");

  it("declares every channel on the preload bridge", () => {
    const preload = source("preload.ts");
    for (const c of CHANNELS) expect(preload, c).toContain(`ipcRenderer.invoke("${c}"`);
  });

  it("handles every channel in the main process", () => {
    const main = source("main.ts");
    for (const c of CHANNELS) expect(main, c).toContain(`ipcMain.handle("${c}"`);
  });

  /**
   * The renderer names a transcript by id. Every handler that turns one into a
   * file must resolve it under main's own folder - never hand a value the
   * renderer sent straight to fs or shell.
   */
  it("resolves every id under the folder main chose", () => {
    const main = source("main.ts");
    for (const c of ["transcripts:read", "transcripts:export", "transcripts:reveal", "transcripts:delete"]) {
      const start = main.indexOf(`ipcMain.handle("${c}"`);
      const body = main.slice(start, main.indexOf("ipcMain.", start + 1));
      expect(body, c).toContain("transcriptDir()");
    }
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

/**
 * The shape the panel builds, as distinct from when it is shown.
 *
 * The tests above cover whether it appears, and that the version and the body
 * text are right. They say nothing about how the list is put together, and that
 * is the part a reader actually uses to tell one release from the next in a
 * multi-version jump: the newest release is already named in the header above
 * the list, so it must NOT repeat itself there, while the older ones must be
 * named or their changes belong to nothing.
 *
 * Written before that renderer moved to its own file, because these are exactly
 * the properties a move can break without any existing assertion noticing.
 */
describe("the shape the what's-new panel builds", () => {
  /** the labels the panel puts on each change; restated rather than imported,
   *  so a map that quietly changed would show up here as a difference */
  const LABEL: Record<string, string> = { added: "NEW", fixed: "FIXED", changed: "CHANGED" };

  const releases = (): Element[] => [...document.querySelectorAll("#wnBody .wn-release")];
  const namedVersions = (): string[] =>
    [...document.querySelectorAll("#wnBody .wn-release-head .wn-release-ver")].map(
      (n) => n.textContent ?? "",
    );

  /** a jump that skipped a release, so the list has more than one entry in it */
  const jump = async (): Promise<void> => {
    appVersion = "0.5.4";
    await bootWith({ setupDone: true, lastSeenVersion: "0.5.2" });
    await settle(60);
  };

  it("names every release in the list except the one already in the header", async () => {
    await jump();

    expect(releases().length, "the jump did not produce a multi-release list, so this proves nothing").toBeGreaterThan(1);
    expect(
      namedVersions(),
      "the newest release repeated its own version inside the list, under the header that already says it",
    ).not.toContain("0.5.4");
    expect(
      namedVersions().length,
      "an older release went unnamed, so its changes belong to nothing a reader can see",
    ).toBe(releases().length - 1);
  });

  it("labels every change with the word for its kind", async () => {
    await jump();

    const kinds = [...document.querySelectorAll<HTMLElement>("#wnBody .wn-kind")];
    expect(kinds.length, "no change lines were rendered at all").toBeGreaterThan(0);
    for (const el of kinds) {
      const kind = el.dataset.kind ?? "";
      expect(kind, "a change line carries no kind for the stylesheet to colour").not.toBe("");
      expect(el.textContent, `the label for "${kind}" is not the word this panel uses`).toBe(
        LABEL[kind] ?? kind.toUpperCase(),
      );
    }
  });

  it("puts a date beside every release it names", async () => {
    await jump();

    const named = document.querySelectorAll("#wnBody .wn-release-head").length;
    const dated = [...document.querySelectorAll("#wnBody .wn-release-head .wn-release-date")].filter(
      (n) => (n.textContent ?? "").trim() !== "",
    ).length;
    expect(dated, "a named release has no date beside it").toBe(named);
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
    (document.getElementById("settingsBtn") as HTMLButtonElement).click();
    await settle();

    pick("fixed");
    await settle(40);

    expect(calls.setConfig.some((p) => p.linkMode === "fixed")).toBe(true);
  });

  it("survives an unrelated save in the same pane", async () => {
    await bootWith({ setupDone: true, linkMode: "unique" });
    (document.getElementById("settingsBtn") as HTMLButtonElement).click();
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

describe("the Deepgram key status", () => {
  /**
   * fieldStatus took required=true unconditionally, so a user running speech
   * on their own machine saw an amber NOT SET against a cloud key they do not
   * need and never will - the panel flagging a problem that does not exist.
   */
  const dgStatus = () => document.getElementById("dgStatus") as HTMLElement;

  it("does not flag a missing cloud key when speech runs locally", async () => {
    await bootWith({ setupDone: true, stt: "local-zipformer-en-20m", deepgramApiKey: "" });
    (document.getElementById("settingsBtn") as HTMLButtonElement).click();
    await settle(40);

    expect(dgStatus().classList.contains("warn"), "amber on a key that is not needed").toBe(false);
  });

  it("still flags it when the cloud engine is the one selected", async () => {
    await bootWith({ setupDone: true, stt: "deepgram-nova-3", deepgramApiKey: "" });
    (document.getElementById("settingsBtn") as HTMLButtonElement).click();
    await settle(40);

    expect(dgStatus().classList.contains("warn"), "a genuinely missing key went unflagged").toBe(true);
  });
});

describe("finding the settings", () => {
  /**
   * There was no "settings" anywhere in this app. The only way into
   * configuration was an 11px dim button reading KEYS, sitting at the far
   * right of the footer between the cost readouts and the window edge, and the
   * panel behind it was headed KEYS & RELAY. Everything a normal person would
   * call a setting was somewhere else: the profanity filter and the latency
   * badges were unlabelled chips in the 04 OUTPUT block of the signal chain,
   * and the relay plumbing nobody but a developer touches sat in the same
   * column as the API keys. People had to be told where to go.
   *
   * These pin the four things a DOM test can hold: the name, the single way
   * in, the gathering, and the disclosure. Whether the control actually reads
   * as a control is a thing to look at rather than assert - that was checked
   * in a browser against the shipped markup.
   */
  const settingsPanel = (): HTMLElement => document.getElementById("settings") as HTMLElement;
  const open = async (): Promise<void> => {
    (document.getElementById("settingsBtn") as HTMLButtonElement).click();
    await settle(40);
  };

  it("names the way in after the word people look for", async () => {
    await bootWith({ setupDone: true });
    const btn = document.getElementById("settingsBtn");
    expect(btn, "no settings entry point exists").not.toBeNull();
    expect(btn!.textContent?.toUpperCase()).toContain("SETTINGS");
  });

  it("opens the panel from the stage in one click", async () => {
    await bootWith({ setupDone: true });
    await open();
    expect(visible("settings"), "the settings panel did not open").toBe(true);
    expect((document.getElementById("app") as HTMLElement).dataset.view).toBe("settings");
  });

  it("gathers the caption toggles that were loose in the signal chain", async () => {
    await bootWith({ setupDone: true, profanityFilter: true, showLatency: true });
    await open();

    const filter = document.getElementById("filterToggle");
    const badges = document.getElementById("badgesToggle");
    expect(filter, "no profanity control at all").not.toBeNull();
    expect(badges, "no latency badge control at all").not.toBeNull();
    expect(settingsPanel().contains(filter), "the profanity filter is still outside settings").toBe(true);
    expect(settingsPanel().contains(badges), "the latency badges are still outside settings").toBe(true);

    // and it still works from its new home
    (filter as HTMLButtonElement).click();
    await settle(40);
    expect(calls.setConfig.some((p) => p.profanityFilter === false), "the toggle moved but stopped working").toBe(true);
  });

  it("keeps the relay plumbing behind a disclosure that starts shut", async () => {
    await bootWith({ setupDone: true });
    await open();

    // the five fields a normal user has no business seeing on open
    for (const id of ["relayUrl", "publisherToken", "publicBaseUrl", "relayPort", "updateFeedUrl"]) {
      const field = document.getElementById(id);
      expect(field, `#${id} is gone entirely`).not.toBeNull();
      const disclosure = field!.closest("details");
      expect(disclosure, `#${id} is not behind a disclosure`).not.toBeNull();
      expect(disclosure!.hasAttribute("open"), `#${id} is behind a disclosure that ships open`).toBe(false);
      expect(settingsPanel().contains(field), `#${id} left the settings panel`).toBe(true);
    }
  });

  it("carries a route to the caption appearance settings, which live on the viewer", async () => {
    await bootWith({ setupDone: true });
    await open();

    const btn = document.getElementById("openCaptionView") as HTMLButtonElement | null;
    expect(btn, "settings says nothing about where caption appearance is set").not.toBeNull();
    expect(settingsPanel().contains(btn), "the route is not in the settings panel").toBe(true);

    // with a link in hand it opens the viewer with its settings pinned - in OBS
    // the AA button only appears on hover, which is why ?settings=1 exists
    expect(pushStatus, "boot() never registered for status").toBeTypeOf("function");
    pushStatus!({
      companion: { version: "test" },
      session: { state: "idle" },
      relay: { localViewerUrl: "http://127.0.0.1:8787/watch/abc?obs=1", remoteViewerUrl: "", uplinkState: "off" },
      usage: undefined,
    });
    await settle(40);

    btn!.click();
    await settle(40);
    expect(calls.opened.length, "clicking it opened nothing").toBeGreaterThan(0);
    expect(calls.opened[calls.opened.length - 1]).toContain("settings=1");
  });
});

describe("three capture sources in the app", () => {
  /**
   * The app offered two source pickers and stored them in two named fields.
   * The pipeline carries three now, so the app has to be able to name three -
   * and the third has no role that can be derived from a device list, which is
   * why the slots are nameable at all.
   */
  const devices = [
    { kind: "audioinput", deviceId: "mic-1", label: "Headset", groupId: "g1" },
    { kind: "audioinput", deviceId: "mix-1", label: "Wave Link chat", groupId: "g2" },
  ];

  const openSettings = async (): Promise<void> => {
    (document.getElementById("settingsBtn") as HTMLButtonElement).click();
    await settle(40);
  };

  it("offers a third picker, filled with the same devices as the others", async () => {
    await bootWith({ setupDone: true }, devices);
    const third = document.getElementById("audioSource3") as HTMLSelectElement | null;
    expect(third, "there is no third source slot").not.toBeNull();
    const values = [...third!.options].map((o) => o.value);
    expect(values).toContain("mic-1");
    expect(values).toContain("mix-1");
  });

  it("saves all three slots as one list, not three separate fields", async () => {
    await bootWith({ setupDone: true, sources: ["default-mic"] }, devices);
    const set = (id: string, value: string): void => {
      const el = document.getElementById(id) as HTMLSelectElement;
      el.value = value;
      el.dispatchEvent(new Event("change"));
    };
    set("audioSource2", "mic-1");
    await settle(40);
    set("audioSource3", "mix-1");
    await settle(40);

    const last = calls.setConfig.filter((p) => p.sources).pop();
    expect(last?.sources, "the third pick never reached the config").toEqual(["default-mic", "mic-1", "mix-1"]);
  });

  it("lets a slot be named, and keeps the names as one list", async () => {
    await bootWith({ setupDone: true, sources: ["default-mic", "mic-1", "mix-1"] }, devices);
    await openSettings();

    const name = document.getElementById("sourceName3") as HTMLInputElement | null;
    expect(name, "the third source cannot be named").not.toBeNull();
    name!.value = "COACH";
    name!.dispatchEvent(new Event("change"));
    await settle(40);

    const last = calls.setConfig.filter((p) => p.sourceLabels).pop();
    expect(last?.sourceLabels?.[2]).toBe("COACH");
  });

  it("shows the tag a slot will actually carry, so a blank field is not a mystery", async () => {
    await bootWith({ setupDone: true, sources: ["default-mic", "system-loopback", "mic-1"] }, devices);
    await openSettings();

    expect((document.getElementById("sourceName1") as HTMLInputElement).placeholder).toBe("YOU");
    expect((document.getElementById("sourceName2") as HTMLInputElement).placeholder).toBe("CHAT");
    // the third has no derivable role - the point is that it says so rather
    // than showing a blank the user has to guess about
    expect((document.getElementById("sourceName3") as HTMLInputElement).placeholder).toBe("CH3");
  });

  it("hides the rows for slots that hold no device", async () => {
    await bootWith({ setupDone: true, sources: ["default-mic"] }, devices);
    await openSettings();
    const row = (n: number): HTMLElement =>
      (document.getElementById(`sourceName${n}`) as HTMLElement).closest(".namerow") as HTMLElement;
    expect(row(1).hidden).toBe(false);
    expect(row(2).hidden, "an empty slot offered a name field").toBe(true);
    expect(row(3).hidden).toBe(true);
  });

  /**
   * Changing one colour writes all three, because the handler reads every
   * picker rather than patching the slot that moved - which is right, since
   * `sourceColors` is one list. It is only safe while every picker holds what
   * the config holds, and the rows above are hidden for slots with no device.
   *
   * A streamer who runs three sources, colours them, then drops to one - the
   * coach left, the chat mix is off - and later nudges their own colour would
   * have the other two silently reset to the defaults. Nothing says so: the
   * rows are not on screen, the write succeeds, and the loss only shows up
   * the next time that source is plugged back in.
   *
   * The name fields do not have this problem, which is the tell. They are
   * seeded straight from `config.sourceLabels` for all three slots; the colours
   * were seeded from `channelColors(activeSources())`, a list as long as the
   * sources that are actually on.
   */
  it("keeps the colours of slots that are not on screen", async () => {
    await bootWith(
      { setupDone: true, sources: ["default-mic"], sourceColors: ["#111111", "#22ee22", "#3333ff"] },
      devices,
    );
    await openSettings();

    const picker = document.getElementById("sourceColor1") as HTMLInputElement;
    picker.value = "#ff00ff";
    picker.dispatchEvent(new Event("change"));
    await settle(40);

    const last = calls.setConfig.filter((p) => p.sourceColors).pop();
    expect(
      last?.sourceColors,
      "changing one slot's colour overwrote the colours of the slots that are off, so a source " +
        "plugged back in comes back a different colour than the one it was given",
    ).toEqual(["#ff00ff", "#22ee22", "#3333ff"]);
  });

  // the names are written the same way, from all three fields at once, so they
  // are open to the same loss and are only safe because they are seeded for
  // every slot rather than for every live channel. Asserted rather than
  // believed: this is the half that is already right, and the reason it is
  // right is one line that could be narrowed to match the colours at any time.
  it("keeps the names of slots that are not on screen", async () => {
    await bootWith(
      { setupDone: true, sources: ["default-mic"], sourceLabels: ["ME", "CHAT", "COACH"] },
      devices,
    );
    await openSettings();

    const name = document.getElementById("sourceName1") as HTMLInputElement;
    name.value = "OMER";
    name.dispatchEvent(new Event("change"));
    await settle(40);

    const last = calls.setConfig.filter((p) => p.sourceLabels).pop();
    expect(
      last?.sourceLabels,
      "renaming one slot dropped the names of the slots that are off",
    ).toEqual(["OMER", "CHAT", "COACH"]);
  });

});

describe("a source whose device is no longer plugged in", () => {
  /**
   * Audit finding 7. `fillSelect` never sets `selected` when nothing matches,
   * so the box fell back to index 0 - "No second source" - while the config
   * still held the dead id. `activeSources()` reads the config, not the select,
   * so START still tried to open the missing device with
   * `deviceId: { exact: ... }` and failed every single time. And because the
   * select's value was ALREADY "", picking "No second source" fired no change
   * event, so the one path that could have cleared it never ran.
   *
   * The user saw no second source, a chain that still said YOU + CHAT, and a
   * START that failed with the single word `OverconstrainedError` - Chromium
   * leaves that error's `.message` empty, so the banner named neither the slot
   * nor the device nor the constraint.
   */
  const devices = [{ kind: "audioinput", deviceId: "mic-1", label: "Headset", groupId: "g1" }];

  it("drops a source that is not in the device list any more", async () => {
    await bootWith({ setupDone: true, sources: ["default-mic", "gone-usb-headset"] }, devices);
    await settle(60);

    const written = calls.setConfig.filter((p) => p.sources).pop();
    expect(written?.sources, "the dead id was left in the config for START to trip over").toEqual(["default-mic"]);
  });

  it("says which device went, rather than correcting itself in silence", async () => {
    await bootWith({ setupDone: true, sources: ["default-mic", "gone-usb-headset"] }, devices);
    await settle(60);
    const log = document.getElementById("log")?.textContent || "";
    expect(log.toLowerCase()).toContain("no longer");
  });

  it("leaves a source alone while its device is still there", async () => {
    await bootWith({ setupDone: true, sources: ["default-mic", "mic-1"] }, devices);
    await settle(60);
    const written = calls.setConfig.filter((p) => p.sources).pop();
    expect(written, "a perfectly good pair of sources was rewritten").toBeUndefined();
  });

  it("keeps the built-in sources, which never appear in the device list", async () => {
    // "system-loopback" is offered by the app, not by enumerateDevices()
    await bootWith({ setupDone: true, sources: ["default-mic", "system-loopback"] }, devices);
    await settle(60);
    const written = calls.setConfig.filter((p) => p.sources).pop();
    expect(written, "the built-in loopback source was treated as a dead device").toBeUndefined();
  });
});

describe("a save that did not work", () => {
  /**
   * Audit finding 6, from the user's side. `applyConfig` persists the patch
   * with a synchronous write BEFORE attempting the relay restart, and the
   * restart tears the working relay down before it knows the replacement can
   * bind. When it throws, the renderer swallowed it into one log line and then
   * unconditionally ran `log("keys & relay saved", "ok")` and went back to the
   * stage - so the app reported success, closed the panel, and from then on
   * every START failed with "local relay not ready".
   *
   * The port that gets you there is not exotic: 3000, which another dev server
   * on the same machine already owns.
   */
  const openSettings = async (): Promise<void> => {
    (document.getElementById("settingsBtn") as HTMLButtonElement).click();
    await settle(40);
  };
  const logText = (): string => document.getElementById("log")?.textContent || "";

  it("does not claim the settings were saved when they were not", async () => {
    await bootWith({ setupDone: true });
    await openSettings();
    setConfigFails = true;

    (document.getElementById("settingsSave") as HTMLButtonElement).click();
    await settle(60);

    expect(logText()).not.toContain("settings saved");
    expect(logText().toLowerCase()).toContain("failed");
  });

  it("keeps the panel open, so the user can see and fix what failed", async () => {
    await bootWith({ setupDone: true });
    await openSettings();
    setConfigFails = true;

    (document.getElementById("settingsSave") as HTMLButtonElement).click();
    await settle(60);

    expect((document.getElementById("app") as HTMLElement).dataset.view, "the panel closed over a failed save").toBe(
      "settings",
    );
  });

  it("still says saved, and closes, when the save worked", async () => {
    await bootWith({ setupDone: true });
    await openSettings();

    (document.getElementById("settingsSave") as HTMLButtonElement).click();
    await settle(60);

    expect(logText()).toContain("settings saved");
    expect((document.getElementById("app") as HTMLElement).dataset.view).toBe("stage");
  });

  it("refuses a port the relay could never bind, before anything is written", async () => {
    await bootWith({ setupDone: true });
    await openSettings();
    const port = document.getElementById("relayPort") as HTMLInputElement;
    port.value = "70000";

    (document.getElementById("settingsSave") as HTMLButtonElement).click();
    await settle(60);

    expect(calls.setConfig.some((p) => "relayPort" in p), "an unbindable port was persisted").toBe(false);
    expect(logText().toLowerCase()).toContain("port");
  });
});

describe("a key check that lands after setup has closed", () => {
  /**
   * Audit finding 30. `obCheckDeepgram` ends with a bare `renderOnboarding()`,
   * while its Gemini sibling ends with `renderObKeyStatus()`. The check is
   * debounced 500 ms and then awaits a network round trip, and `renderOnboarding`
   * has no view guard - it calls `renderOnboardingChain`, which greys every
   * block, hides the selects and the level meter, and hides the translate
   * toggle, regardless of which view is actually on screen.
   *
   * So: paste a key, close setup, and half a second later the live console
   * repaints itself as a setup placeholder. Nothing recovers it until the next
   * thing that calls renderChain.
   */
  it("does not repaint the console as a setup placeholder", async () => {
    await bootWith({ setupDone: true, deepgramApiKey: "" });
    (document.getElementById("settingsSetup") as HTMLButtonElement).click();
    await settle(40);

    const field = document.getElementById("obDeepgramKey") as HTMLInputElement;
    field.value = "dg-a-real-key";
    field.dispatchEvent(new Event("input"));

    // the user gives up on setup while the check is still debounced
    (document.getElementById("obClose") as HTMLButtonElement).click();
    await settle(40);
    expect((document.getElementById("app") as HTMLElement).dataset.view).toBe("stage");

    // ...and the verdict lands afterwards
    await settle(900);

    expect((document.getElementById("app") as HTMLElement).dataset.view).toBe("stage");
    expect(
      document.getElementById("blkStt")?.classList.contains("placeholder"),
      "the live console was repainted as a setup placeholder",
    ).toBe(false);
    expect(
      (document.getElementById("translateToggle") as HTMLElement).hidden,
      "the translate toggle was hidden by a repaint that belonged to setup",
    ).toBe(false);
  });

  it("still repaints setup when setup is what is on screen", async () => {
    await bootWith({ setupDone: true, deepgramApiKey: "" });
    (document.getElementById("settingsSetup") as HTMLButtonElement).click();
    await settle(40);

    const field = document.getElementById("obDeepgramKey") as HTMLInputElement;
    field.value = "dg-a-real-key";
    field.dispatchEvent(new Event("input"));
    await settle(900);

    // the verdict has to reach the panel the user is looking at
    expect((document.getElementById("app") as HTMLElement).dataset.view).toBe("onboarding");
    expect((document.getElementById("obContinue1") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the idle panel over a stage that still has captions on it", () => {
  /**
   * Audit finding 32. `#idle` is absolutely positioned and has no background,
   * and `renderIdle` unhides it whenever the state is error - while
   * `startSession` throws its pre-flight errors BEFORE `clearStage()`. Clear the
   * Deepgram key and SAVE while live: the restart's throw leaves a dozen caption
   * rows on the stage and draws "Could not start" plus the amber error string
   * straight over them, which makes the error itself unreadable.
   *
   * The transcript is worth keeping - it is what was said - so the panel gets a
   * background rather than the stage being wiped.
   *
   * What is asserted here is the CONDITION: the panel knows when there is
   * something behind it. Reaching the error state from happy-dom means going
   * through startSession, which fails there for reasons of its own that have
   * nothing to do with this, so that would be a test of the harness. The
   * overlay was checked in a browser, in a real error state.
   */
  const stageRow = (): void => {
    const row = document.createElement("div");
    row.className = "row";
    row.textContent = "enemy down mid";
    document.getElementById("lines")?.appendChild(row);
  };
  /** any render path that reaches renderIdle; RESCAN is the reachable one */
  const rerender = async (): Promise<void> => {
    (document.getElementById("rescan") as HTMLButtonElement).click();
    await settle(60);
  };

  it("marks itself as covering something when captions are underneath", async () => {
    await bootWith({ setupDone: true });
    stageRow();
    await rerender();

    expect(
      (document.getElementById("idle") as HTMLElement).classList.contains("over-lines"),
      "the panel would paint over the transcript with nothing behind it",
    ).toBe(true);
  });

  it("stays plain when there is nothing behind it", async () => {
    await bootWith({ setupDone: true });
    await rerender();

    const idle = document.getElementById("idle") as HTMLElement;
    expect(idle.hidden).toBe(false);
    expect(idle.classList.contains("over-lines"), "the ordinary idle state grew a panel background").toBe(false);
  });

  it("keeps the captions rather than wiping them to make room", async () => {
    await bootWith({ setupDone: true });
    stageRow();
    await rerender();

    expect(document.querySelectorAll("#lines .row").length, "the transcript was thrown away").toBe(1);
  });
});

/**
 * Getting a link someone outside the network can open used to mean finding
 * `POST /claim` in a README, running curl, and pasting a token into a panel
 * called ADVANCED whose own hint says none of it is needed. Nothing in the app
 * called /claim at all.
 *
 * That is the whole reason the hosted relay exists: sending a link to someone
 * reading captions on a phone - a friend who is deaf or hard of hearing, or
 * anyone not in the room. It should be one button.
 */
describe("getting a link that works outside this network", () => {
  const reach = (): HTMLElement => document.getElementById("reachStatus") as HTMLElement;
  const claimBtn = (): HTMLButtonElement => document.getElementById("claimRoom") as HTMLButtonElement;
  const note = (): HTMLElement => document.getElementById("claimNote") as HTMLElement;

  it("says plainly that the link is local-only until something is done about it", async () => {
    await bootWith({ setupDone: true });

    expect(reach().textContent, "a fresh install claims a reach it does not have").toMatch(/THIS NETWORK/i);
    expect(reach().className, "the local-only state is not flagged as needing attention").toContain("warn");
    expect(claimBtn().hidden, "there is no way to fix it from here").toBe(false);
  });

  it("claims a room on one press, with no address to type", async () => {
    await bootWith({ setupDone: true });
    claimBtn().click();
    await settle(80);

    // undefined means the app's own default relay - the user is never asked
    // to know an address, which was the entire barrier
    expect(calls.claimed, "the button did not claim anything").toEqual([undefined]);
    expect(reach().textContent, "the room was claimed but the app still says local-only").toMatch(/ANYONE WITH THE LINK/i);
    expect(reach().className).not.toContain("warn");
  });

  it("puts the room it claimed where the relay settings live, so it is one thing not two", async () => {
    await bootWith({ setupDone: true });
    claimBtn().click();
    await settle(80);

    // the same fields a user would have filled in by hand; a claim that left
    // ADVANCED empty would be a second, hidden source of truth
    expect((document.getElementById("relayUrl") as HTMLInputElement).value).toBe(HOSTED_RELAY_URL);
    expect((document.getElementById("publisherToken") as HTMLInputElement).value).toBe("p1_room_secret");
  });

  it("tells the user why when it fails, instead of a button that does nothing", async () => {
    claimFails = "could not reach relay.supr.systems - getaddrinfo ENOTFOUND";
    await bootWith({ setupDone: true });
    claimBtn().click();
    await settle(80);

    expect(note().textContent, "the failure was swallowed").toContain("could not reach");
    expect(reach().textContent, "a failed claim was reported as success").toMatch(/THIS NETWORK/i);
    expect(claimBtn().disabled, "the button is stuck after a failure").toBe(false);
  });

  it("stops telling the user their link is local-only once it is not", async () => {
    await bootWith({ setupDone: true });
    const hint = document.getElementById("reachHint") as HTMLElement;
    expect(hint.textContent).toMatch(/only opens on your own network/i);

    claimBtn().click();
    await settle(80);

    // a hint left saying the opposite of the status reads as "it did not work"
    expect(hint.textContent, "the hint still contradicts the status it sits under").not.toMatch(
      /only opens on your own network/i,
    );
    expect(hint.textContent).toMatch(/any network|anyone you send/i);
  });

  it("does not offer to claim a second room when one is already set up", async () => {
    await bootWith({ setupDone: true, relayUrl: "wss://relay.supr.systems", publisherToken: "p1_already_here" });

    expect(reach().textContent).toMatch(/ANYONE WITH THE LINK/i);
    expect(claimBtn().hidden, "an extra room would be claimed and the old one orphaned").toBe(true);
  });
});

/**
 * The viewer link is the whole auth model: `packages/relay/src/server.ts`
 * refuses any token that is not the viewer token, and there is no second
 * factor, no expiry and no IP binding. Anyone who reads the link watches the
 * captions - which are a live transcript of whatever the microphone hears.
 *
 * It was printed in full in the footer for the entire session. `stripUrl`
 * removed `https://` and nothing else, and the same URL went into the element's
 * `title`, so it leaked on hover too. One paused frame of a screen share, one
 * clip, one person looking over a shoulder.
 *
 * The control API one file over has masked this since audit finding 3
 * (`maskViewerLink`). The window the user actually looks at did not.
 *
 * Masked by default, revealed on a click, and re-masked when the link changes -
 * the sticky SHOW button on the key fields is the mistake not to repeat.
 */
describe("the viewer link on screen", () => {
  const TOKEN = "7f3a1c9e5b2d4088";
  const linkEl = (): HTMLElement => document.getElementById("linkUrl") as HTMLElement;

  async function withLink(): Promise<void> {
    await bootWith({ setupDone: true, linkMode: "fixed" });
    pushStatus!({
      companion: { version: "test" },
      session: { state: "idle" },
      relay: { localViewerUrl: `http://127.0.0.1:8787/watch/${TOKEN}?obs=1`, remoteViewerUrl: "", uplinkState: "off" },
      usage: undefined,
    });
    await settle(40);
  }

  it("does not print the token that lets anyone watch", async () => {
    await withLink();

    expect(linkEl().textContent, "the link is blank - the point is to show it, masked").toBeTruthy();
    expect(linkEl().textContent, "the viewer token is on screen in full").not.toContain(TOKEN);
    expect(linkEl().textContent, "the host is masked too, which leaves nothing to recognise").toContain("127.0.0.1:8787");
  });

  it("does not leak it on hover either", async () => {
    await withLink();
    expect(linkEl().title, "the full link is in the title attribute").not.toContain(TOKEN);
  });

  it("shows it when the user asks, because they do need to read it sometimes", async () => {
    await withLink();
    linkEl().click();
    await settle(20);

    expect(linkEl().textContent, "clicking it revealed nothing").toContain(TOKEN);
  });

  it("hides it again on a second click", async () => {
    await withLink();
    linkEl().click();
    await settle(20);
    linkEl().click();
    await settle(20);

    expect(linkEl().textContent).not.toContain(TOKEN);
  });

  it("goes back to hidden when the link is replaced", async () => {
    await withLink();
    linkEl().click();
    await settle(20);
    expect(linkEl().textContent).toContain(TOKEN);

    // NEW, or a session start in the default link mode: a fresh token must not
    // inherit the last one's revealed state
    const next = "0000deadbeef1111";
    pushStatus!({
      companion: { version: "test" },
      session: { state: "idle" },
      relay: { localViewerUrl: `http://127.0.0.1:8787/watch/${next}?obs=1`, remoteViewerUrl: "", uplinkState: "off" },
      usage: undefined,
    });
    await settle(40);

    expect(linkEl().textContent, "a new link arrived already revealed").not.toContain(next);
  });

  it("still copies and opens the real link while it is masked", async () => {
    await withLink();
    (document.getElementById("copyLink") as HTMLButtonElement).click();
    await settle(20);

    // masking is a display decision; the buttons read the link itself
    expect(calls.clipboard.join(" "), "masking broke COPY, which is what the link is for").toContain(TOKEN);
  });
});

/**
 * Setup is the one screen every user sees, and it was still sending them to a
 * panel called KEYS - renamed to SETTINGS two releases ago - and telling them to
 * "SET A RELAY URL" for an internet link. That is the developer path, buried in
 * ADVANCED, and it is no longer the answer: there is a button that claims an
 * address in one press.
 *
 * So the single most important setup step was the one setup never mentioned,
 * and the text pointed the other way.
 */
describe("what setup tells you about reaching a phone", () => {
  const outputMeta = (): HTMLElement => document.getElementById("obOutputMeta") as HTMLElement;

  it("names a panel that exists", async () => {
    await bootWith({ setupDone: false });
    const text = document.body.textContent || "";
    expect(text, "setup still sends people to KEYS, which was renamed to SETTINGS").not.toMatch(/\bKEYS\b/);
  });

  it("points at the button that gets you an address, not at the relay fields", async () => {
    await bootWith({ setupDone: false });
    // step 3 is where output is chosen; drive setup to it
    (document.getElementById("obContinue1") as HTMLButtonElement).click();
    await settle(40);
    (document.getElementById("obSkip2") as HTMLButtonElement).click();
    await settle(60);

    const meta = outputMeta().textContent || "";
    expect(meta, "setup says nothing about reach at all").toBeTruthy();
    expect(meta, "setup still tells a first-run user to set a relay URL by hand").not.toMatch(/RELAY URL/i);
    expect(meta, "setup does not name the thing that actually fixes this").toMatch(/SETTINGS/i);
  });

  it("says nothing about it when a relay is already set up", async () => {
    await bootWith({ setupDone: false, relayUrl: "wss://relay.supr.systems", publisherToken: "p1_x_y" });
    (document.getElementById("obContinue1") as HTMLButtonElement).click();
    await settle(40);
    (document.getElementById("obSkip2") as HTMLButtonElement).click();
    await settle(60);

    expect(outputMeta().className, "someone who already has an address is warned anyway").not.toContain("warn");
  });
});

/**
 * Two things the app knew and did not act on.
 *
 * The app's own relay allows exactly ONE viewer per link - a second device
 * kicks the first - and nothing said so anywhere until it happened. The way
 * people find out is two people disconnecting each other in turn, or a phone
 * fighting an OBS overlay, neither of which suggests a rule.
 *
 * And NEW sits between COPY and OPEN in the footer, one press, no confirming.
 * It disconnects everyone reading, immediately, and the only notice is a log
 * line afterwards. The person who most wants to press COPY is the person most
 * likely to hit the button beside it.
 */
describe("warning about the one-viewer limit before it bites", () => {
  const outputMeta = (): string => (document.getElementById("metaOutput") as HTMLElement).textContent || "";

  const goLive = async (relay: { viewers?: number; remoteViewers?: number; remoteViewerUrl?: string }): Promise<void> => {
    pushStatus!({
      companion: { version: "test" },
      session: { state: "live" },
      relay: {
        localViewerUrl: "http://127.0.0.1:8787/watch/tok?obs=1",
        remoteViewerUrl: relay.remoteViewerUrl ?? "",
        uplinkState: relay.remoteViewerUrl ? "connected" : "off",
        viewers: relay.viewers ?? 0,
        remoteViewers: relay.remoteViewers ?? 0,
      },
      usage: undefined,
    });
    await settle(50);
  };

  it("says only one device can watch, while the link is local-only and live", async () => {
    await bootWith({ setupDone: true });
    await goLive({ viewers: 1 });

    expect(outputMeta(), "nothing warns that a second phone will kick the first").toMatch(/one device/i);
  });

  it("does not say it once an address makes the limit untrue", async () => {
    await bootWith({ setupDone: true, relayUrl: "wss://relay.supr.systems", publisherToken: "p1_a_b" });
    await goLive({ remoteViewerUrl: "https://relay.supr.systems/watch/v1_a_b", remoteViewers: 3 });

    // the hosted relay broadcasts to everyone; repeating the limit there would
    // be telling the user something false
    expect(outputMeta(), "the limit is claimed on a relay that does not have it").not.toMatch(/one device/i);
  });
});

describe("NEW, which disconnects everyone reading", () => {
  const newBtn = (): HTMLButtonElement => document.getElementById("rotateLink") as HTMLButtonElement;

  const liveWith = async (viewers: number): Promise<void> => {
    pushStatus!({
      companion: { version: "test" },
      session: { state: "live" },
      relay: {
        localViewerUrl: "http://127.0.0.1:8787/watch/tok?obs=1",
        remoteViewerUrl: "",
        uplinkState: "off",
        viewers,
        remoteViewers: 0,
      },
      usage: undefined,
    });
    await settle(50);
  };

  it("asks first when someone is actually reading", async () => {
    await bootWith({ setupDone: true });
    await liveWith(2);

    newBtn().click();
    await settle(40);

    expect(calls.rotated, "the link was rotated on one press, with people on it").toHaveLength(0);
    expect(newBtn().textContent, "nothing on the button says it is now asking").not.toMatch(/^NEW$/i);
  });

  it("goes through on the second press", async () => {
    await bootWith({ setupDone: true });
    await liveWith(2);

    newBtn().click();
    await settle(40);
    newBtn().click();
    await settle(40);

    expect(calls.rotated, "confirming did not rotate the link").toHaveLength(1);
    expect(newBtn().textContent, "the button stayed armed after it fired").toMatch(/^NEW$/i);
  });

  it("does not ask when there is nobody to disconnect", async () => {
    await bootWith({ setupDone: true });
    await liveWith(0);

    newBtn().click();
    await settle(40);

    // confirming costs a press for nothing when the link is unused
    expect(calls.rotated, "asked to confirm disconnecting nobody").toHaveLength(1);
  });
});

/**
 * Every secret field is `type="password"` in the markup, and the SHOW button
 * flips it to `text`. That flip was the ONLY assignment to `.type` in the whole
 * renderer - nothing put it back. Not closing the panel, not saving, not
 * reopening it.
 *
 * So: reveal a Deepgram key once to check a paste, carry on, and an hour later
 * open SETTINGS to change a language - with the key in plain text, on whatever
 * is being screen-shared. The button reads HIDE, which is the only clue, and it
 * is in the corner of a field nobody is looking at.
 *
 * The viewer link learned this a few commits ago and re-masks itself. These
 * fields are worth more than the link.
 */
describe("a revealed key does not stay revealed", () => {
  const field = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  const showBtn = (id: string): HTMLButtonElement =>
    document.querySelector(`[data-show="${id}"]`) as HTMLButtonElement;

  const openSettings = async (): Promise<void> => {
    (document.getElementById("settingsBtn") as HTMLButtonElement).click();
    await settle(40);
  };

  it("starts hidden, with the button offering to show it", async () => {
    await bootWith({ setupDone: true, deepgramApiKey: "dg-live-secret" });
    await openSettings();

    expect(field("deepgramApiKey").type).toBe("password");
    expect(showBtn("deepgramApiKey").textContent).toMatch(/SHOW/i);
  });

  it("shows it when asked", async () => {
    await bootWith({ setupDone: true, deepgramApiKey: "dg-live-secret" });
    await openSettings();
    showBtn("deepgramApiKey").click();
    await settle(20);

    expect(field("deepgramApiKey").type).toBe("text");
    expect(showBtn("deepgramApiKey").textContent).toMatch(/HIDE/i);
  });

  it("hides it again the next time the panel is opened", async () => {
    await bootWith({ setupDone: true, deepgramApiKey: "dg-live-secret" });
    await openSettings();
    showBtn("deepgramApiKey").click();
    await settle(20);
    expect(field("deepgramApiKey").type).toBe("text");

    // leave, come back - which is the shape of the accident: revealed an hour
    // ago, panel reopened on camera to change something unrelated
    (document.getElementById("settingsBack") as HTMLButtonElement).click();
    await settle(20);
    await openSettings();

    expect(field("deepgramApiKey").type, "the key was still in plain text on reopening").toBe("password");
    expect(showBtn("deepgramApiKey").textContent, "the button still claims it is showing").toMatch(/SHOW/i);
  });

  it("does it for every secret on the panel, not just the one that was reported", async () => {
    await bootWith({
      setupDone: true,
      deepgramApiKey: "dg-live-secret",
      geminiApiKey: "gm-live-secret",
      publisherToken: "p1_live_secret",
    });
    await openSettings();
    for (const id of ["deepgramApiKey", "geminiApiKey", "publisherToken"]) showBtn(id).click();
    await settle(20);

    (document.getElementById("settingsBack") as HTMLButtonElement).click();
    await settle(20);
    await openSettings();

    for (const id of ["deepgramApiKey", "geminiApiKey", "publisherToken"]) {
      expect(field(id).type, `${id} was left in plain text`).toBe("password");
    }
  });
});

/**
 * A room on the hosted relay can now be removed - only one nobody ever touched,
 * but it can happen. When it does, the relay answers the uplink with 4401, and
 * `uplinkClient` treats that as final and stops, correctly: it means the token
 * is not accepted, and retrying cannot change that.
 *
 * The app then had no way out. `renderReach` hides the claim button whenever
 * config carries a relay URL and a token - which it still does, because a
 * deleted room leaves the config untouched - and prints ANYONE WITH THE LINK,
 * which is now false. The only escape was knowing to open ADVANCED and clear
 * the publish token by hand.
 *
 * A rejected token is exactly when the button is worth offering.
 */
describe("recovering when the relay stops accepting the stored room", () => {
  const claimBtn = (): HTMLButtonElement => document.getElementById("claimRoom") as HTMLButtonElement;
  const reach = (): HTMLElement => document.getElementById("reachStatus") as HTMLElement;

  const withUplink = async (state: string): Promise<void> => {
    pushStatus!({
      companion: { version: "test" },
      session: { state: "idle" },
      relay: { localViewerUrl: "http://127.0.0.1:8787/watch/tok?obs=1", remoteViewerUrl: "", uplinkState: state },
      usage: undefined,
    });
    await settle(50);
  };

  it("offers the button again when the stored token is refused", async () => {
    await bootWith({ setupDone: true, relayUrl: "wss://textrelay.cc", publisherToken: "p1_gone_away" });
    await withUplink("error");

    expect(claimBtn().hidden, "the only way back is hidden, so the app is a dead end").toBe(false);
    expect(reach().textContent, "the app still claims the link works").not.toMatch(/ANYONE WITH THE LINK/i);
  });

  it("keeps it hidden while the relay is working", async () => {
    await bootWith({ setupDone: true, relayUrl: "wss://textrelay.cc", publisherToken: "p1_fine" });
    await withUplink("connected");

    // offering to claim a second room while the first works would orphan a link
    expect(claimBtn().hidden, "a working relay is being told to claim another room").toBe(true);
    expect(reach().textContent).toMatch(/ANYONE WITH THE LINK/i);
  });
});

/**
 * When a model download fails the store records why - `models.ts` logs
 * "model download failed: <id> - <message>" and puts the message on the status
 * it hands back. The chain strip replaced all of it with the constant
 * `DOWNLOAD FAILED`.
 *
 * So the one fact worth having never reached the person who needed it. B6 -
 * archive downloads failing in the app - has been open and unreproducible for
 * days, and this is part of why: a user hits it, sees three words, and has
 * nothing to report.
 */
describe("when a model download fails", () => {
  const strip = (): string => (document.getElementById("metaStt") as HTMLElement).textContent || "";

  const failWith = async (error: string): Promise<void> => {
    pushStatus!({
      companion: { version: "test" },
      session: { state: "idle" },
      relay: { localViewerUrl: "", remoteViewerUrl: "", uplinkState: "off" },
      localModels: [{ id: "local-whisper-turbo", downloaded: false, sizeMb: 564, error }],
      usage: undefined,
    });
    await settle(50);
  };

  it("says what went wrong, not just that something did", async () => {
    await bootWith({ setupDone: true, stt: "local-whisper-turbo" });
    await failWith("Error in bzip2: crc32 do not match");

    expect(strip(), "the strip still says only DOWNLOAD FAILED").toMatch(/crc32/i);
  });

  it("still says it failed, so the reason does not replace the state", async () => {
    await bootWith({ setupDone: true, stt: "local-whisper-turbo" });
    await failWith("the download stopped early: 2752512 of 6324614 bytes");

    expect(strip()).toMatch(/FAILED/i);
    expect(strip()).toMatch(/2752512/);
  });
});

describe("settings keeps a subject in one place", () => {
  /**
   * The panel was organised by how technical a setting is rather than by what
   * it answers, and that split single subjects across both columns.
   *
   * Reaching viewers was activated bottom-left under WHO CAN OPEN IT (y=1105,
   * below the fold) and configured mid-right inside a collapsed ADVANCED, with
   * two readouts for one fact: THIS NETWORK ONLY and NOT SET. Updates was split
   * the same way - the controls on the left, the feed URL on the right. And
   * LOCAL PORT, which is the relay this app runs itself, shared a box with
   * RELAY URL, which is somebody else's. That last pairing is the confusion
   * CLAUDE.md opens by calling the single biggest source of wasted time here.
   *
   * `data-group` says which question a field answers. It is in the markup
   * rather than inferred from columns so that moving a column cannot quietly
   * re-split a subject.
   */
  const doc = new DOMParser().parseFromString(html, "text/html");
  const settings = doc.getElementById("settings") as HTMLElement;
  /** null when the field sits in no group at all, which is itself a failure */
  const groupOf = (id: string): string | null =>
    settings.querySelector(`#${id}`)?.closest("[data-group]")?.getAttribute("data-group") ?? null;

  it("keeps every control for reaching viewers together", () => {
    const ids = ["reachStatus", "claimRoom", "relayUrl", "publisherToken", "publicBaseUrl"];
    const where = ids.map((id) => `${id}=${groupOf(id) ?? "(none)"}`);
    expect(ids.filter((id) => groupOf(id) === null), `ungrouped: ${where.join("  ")}`).toEqual([]);
    expect(new Set(ids.map(groupOf)).size, `spread across: ${where.join("  ")}`).toBe(1);
  });

  it("says how far the link reaches exactly once", () => {
    expect(settings.querySelectorAll("[data-reach-status]")).toHaveLength(1);
  });

  it("does not shelve the relay this app runs beside somebody else's", () => {
    // both must be grouped for the comparison to mean anything - two ungrouped
    // fields are not "in different groups", they are the old panel
    const port = groupOf("relayPort");
    const url = groupOf("relayUrl");
    expect(port, "relayPort is in no group").not.toBeNull();
    expect(url, "relayUrl is in no group").not.toBeNull();
    expect(port, "the embedded relay is boxed with the uplink again").not.toBe(url);
  });

  it("keeps the update controls and the feed they read together", () => {
    const feed = groupOf("updateFeedUrl");
    expect(feed, "updateFeedUrl is in no group").not.toBeNull();
    expect(feed).toBe(groupOf("checkUpdate"));
  });
});

describe("settings leads with the question people came to answer", () => {
  /**
   * Grouping put every reach control together, but the left column is 1309px of
   * content in a 700px window and WHAT VIEWERS SEE alone is 705px of it - so the
   * claim button sat below the fold at y=1142, deeper than the y=1105 it was at
   * before the regroup. Reaching viewers is what people open settings for;
   * captions and speaker names are set once. So it leads the column.
   */
  const doc = new DOMParser().parseFromString(html, "text/html");
  const groups = [...doc.querySelectorAll("#settings .keys-col:first-child [data-group]")].map(
    (g) => g.getAttribute("data-group"),
  );

  it("puts reaching viewers above the settings people change once", () => {
    expect(groups.slice(0, 2)).toEqual(["reach", "viewers"]);
  });
});

describe("setting what viewers are told the stream is called", () => {
  const doc = () => new DOMParser().parseFromString(html, "text/html");

  it("lives with the other things viewers see", () => {
    // renderer.test.ts already fails if a subject is split across groups; this
    // is what viewers see, so it belongs with captions and speaker names
    const settings = doc().getElementById("settings") as HTMLElement;
    const group = (id: string) =>
      settings.querySelector(`#${id}`)?.closest("[data-group]")?.getAttribute("data-group") ?? null;
    expect(group("brandNameInput")).toBe("viewers");
    expect(group("brandColorInput")).toBe("viewers");
  });

  it("locks while live, because the hello is sent once", async () => {
    // the brand rides the publisher hello, which relayClient sends on open and
    // never again - so editing it mid-session would change nothing and say so
    // nowhere. Same reason the speaker-name fields disable.
    //
    // Driven through the real START button, not a pushed status payload:
    // startSession()'s second statement is setState("starting"), synchronous
    // and before its first await, so the lock is observable immediately with
    // no settle(). status.session.state is not an independent signal - it is
    // this same renderer's own session report, echoed back by the main
    // process - so it cannot be what proves the lock.
    await bootWith({ setupDone: true, brandName: "Omer's stream" });
    (document.getElementById("startStop") as HTMLButtonElement).click();

    expect((document.getElementById("brandNameInput") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("brandColorInput") as HTMLInputElement).disabled).toBe(true);
  });

  it("shows the configured name, and clears it by sending an explicit empty string, not undefined", async () => {
    // ConfigStore.merge (packages/companion/src/config.ts) skips undefined and
    // null - a regression to `|| undefined` in the onchange handler would be
    // silently swallowed there and the brand would never actually clear.
    await bootWith({ setupDone: true, brandName: "Omer's stream" });
    const field = document.getElementById("brandNameInput") as HTMLInputElement;
    expect(field.value, "the populate path from config was never asserted before this test").toBe(
      "Omer's stream",
    );

    field.value = "";
    field.dispatchEvent(new Event("change"));
    await settle(40);

    expect(calls.setConfig).toContainEqual({ brandName: "" });
  });
});

/**
 * The topbar during a dead speech pipeline.
 *
 * recomputeState() (app.ts) derives "live" from relayClient's socket state
 * and capture.capturing - a loopback WebSocket that never dropped and a
 * microphone that is still running. Neither observes STT, so the topbar kept
 * reading ON AIR with a running clock straight through an outage that had
 * already ended captions, while the relay's own isLive() (packages/relay/src/
 * server.ts) went false and told every viewer "speech pipeline lost". Only
 * the streamer's own app lied.
 *
 * Reaching a genuinely live session needs the same three things
 * BrowserAudioCapture.start() needs - an AudioContext, an AudioWorklet and a
 * real getUserMedia - and packages/companion/test/capture.test.ts already
 * says standing all three up would mean testing a reimplementation. So only
 * the two boundary classes are stood in for here: the hardware
 * (BrowserAudioCapture) and the network (RelayPublisherClient). Everything
 * between them - startSession, recomputeState, setState, renderTopbar - runs
 * for real, through a real click on START.
 */
describe("the topbar during a dead speech pipeline", () => {
  const statusText = (): string => (document.getElementById("statusText") as HTMLElement).textContent || "";

  const goLive = async (): Promise<void> => {
    await bootWith({ setupDone: true, deepgramApiKey: "dg-key" });
    // same module instance app.ts's own `import` resolved to: bootWith's
    // vi.resetModules() + dynamic import of app.ts already happened above,
    // and nothing has reset the module graph since
    const companion = (await import("@callout-relay/companion")) as unknown as {
      RelayPublisherClient: { prototype: { connect: (...args: unknown[]) => void } };
      BrowserAudioCapture: { prototype: Record<string, unknown> };
    };
    // network edge: skip the real socket handshake, go straight to connected
    companion.RelayPublisherClient.prototype.connect = function (this: {
      state: string;
      hooks: { onState?: (s: string) => void };
    }) {
      this.state = "connected";
      this.hooks.onState?.("connected");
    };
    // hardware edge: skip getUserMedia / AudioContext / AudioWorklet entirely
    companion.BrowserAudioCapture.prototype.start = async () => true;
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "capturing", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "channels", {
      configurable: true,
      get: () => 1,
    });

    (document.getElementById("startStop") as HTMLButtonElement).click();
    await waitFor(() => document.getElementById("app")?.dataset.session === "live", "the session to go live");
  };

  it("sanity: a live session with nothing pushed about STT still reads ON AIR", async () => {
    await goLive();
    expect(statusText()).toBe("ON AIR");
  });

  it("stops reading ON AIR once the speech pipeline is reported dead", async () => {
    await goLive();

    pushStatus!({
      companion: { version: "test" },
      session: { state: "live" },
      relay: {
        localViewerUrl: "http://127.0.0.1:8787/watch/tok?obs=1",
        remoteViewerUrl: "",
        uplinkState: "off",
        sttLive: false,
      },
      usage: undefined,
    });
    await settle(40);

    expect(
      statusText(),
      "the topbar still claims ON AIR with the speech pipeline confirmed dead",
    ).toBe("ON AIR · NO SPEECH");
  });

  it("keeps reading ON AIR when sttLive is absent, the way a remote relay reports it", async () => {
    await goLive();

    // a remote relay does no STT of its own and never sends this field at
    // all - absent must never be read as dead, or every remote-relay user
    // sees a permanent false warning
    pushStatus!({
      companion: { version: "test" },
      session: { state: "live" },
      relay: {
        localViewerUrl: "http://127.0.0.1:8787/watch/tok?obs=1",
        remoteViewerUrl: "",
        uplinkState: "off",
      },
      usage: undefined,
    });
    await settle(40);

    expect(statusText(), "an absent sttLive must not read as dead").toBe("ON AIR");
  });
});

/**
 * A recogniser final with no words in it is not a caption. Deepgram sends one
 * every couple of seconds on a silent channel, deliberately: dispatchDeepgramMessage
 * (packages/relay/src/deepgram.ts) stopped swallowing them precisely because the
 * session reserves a segment id for a channel's interim and only releases it on a
 * final, so an utterance that came to nothing left a blinking half-caption that
 * trimRows - which excludes .interim - could never age out.
 *
 * Three consumers see that final. onPartial checks !seg.source.trim(), the viewer
 * page checks !msg.source && !msg.target AFTER retiring its interim, and 0.8.1
 * added the same check to the translator (session.ts) and the saved-transcript
 * writer (transcripts.ts). The streamer's own 04 OUTPUT stage checks nothing and
 * builds a full row - so a silence long enough evicts all twelve real captions
 * (MAX_ROWS) and leaves blank timestamped rows carrying a `...` that never
 * resolves, because 0.8.1 correctly stopped translating them. One measured
 * 94-minute session produced 3,105 wordless finals against 657 real ones.
 *
 * The guard has to sit where BOTH consumers hang off it - logSubtitle shares the
 * same 400-entry capped LOG buffer and floods identically - and it has to retire
 * the interim before it returns, or it re-opens on the desktop the exact bug the
 * empty final was introduced to fix on the viewer.
 */
describe("a recogniser final with no words in it", () => {
  type Seg = {
    id: number;
    source: string;
    target?: string;
    channel?: number;
    speaker?: string;
    latency?: { stt?: number; translate?: number };
  };
  let hooks: { onSubtitle?: (seg: Seg) => void; onPartial?: (seg: Seg) => void };

  const goLive = async (): Promise<void> => {
    await bootWith({ setupDone: true, deepgramApiKey: "dg-key" });
    const companion = (await import("@callout-relay/companion")) as unknown as {
      RelayPublisherClient: { prototype: { connect: (...args: unknown[]) => void } };
      BrowserAudioCapture: { prototype: Record<string, unknown> };
    };
    // the network edge, as the two topbar suites above stand it up - except
    // that this one keeps the hooks, because they are the wiring point under test
    companion.RelayPublisherClient.prototype.connect = function (this: {
      state: string;
      hooks: typeof hooks & { onState?: (s: string) => void };
    }) {
      hooks = this.hooks;
      this.state = "connected";
      this.hooks.onState?.("connected");
    };
    companion.BrowserAudioCapture.prototype.start = async () => true;
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "capturing", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "channels", {
      configurable: true,
      get: () => 1,
    });

    (document.getElementById("startStop") as HTMLButtonElement).click();
    await waitFor(() => document.getElementById("app")?.dataset.session === "live", "the session to go live");
  };

  const finals = (): number => document.querySelectorAll("#lines .row:not(.interim)").length;
  const openInterims = (): number => document.querySelectorAll("#lines .row.interim").length;
  const logCount = (): number => (document.getElementById("log") as HTMLElement).children.length;
  const stageText = (): string[] =>
    [...document.querySelectorAll("#lines .row:not(.interim) .src .text")].map((e) => e.textContent || "");

  it("puts no row on the stage", async () => {
    await goLive();
    for (let i = 0; i < 20; i++) hooks.onSubtitle!({ id: 100 + i, source: "", channel: 0 });
    await settle(40);

    expect(finals(), "a silent channel built a row on the caption stage").toBe(0);
  });

  it("writes no line into the log", async () => {
    await goLive();
    const before = logCount();
    for (let i = 0; i < 20; i++) hooks.onSubtitle!({ id: 200 + i, source: "   ", channel: 0 });
    await settle(40);

    expect(logCount() - before, "a silent channel flooded the capped LOG buffer").toBe(0);
  });

  it("does not evict the real captions already on the stage", async () => {
    await goLive();
    hooks.onSubtitle!({ id: 1, source: "rush B", channel: 0 });
    // MAX_ROWS is 12, so twenty of these clear the stage if they are rendered
    for (let i = 0; i < 20; i++) hooks.onSubtitle!({ id: 300 + i, source: "", channel: 0 });
    await settle(40);

    expect(stageText(), "silence pushed the only real caption off the stage").toEqual(["rush B"]);
  });

  it("still retires the open interim the empty final exists to release", async () => {
    await goLive();
    hooks.onPartial!({ id: 7, source: "rush", channel: 0 });
    await settle(20);
    expect(openInterims(), "the partial never opened an interim, so this proves nothing").toBe(1);

    hooks.onSubtitle!({ id: 7, source: "", channel: 0 });
    await settle(20);

    expect(openInterims(), "the half-caption was left blinking on the stage for the rest of the session").toBe(0);
    expect(finals(), "the wordless final left a blank row behind where the half-caption was").toBe(0);
  });

  it("leaves the channel able to open a fresh interim afterwards", async () => {
    await goLive();
    hooks.onPartial!({ id: 7, source: "rush", channel: 0 });
    await settle(20);
    hooks.onSubtitle!({ id: 7, source: "", channel: 0 });
    await settle(20);

    // removing the element without deleting the map entry leaves onPartial
    // repainting a node that is no longer in the document, and the next thing
    // said never reaches the stage at all - the two have to happen together
    hooks.onPartial!({ id: 8, source: "they", channel: 0 });
    await settle(20);
    hooks.onSubtitle!({ id: 8, source: "they pushed B", channel: 0 });
    await settle(20);

    expect(stageText(), "the next utterance after a retired interim never reached the stage").toEqual([
      "they pushed B",
    ]);
  });

  it("puts the idle panel back over the stage its last row just left", async () => {
    await goLive();
    const idle = (): boolean => (document.getElementById("idle") as HTMLElement).hidden;
    hooks.onPartial!({ id: 7, source: "rush", channel: 0 });
    await settle(20);
    expect(idle(), "the interim never covered the idle panel, so this proves nothing").toBe(true);

    hooks.onSubtitle!({ id: 7, source: "", channel: 0 });
    await settle(20);

    expect(idle(), "the stage went empty and nothing on screen said so").toBe(false);
  });

  it("keeps the latency average describing speech rather than silence", async () => {
    await goLive();
    hooks.onSubtitle!({ id: 1, source: "rush B", channel: 0, latency: { stt: 900 } });
    await settle(20);
    const spoken = (document.getElementById("srcAvg") as HTMLElement).textContent;
    expect(spoken, "no average was published for a real caption, so this proves nothing").not.toBe("");

    // recentStt is a twelve-sample window, so twelve silent finals fill it
    for (let i = 0; i < 12; i++) hooks.onSubtitle!({ id: 400 + i, source: "", channel: 0, latency: { stt: 10 } });
    await settle(20);

    expect(
      (document.getElementById("srcAvg") as HTMLElement).textContent,
      "the AVG STT badge is reporting how fast the engine transcribes silence",
    ).toBe(spoken);
  });

  it("still renders a final that does carry words", async () => {
    await goLive();
    hooks.onPartial!({ id: 9, source: "rush", channel: 0 });
    await settle(20);
    hooks.onSubtitle!({ id: 9, source: "rush B now", channel: 0, speaker: "YOU" });
    await settle(20);

    expect(openInterims(), "the interim was not promoted to a final").toBe(0);
    expect(stageText(), "a real caption stopped reaching the stage").toEqual(["rush B now"]);
  });

  it("still retires an interim on a channel of its own, leaving the others alone", async () => {
    await goLive();
    hooks.onPartial!({ id: 10, source: "rush", channel: 0 });
    hooks.onPartial!({ id: 20, source: "on my way", channel: 1 });
    await settle(20);
    expect(openInterims(), "two channels did not open two interims").toBe(2);

    hooks.onSubtitle!({ id: 20, source: "", channel: 1 });
    await settle(20);

    expect(openInterims(), "a wordless final on one channel retired another channel's interim").toBe(1);
  });

  /**
   * The stage puts two languages side by side and said which was which
   * nowhere. index.html is `lang="en"`, so a screen reader announced the
   * TRANSLATION column in English - WCAG 3.1.2, and the column headers do not
   * help, because they are English words naming a language rather than text in
   * it. The viewer page had the same gap and is fixed alongside this.
   */
  it("says which language each half of a row is in", async () => {
    await goLive();
    hooks.onSubtitle!({ id: 1, source: "rush B", target: "lao B", channel: 0 });
    await settle(20);

    const row = document.querySelector("#lines .row");
    expect(row?.querySelector(".src")?.getAttribute("lang")).toBe("en");
    expect(row?.querySelector(".tgt")?.getAttribute("lang")).toBe("vi");
  });

  it("marks a translation that lands after its line", async () => {
    // the relay sends the source, then the same id again carrying the target
    await goLive();
    hooks.onSubtitle!({ id: 1, source: "rush B", channel: 0 });
    await settle(20);
    hooks.onSubtitle!({ id: 1, source: "rush B", target: "lao B", channel: 0 });
    await settle(20);

    expect(document.querySelector("#lines .row .tgt")?.getAttribute("lang")).toBe("vi");
  });
});

/**
 * Fix-round-3 Finding 4. Spec section C: the idle-billing pause has to
 * "surface the reason in the app", not only write to relay.log - a screen
 * the spec itself calls out the user is not on. Before this, a paused
 * session read plain ON AIR with nothing anywhere in the UI. Same shape as
 * the sttLive/NO SPEECH pair just above: a sibling flag that travels
 * relay -> ControlStatus.relay -> main.ts -> topbar, and an absent value
 * that must read exactly like today.
 */
describe("the topbar during a paused idle-billing session", () => {
  const statusText = (): string => (document.getElementById("statusText") as HTMLElement).textContent || "";

  const goLive = async (): Promise<void> => {
    await bootWith({ setupDone: true, deepgramApiKey: "dg-key" });
    const companion = (await import("@callout-relay/companion")) as unknown as {
      RelayPublisherClient: { prototype: { connect: (...args: unknown[]) => void } };
      BrowserAudioCapture: { prototype: Record<string, unknown> };
    };
    companion.RelayPublisherClient.prototype.connect = function (this: {
      state: string;
      hooks: { onState?: (s: string) => void };
    }) {
      this.state = "connected";
      this.hooks.onState?.("connected");
    };
    companion.BrowserAudioCapture.prototype.start = async () => true;
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "capturing", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "channels", {
      configurable: true,
      get: () => 1,
    });

    (document.getElementById("startStop") as HTMLButtonElement).click();
    await waitFor(() => document.getElementById("app")?.dataset.session === "live", "the session to go live");
  };

  it("stops reading plain ON AIR once billing is reported paused", async () => {
    await goLive();

    pushStatus!({
      companion: { version: "test" },
      session: { state: "live" },
      relay: {
        localViewerUrl: "http://127.0.0.1:8787/watch/tok?obs=1",
        remoteViewerUrl: "",
        uplinkState: "off",
        billingPaused: true,
      },
      usage: undefined,
    });
    await settle(40);

    expect(
      statusText(),
      "the topbar still claims plain ON AIR while billing is paused for silence",
    ).not.toBe("ON AIR");
  });

  it("keeps reading ON AIR when billingPaused is absent, the way a remote relay or the startup window reports it", async () => {
    await goLive();

    // no embedded relay yet (startup/restart), or a remote relay that never
    // sends this field at all - absent must never read as paused
    pushStatus!({
      companion: { version: "test" },
      session: { state: "live" },
      relay: {
        localViewerUrl: "http://127.0.0.1:8787/watch/tok?obs=1",
        remoteViewerUrl: "",
        uplinkState: "off",
      },
      usage: undefined,
    });
    await settle(40);

    expect(statusText(), "an absent billingPaused must not read as paused").toBe("ON AIR");
  });

  it("keeps reading NO SPEECH, not the pause text, when both are reported at once", async () => {
    // sttLive: false means the pipeline itself is down for an unrelated
    // reason (network) - a technical failure that outranks a benign,
    // self-recovering idle pause
    await goLive();

    pushStatus!({
      companion: { version: "test" },
      session: { state: "live" },
      relay: {
        localViewerUrl: "http://127.0.0.1:8787/watch/tok?obs=1",
        remoteViewerUrl: "",
        uplinkState: "off",
        sttLive: false,
        billingPaused: true,
      },
      usage: undefined,
    });
    await settle(40);

    expect(statusText()).toBe("ON AIR · NO SPEECH");
  });
});

/**
 * SEND FEEDBACK - the last build this product gets ships with a way for a
 * problem report to reach the owner after nobody is watching it any more.
 * The product's own promise ("Keys never leave your machine, and neither
 * does your audio", "No account, no telemetry") is why this only works when
 * a person presses SEND: no scheduler, no crash auto-send, no opt-in toggle.
 * The preview exists so that promise is checkable, not just trusted - so
 * these tests pin two things above all else: nothing goes out before SEND,
 * and what goes out is exactly what was shown.
 */
describe("sending a feedback report", () => {
  const openSettings = async (): Promise<void> => {
    (document.getElementById("settingsBtn") as HTMLButtonElement).click();
    await settle(40);
  };
  const messageEl = (): HTMLTextAreaElement => document.getElementById("feedbackMessage") as HTMLTextAreaElement;
  const includeLogEl = (): HTMLElement => document.getElementById("feedbackIncludeLog") as HTMLElement;
  const previewEl = (): HTMLElement => document.getElementById("feedbackPreview") as HTMLElement;
  const sendBtn = (): HTMLButtonElement => document.getElementById("sendFeedback") as HTMLButtonElement;
  const noteText = (): string => document.getElementById("feedbackNote")?.textContent || "";
  const type = (text: string): void => {
    messageEl().value = text;
    messageEl().dispatchEvent(new Event("input"));
  };
  const lastPayload = (): Record<string, unknown> => feedbackSends[feedbackSends.length - 1].payload as Record<string, unknown>;

  /** 40 lowercase hex characters - the exact shape redactLog.test.ts uses for a Deepgram-style key */
  const SECRET = "df".repeat(20);

  it("keeps SEND FEEDBACK inside THIS APP, not split into another group", async () => {
    // same guard style as "settings keeps a subject in one place" above -
    // this is about the app, not about what viewers see
    const doc = new DOMParser().parseFromString(html, "text/html");
    const settings = doc.getElementById("settings") as HTMLElement;
    const groupOf = (id: string): string | null =>
      settings.querySelector(`#${id}`)?.closest("[data-group]")?.getAttribute("data-group") ?? null;
    const ids = ["feedbackMessage", "feedbackIncludeLog", "feedbackPreview", "sendFeedback", "feedbackNote"];
    const where = ids.map((id) => `${id}=${groupOf(id) ?? "(none)"}`);
    expect(ids.every((id) => groupOf(id) === "app"), `not all in data-group="app": ${where.join("  ")}`).toBe(true);
  });

  it("redacts a secret out of the log before it is ever shown on screen", async () => {
    fakeRelayLog = `[info] connected to wss://textrelay.cc/ws?token=${SECRET}\n[info] deepgram key ${SECRET} accepted`;
    await bootWith({ setupDone: true });
    await openSettings();

    includeLogEl().click();
    await settle(40);

    expect(previewEl().textContent, "the secret survived redaction").not.toContain(SECRET);
    expect(previewEl().textContent, "nothing was redacted at all").toMatch(/redacted/i);
  });

  it("sends nothing until SEND is pressed - not on open, not on typing, not on ticking the box", async () => {
    fakeRelayLog = `deepgram key ${SECRET}`;
    await bootWith({ setupDone: true });
    await openSettings();
    expect(feedbackSends, "opening settings alone sent something").toEqual([]);

    type("captions froze after twenty minutes");
    await settle(40);
    expect(feedbackSends, "typing the message sent something").toEqual([]);

    includeLogEl().click();
    await settle(40);
    expect(feedbackSends, "ticking the log checkbox sent something").toEqual([]);
  });

  it("carries no log field at all when the box is left unticked", async () => {
    fakeRelayLog = `deepgram key ${SECRET}`;
    await bootWith({ setupDone: true });
    await openSettings();
    type("no log, please");

    sendBtn().click();
    await settle(40);

    expect(feedbackSends).toHaveLength(1);
    expect(lastPayload(), "an unticked box must omit `log`, not send it empty").not.toHaveProperty("log");
    expect(lastPayload().message).toBe("no log, please");
  });

  it("sends exactly the string the preview showed, not a fresh read of the log", async () => {
    fakeRelayLog = `deepgram key ${SECRET}`;
    await bootWith({ setupDone: true });
    await openSettings();
    type("with my log");
    includeLogEl().click();
    await settle(40);
    const shown = previewEl().textContent;
    expect(shown, "the preview never populated").toBeTruthy();

    // the log changes AFTER the preview was drawn, before SEND is pressed - if
    // submitFeedback ever re-read or re-redacted at send time instead of
    // reusing what was shown, the payload would carry THIS text instead
    fakeRelayLog = "a line that was never shown in the preview";

    sendBtn().click();
    await settle(40);

    expect(feedbackSends).toHaveLength(1);
    expect(lastPayload().log, "the payload does not match what was previewed").toBe(shown);
    expect(lastPayload().log).not.toContain("never shown in the preview");
  });

  it("never lets a configured relayUrl - or anything else machine-identifying - into the feedback payload", async () => {
    // a fresh install has relayUrl unset (LAN-only by construction), and a
    // self-hosted relay has no /feedback route at all - sendFeedback
    // (packages/companion) takes no url parameter at all, so there is no way
    // for either fact to change where this goes or what it carries; that is
    // now provable by the payload's shape alone, not by asserting on a URL
    // the renderer no longer knows
    await bootWith({ setupDone: true, relayUrl: "wss://someone-elses-relay.example.com" });
    await openSettings();
    type("still works with a self-hosted relay configured");

    sendBtn().click();
    await settle(40);

    expect(feedbackSends).toHaveLength(1);
    expect(Object.keys(lastPayload()).sort()).toEqual(["appVersion", "message"]);
  });

  it("falls back to a version string the server accepts when reading appVersion fails, instead of one it rejects", async () => {
    // parseFeedback (apps/hosted-relay) 400s on an empty appVersion - an IPC
    // hiccup reading the version must not turn into "invalid feedback",
    // which would misreport a local problem as a bad report
    appVersionFails = true;
    await bootWith({ setupDone: true });
    await openSettings();
    type("version read failed locally");

    sendBtn().click();
    await settle(40);

    expect(feedbackSends).toHaveLength(1);
    expect(lastPayload().appVersion, "an empty appVersion is the one value the server rejects").not.toBe("");
    expect(typeof lastPayload().appVersion).toBe("string");
  });

  it("explains an empty log instead of showing a blank box, and sends no log key for it", async () => {
    // a fresh install has no relay.log at all - redactLog("") is "", and
    // "log": "" is a zero-byte object the Worker would store for nothing
    fakeRelayLog = "";
    await bootWith({ setupDone: true });
    await openSettings();
    type("nothing to attach yet");

    includeLogEl().click();
    await settle(40);

    expect(previewEl().hidden, "an empty log left the preview hidden with no explanation").toBe(false);
    expect(previewEl().textContent, "an empty log showed a blank box instead of saying so").not.toBe("");

    sendBtn().click();
    await settle(40);

    expect(feedbackSends).toHaveLength(1);
    expect(lastPayload(), "an empty redacted log must omit `log`, not send it empty").not.toHaveProperty("log");
  });

  it("does not let a stale in-flight log read repopulate the preview after unticking", async () => {
    fakeRelayLog = `deepgram key ${SECRET}`;
    await bootWith({ setupDone: true });
    await openSettings();

    readRelayLogGate = new Promise((r) => {
      releaseReadRelayLogGate = r;
    });
    includeLogEl().click(); // starts a read that will not resolve yet
    await settle(20);
    includeLogEl().click(); // unticks before that read comes back
    await settle(20);

    expect(previewEl().hidden, "unticking did not clear the preview immediately").toBe(true);
    expect(previewEl().textContent).toBe("");

    releaseReadRelayLogGate?.(); // let the stale read land
    await settle(40);

    expect(previewEl().hidden, "a stale read repopulated the preview after unticking").toBe(true);
    expect(previewEl().textContent).toBe("");
  });

  it("reports success with the reference id", async () => {
    feedbackResult = { delivered: true, id: "a1b2c3d4e5f6a7b8", logFailed: false };
    await bootWith({ setupDone: true });
    await openSettings();
    type("worked fine, just checking in");

    sendBtn().click();
    await settle(40);

    expect(noteText()).toContain("a1b2c3d4e5f6a7b8");
  });

  it("treats a 502 that carries an id as delivered - the report landed even though the log did not attach", async () => {
    feedbackResult = { delivered: true, id: "deadbeefdeadbeef", logFailed: true };
    await bootWith({ setupDone: true });
    await openSettings();
    type("log attach test");

    sendBtn().click();
    await settle(40);

    expect(noteText()).toContain("deadbeefdeadbeef");
    expect(noteText()).toMatch(/log did not attach/i);
    // cleared, because a landed report must never be retried - retrying would
    // duplicate it just to retry the log attachment
    expect(messageEl().value, "a delivered report was left sitting there to be resent").toBe("");
  });

  it("treats a 502 with no id as nothing stored, and keeps the message so it can be retried", async () => {
    feedbackResult = { delivered: false, message: "feedback could not be stored" };
    await bootWith({ setupDone: true });
    await openSettings();
    type("please retry me");

    sendBtn().click();
    await settle(40);

    expect(noteText().toLowerCase()).toContain("could not be stored");
    expect(messageEl().value, "nothing was stored, yet the message was thrown away").toBe("please retry me");
  });

  it("surfaces the rate-limit message from the server", async () => {
    feedbackResult = { delivered: false, message: "too much feedback from here - try again in a minute" };
    await bootWith({ setupDone: true });
    await openSettings();
    type("again");

    sendBtn().click();
    await settle(40);

    expect(noteText()).toContain("try again in a minute");
  });

  it("refuses to send an empty message, and makes no request at all", async () => {
    await bootWith({ setupDone: true });
    await openSettings();

    sendBtn().click();
    await settle(40);

    expect(feedbackSends).toEqual([]);
  });

  it("clamps a redacted log that grew past the Worker's cap, instead of 413ing the whole report (minor 7)", async () => {
    // Redaction can GROW text (query.test.ts's own case: "?k=1" -> "?k=<redacted>").
    // apps/hosted-relay's FEEDBACK_LOG_MAX is 1.5 * 1024 * 1024 bytes, checked
    // against the WHOLE request's Content-Length before a byte is parsed - so
    // an oversized log 413s the message too, not just the attachment. A log
    // built almost entirely of short key= assignments (pathological, not a
    // real relay.log shape) grows by roughly 2.7x per occurrence
    // ("&key=1" -> "&key=<redacted>"), enough to cross the cap from a raw
    // log still under relay.log's own 1 MB self-cap.
    const FEEDBACK_LOG_MAX_BYTES = 1.5 * 1024 * 1024;
    fakeRelayLog = "&key=1".repeat(Math.ceil((1024 * 1024) / 6));
    await bootWith({ setupDone: true });
    await openSettings();
    type("log grew past the cap after redaction");

    includeLogEl().click();
    await settle(60);

    const shownBytes = new TextEncoder().encode(previewEl().textContent || "").length;
    expect(
      shownBytes,
      `preview was ${shownBytes} bytes, over the Worker's ${FEEDBACK_LOG_MAX_BYTES}-byte cap - sending it would 413 the whole report, message included`,
    ).toBeLessThanOrEqual(FEEDBACK_LOG_MAX_BYTES);

    sendBtn().click();
    await settle(40);

    expect(feedbackSends).toHaveLength(1);
    const sentLog = lastPayload().log as string;
    const sentBytes = new TextEncoder().encode(sentLog).length;
    expect(sentBytes, `sent log was ${sentBytes} bytes, over the Worker's cap`).toBeLessThanOrEqual(
      FEEDBACK_LOG_MAX_BYTES,
    );
  });
});

/**
 * What a long session costs the caption stage.
 *
 * A session runs for hours and every finished line touches the DOM, a capped row
 * buffer, a capped log buffer and the latency badge. Nothing measured any of it,
 * so any change made here would have been a guess - which is the whole reason
 * this repo's own rule says a performance change needs a number before and
 * after.
 *
 * So this is the number. It drives finals and partials through the same wiring
 * point the relay client uses, in batches, and prints the per-line cost as it
 * goes; `npx vitest run apps/standalone/test/renderer.test.ts -t "a long session"`
 * re-runs it whenever somebody wants to compare.
 *
 * WHAT IS ASSERTED is not the timing. Wall clock under happy-dom on a shared CI
 * runner is exactly the kind of observable that goes green when it should be red,
 * and a threshold tight enough to catch a real regression would fail on a noisy
 * afternoon. What is asserted is what must stay true however long the session
 * runs: the stage and the log stay at their caps, and the cost per line does not
 * climb - the shape that would say something is being re-walked on every caption
 * rather than handled once. The multiplier there is deliberately loose, because
 * it is there to catch a change from O(1) to O(n), not a slow afternoon.
 */
describe("a long session on the caption stage", () => {
  type Seg = { id: number; source: string; target?: string; channel?: number; speaker?: string };
  let hooks: { onSubtitle?: (seg: Seg) => void; onPartial?: (seg: Seg) => void };

  /** MAX_ROWS in the renderer; not exported, so pinned here */
  const MAX_ROWS = 12;
  /** appendLog's cap on the LOG box */
  const MAX_LOG = 400;

  const goLive = async (): Promise<void> => {
    await bootWith({ setupDone: true, deepgramApiKey: "dg-key" });
    const companion = (await import("@callout-relay/companion")) as unknown as {
      RelayPublisherClient: { prototype: { connect: (...args: unknown[]) => void } };
      BrowserAudioCapture: { prototype: Record<string, unknown> };
    };
    companion.RelayPublisherClient.prototype.connect = function (this: {
      state: string;
      hooks: typeof hooks & { onState?: (s: string) => void };
    }) {
      hooks = this.hooks;
      this.state = "connected";
      this.hooks.onState?.("connected");
    };
    companion.BrowserAudioCapture.prototype.start = async () => true;
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "capturing", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "channels", {
      configurable: true,
      get: () => 1,
    });
    (document.getElementById("startStop") as HTMLButtonElement).click();
    await waitFor(() => document.getElementById("app")?.dataset.session === "live", "the session to go live");
  };

  const finals = (): number => document.querySelectorAll("#lines .row:not(.interim)").length;
  const logLines = (): number => (document.getElementById("log") as HTMLElement).children.length;

  /**
   * One utterance as the relay actually delivers it: a partial while it is being
   * said, then the final, then the same id again carrying the translation.
   */
  function utterance(id: number): void {
    hooks.onPartial!({ id, source: "rush", channel: 0 });
    hooks.onSubtitle!({ id, source: `rush B on ${id}`, channel: 0, speaker: "YOU" });
    hooks.onSubtitle!({ id, source: `rush B on ${id}`, target: `đẩy B ${id}`, channel: 0, speaker: "YOU" });
  }

  /** mean milliseconds per utterance over `count`, driven from `from` */
  function batch(from: number, count: number): number {
    const started = performance.now();
    for (let i = 0; i < count; i++) utterance(from + i);
    return (performance.now() - started) / count;
  }

  /**
   * Check the caps after sixty lines, before anything expensive runs.
   *
   * Both tests below drive thousands of utterances in a synchronous loop, and
   * vitest's `testTimeout` cannot interrupt one of those - it only fires between
   * awaits. So a broken cap does not fail these tests, it HANGS them: raising
   * MAX_ROWS and rerunning turned a 2.6-second test into one still going ten
   * minutes later, because every caption was re-walking a DOM that never stopped
   * growing. A guard that hangs is a guard nobody can read, so the cheap check
   * goes first and a regression is red in under a second.
   */
  function probeCaps(): void {
    for (let i = 1; i <= 60; i++) utterance(900_000 + i);
    expect(finals(), "the stage is not holding at MAX_ROWS - stopping before the long run").toBeLessThanOrEqual(
      MAX_ROWS,
    );
    expect(logLines(), "the LOG box is not holding at its cap - stopping before the long run").toBeLessThanOrEqual(
      MAX_LOG,
    );
  }

  it("holds the stage and the log at their caps however long it runs", async () => {
    await goLive();
    probeCaps();
    const BATCH = 500;
    const BATCHES = 6;

    const means: number[] = [];
    for (let b = 0; b < BATCHES; b++) means.push(batch(1 + b * BATCH, BATCH));

    const lines = BATCH * BATCHES;
    // process.stdout, NOT console: this file runs under happy-dom, so `console`
    // is the virtual window's and writes nowhere a terminal can see it. The
    // first version of this printed the whole baseline into a void and the test
    // still passed, which is this repo's first lesson wearing a different hat.
    process.stdout.write(
      `\ncaption path: ${lines} utterances (partial + final + translation each)\n` +
        means.map((m, i) => `  batch ${i + 1}: ${m.toFixed(4)} ms/utterance`).join("\n") +
        `\n  stage rows: ${finals()}/${MAX_ROWS}   log lines: ${logLines()}/${MAX_LOG}\n`,
    );

    expect(finals(), `the stage grew past MAX_ROWS after ${lines} utterances`).toBeLessThanOrEqual(
      MAX_ROWS,
    );
    expect(logLines(), `the LOG box grew past its cap after ${lines} utterances`).toBeLessThanOrEqual(
      MAX_LOG,
    );
    // one open interim per channel, and this session has one channel
    expect(
      document.querySelectorAll("#lines .row.interim").length,
      "interim rows accumulated instead of being reused per channel",
    ).toBeLessThanOrEqual(1);
  });

  it("does not get slower the longer it runs", async () => {
    await goLive();
    probeCaps();
    const BATCH = 500;

    const first = batch(1, BATCH);
    for (let b = 1; b < 5; b++) batch(1 + b * BATCH, BATCH);
    const last = batch(1 + 5 * BATCH, BATCH);

    // A floor, because the first batch also pays for JIT warm-up and can measure
    // near zero - without it the ratio is noise divided by noise. Five times is
    // loose on purpose: it is here to catch O(1) becoming O(n) over 3,000
    // utterances, which would be orders of magnitude, not a busy CI runner.
    const floor = 0.05;
    expect(
      last / Math.max(first, floor),
      `the last 500 utterances cost ${last.toFixed(4)} ms each against ${first.toFixed(4)} at the start - something is being re-walked per caption`,
    ).toBeLessThan(5);
  });
});

/**
 * The LOG view's own contract, characterised before it is moved out of app.ts.
 *
 * Several tests already read `#log` to check that something was written to it,
 * but nothing asserted what the box itself promises: that it holds at 400 lines
 * however long a session runs, that it drops the oldest rather than the newest,
 * and that the counter beside it says how many it is holding. That is the
 * behaviour a reader relies on when they open LOG to find out what went wrong,
 * and it was the untested part of the seam this move relocates.
 */
describe("the LOG box while a session fills it", () => {
  type Seg = { id: number; source: string; target?: string; channel?: number; speaker?: string };
  let hooks: { onSubtitle?: (seg: Seg) => void; onPartial?: (seg: Seg) => void };

  /** appendLog's cap */
  const CAP = 400;

  const goLive = async (): Promise<void> => {
    await bootWith({ setupDone: true, deepgramApiKey: "dg-key" });
    const companion = (await import("@callout-relay/companion")) as unknown as {
      RelayPublisherClient: { prototype: { connect: (...args: unknown[]) => void } };
      BrowserAudioCapture: { prototype: Record<string, unknown> };
    };
    companion.RelayPublisherClient.prototype.connect = function (this: {
      state: string;
      hooks: typeof hooks & { onState?: (s: string) => void };
    }) {
      hooks = this.hooks;
      this.state = "connected";
      this.hooks.onState?.("connected");
    };
    companion.BrowserAudioCapture.prototype.start = async () => true;
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "capturing", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "channels", {
      configurable: true,
      get: () => 1,
    });
    (document.getElementById("startStop") as HTMLButtonElement).click();
    await waitFor(() => document.getElementById("app")?.dataset.session === "live", "the session to go live");
  };

  const box = (): HTMLElement => document.getElementById("log") as HTMLElement;
  const counter = (): string => (document.getElementById("logCount") as HTMLElement).textContent ?? "";

  /** one finished line and its translation: three log lines between them */
  const say = (id: number, what: string): void => {
    hooks.onSubtitle!({ id, source: what, channel: 0 });
    hooks.onSubtitle!({ id, source: what, target: `vi ${id}`, channel: 0 });
  };

  it("holds at four hundred lines and drops the oldest, not the newest", async () => {
    await goLive();
    say(1, "the first thing anyone said");
    for (let id = 2; id <= 400; id++) say(id, `line ${id}`);

    expect(box().children.length, "the box grew past the cap it promises").toBe(CAP);
    expect(box().textContent, "the oldest line survived while newer ones were dropped").not.toContain(
      "the first thing anyone said",
    );
    expect(box().textContent, "the newest line is not in the box").toContain("line 400");
  });

  it("says how many lines it is holding", async () => {
    await goLive();
    say(1, "one");

    expect(counter(), "the counter does not report what the box holds").toBe(
      `${box().children.length} LINES`,
    );

    for (let id = 2; id <= 400; id++) say(id, `line ${id}`);
    expect(counter(), "the counter kept climbing past the cap the box holds at").toBe(`${CAP} LINES`);
  });
});

/**
 * The level meter in 01 SOURCE, characterised before it moves out of app.ts.
 *
 * `rmsLevel` - the part that reads a frame - is tested in packages/companion.
 * What was never tested is what the renderer does with the number: the decay
 * that makes the bars fall smoothly instead of snapping to zero between chunks,
 * and the mapping from decibels onto the twelve bars in the markup. That is the
 * whole visible behaviour of the meter, and it is exactly what a move could
 * break without any existing assertion noticing.
 */
describe("the level meter in 01 SOURCE", () => {
  /** the capture callback the renderer hands to BrowserAudioCapture.start */
  let feed: ((chunk: Int16Array) => void) | undefined;

  /** bars in the shipped markup */
  const BARS = 12;

  const goLive = async (): Promise<void> => {
    await bootWith({ setupDone: true, deepgramApiKey: "dg-key" });
    const companion = (await import("@callout-relay/companion")) as unknown as {
      RelayPublisherClient: { prototype: { connect: (...args: unknown[]) => void } };
      BrowserAudioCapture: { prototype: Record<string, unknown> };
    };
    companion.RelayPublisherClient.prototype.connect = function (this: {
      state: string;
      hooks: { onState?: (s: string) => void };
    }) {
      this.state = "connected";
      this.hooks.onState?.("connected");
    };
    // keep the callback this time: it is the only way into feedLevel
    companion.BrowserAudioCapture.prototype.start = async (
      _sources: unknown,
      onChunk: (chunk: Int16Array) => void,
    ) => {
      feed = onChunk;
      return true;
    };
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "capturing", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "channels", {
      configurable: true,
      get: () => 1,
    });
    (document.getElementById("startStop") as HTMLButtonElement).click();
    await waitFor(() => document.getElementById("app")?.dataset.session === "live", "the session to go live");
    await waitFor(() => feed !== undefined, "capture to be handed its callback");
  };

  /** a frame at a constant amplitude; 32767 is full scale, 0 is silence */
  const frame = (amplitude: number): Int16Array => Int16Array.from({ length: 320 }, () => amplitude);
  const silence = (n: number): void => {
    for (let i = 0; i < n; i++) feed!(frame(0));
  };

  /** the meter renders on an interval, so give it one tick */
  const painted = async (): Promise<number> => {
    await settle(150);
    return document.querySelectorAll("#meter i.on").length;
  };

  it("lights nothing while there is only silence", async () => {
    await goLive();
    silence(5);

    expect(await painted(), "the meter lit bars for a silent microphone").toBe(0);
  });

  it("fills on a frame at full scale", async () => {
    await goLive();
    feed!(frame(32767));

    expect(await painted(), "a frame at full scale did not fill the meter").toBe(BARS);
  });

  it("falls away gradually once the sound stops, rather than snapping to nothing", async () => {
    await goLive();
    feed!(frame(32767));
    expect(await painted()).toBe(BARS);

    silence(20);
    const partway = await painted();
    expect(partway, "the meter emptied the moment the sound stopped").toBeGreaterThan(0);
    expect(partway, "the meter did not fall at all while nothing was said").toBeLessThan(BARS);

    silence(30);
    expect(await painted(), "the meter never reached the bottom after a long silence").toBe(0);
  });
});

/**
 * Audit finding 21's message, and the one thing it exists to say.
 *
 * Unplug a headset mid-game and the app logs which source stopped captioning.
 * The name comes from `sourceLabel(deviceId)`, which looks the id up in the
 * first picker's options and, finding nothing, returns "Default microphone" -
 * for any id at all. So the line can name a device that is still working, and
 * naming the right one is the whole reason the line exists.
 *
 * The codebase already knows this. `dropDisconnectedSources` handles the same
 * problem at boot and says so in a comment: "the label is unrecoverable once
 * the device is gone, so say which slot". It names the slot and guesses
 * nothing. The mid-session handler is the one that guesses.
 *
 * Checked by reading, because this handler cannot be reached from a test. It
 * is assigned to the capture instance during wiring, as an own property on an
 * object nothing exports, so a prototype accessor installed afterwards is
 * shadowed and one installed before is thrown away by `vi.resetModules()`.
 * `capture.test.ts` covers the watcher that calls it; this covers the sentence
 * it produces.
 */
describe("what the app says when a source disconnects mid-session", () => {
  const renderer = fs.readFileSync(path.resolve(__dirname, "..", "renderer", "app.ts"), "utf8");
  const handler = ((): string => {
    const at = renderer.indexOf("capture.onSourceLost = ");
    expect(at, "the finding 21 handler is gone - this guard needs re-pointing").toBeGreaterThanOrEqual(0);
    return renderer.slice(at, renderer.indexOf("\n  };", at));
  })();

  it("does not name a device it could not look up", () => {
    expect(
      /sourceLabel\(/.test(handler) && !/knownSourceLabel\(/.test(handler),
      "the handler names the source with sourceLabel(), which answers \"Default microphone\" for any id it " +
        "cannot find - so the line can name a device that is still working, which is the opposite of its job",
    ).toBe(false);
  });

  it("falls back to the slot, the way the boot-time path already does", () => {
    expect(
      handler,
      "nothing in the handler names the slot, so a lost source whose label cannot be recovered is reported " +
        "as something else entirely",
    ).toMatch(/index \+ 1/);
  });
});

/**
 * A session whose stream has really ended, still claiming ON AIR.
 *
 * `recomputeState()` could only ever promote: `live` when the relay client is
 * connected and capture is running, `starting` while starting, and nothing
 * else. So when the publisher client reached a state it will not come back
 * from on its own - a 4409 close, the one terminal code the embedded relay
 * sends a publisher (a bad token is refused at the handshake and retried) -
 * the topbar went on reading ON AIR, the clock kept running,
 * the mic stayed captured and every chunk was dropped, because `sendAudio`
 * needs a connected socket. The relay half of the GET AN ADDRESS report was
 * one way in; any terminal close is another. Audit finding 6 proposed a way
 * out of `live` and it was never written.
 *
 * The other half matters as much: `disconnected` is the client retrying, which
 * is exactly what a relay restart now produces for a second or two. Ending the
 * session there would undo the relay fix from this side.
 */
describe("a publisher that will not reconnect by itself", () => {
  let client: { state: string; hooks: { onState?: (s: string, detail?: string) => void } };
  let stops = 0;

  const goLive = async (): Promise<void> => {
    await bootWith({ setupDone: true, deepgramApiKey: "dg-key" });
    const companion = (await import("@callout-relay/companion")) as unknown as {
      RelayPublisherClient: { prototype: { connect: (...args: unknown[]) => void } };
      BrowserAudioCapture: { prototype: Record<string, unknown> };
    };
    companion.RelayPublisherClient.prototype.connect = function (this: typeof client) {
      client = this;
      this.state = "connected";
      this.hooks.onState?.("connected");
    };
    stops = 0;
    companion.BrowserAudioCapture.prototype.start = async () => true;
    companion.BrowserAudioCapture.prototype.stop = () => {
      stops += 1;
    };
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "capturing", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "channels", {
      configurable: true,
      get: () => 1,
    });

    (document.getElementById("startStop") as HTMLButtonElement).click();
    await waitFor(() => document.getElementById("app")?.dataset.session === "live", "the session to go live");
  };

  const statusText = (): string => (document.getElementById("statusText") as HTMLElement).textContent || "";
  const sessionState = (): string | undefined => document.getElementById("app")?.dataset.session;

  it("stops claiming ON AIR, and lets go of the mic, when the publisher gives up", async () => {
    await goLive();
    expect(statusText()).toBe("ON AIR");

    // what the client does on a 4409 close: a final state, no retry
    client.state = "error";
    client.hooks.onState?.("error", "replaced by another session");
    await new Promise((r) => setTimeout(r, 20));

    expect(
      statusText(),
      "the publisher has given up for good and nothing will reconnect it, but the topbar still says ON AIR",
    ).not.toBe("ON AIR");
    expect(sessionState(), "the session is still live with no stream behind it").not.toBe("live");
    expect(stops, "the mic is still captured, feeding chunks nobody sends").toBeGreaterThan(0);
  });

  it("says the captions stopped, not that the session could not start", async () => {
    await goLive();
    client.state = "error";
    client.hooks.onState?.("error", "replaced by another session");
    await new Promise((r) => setTimeout(r, 20));

    // the panel's heading was fixed to the start-failure wording, so a session
    // that had been ON AIR ended under "Could not start"
    expect((document.getElementById("idleTitle") as HTMLElement).textContent).not.toBe("Could not start");
  });

  /**
   * A START, STOP and START inside one slow prepareSession - the hosted
   * rotate is a network call - leaves the first start's client connected and
   * unowned, and the relay kicks it with 4409 when the second arrives. Its
   * `error` belongs to a session that no longer exists and must not end the one
   * that does. Stood in for here by the first session's client reporting after
   * a second session has taken over.
   */
  it("ignores an error from a publisher it has already moved on from", async () => {
    await goLive();
    const first = client;
    const startStop = document.getElementById("startStop") as HTMLButtonElement;
    startStop.click();
    await waitFor(() => sessionState() === "idle", "the session to stop");
    startStop.click();
    await waitFor(() => sessionState() === "live" && client !== first, "a second session to go live");
    const stopsBefore = stops;

    first.state = "error";
    first.hooks.onState?.("error", "replaced by another session");
    await new Promise((r) => setTimeout(r, 20));

    expect(sessionState(), "a client the renderer had already replaced ended the session that replaced it").toBe("live");
    expect(stops).toBe(stopsBefore);
  });

  it("stays live while the publisher is only reconnecting", async () => {
    await goLive();

    // what a relay restart produces now: the client closes, retries, and comes back
    client.state = "disconnected";
    client.hooks.onState?.("disconnected", "closed (1001)");
    await new Promise((r) => setTimeout(r, 20));

    expect(sessionState(), "a retrying publisher ended the session, which would undo the relay restart fix").toBe("live");
    expect(stops).toBe(0);
  });
});

/**
 * A STOP pressed while the session is still preparing.
 *
 * `startSession()` sets `starting` and awaits `cr.prepareSession()` - which in
 * the default link mode, with a hosted room, waits on a network POST to rotate
 * the viewer link, with no timeout. The button reads STOP the whole time, and
 * the tray's stop and both setup entries call `stopSession()` too. A stop in
 * that window had nothing to tear down: no publisher yet, no capture yet. So
 * it set STANDBY, and when the preparation came back the start simply carried
 * on - built a publisher, opened the mic and went ON AIR under a streamer who
 * had pressed STOP. The capture-generation guard from audit finding 15 covers
 * the window inside `capture.start()`, not this earlier one.
 *
 * The same missing check let a START, STOP and START inside one preparation
 * build two publishers, the first never disconnected; `8ba952d` stopped that
 * orphan ending the good session, and this stops it being built at all.
 */
describe("a STOP pressed while the session is still preparing", () => {
  let connects = 0;
  let starts = 0;
  let gates: Array<{ release: () => void; fail: (e: Error) => void }> = [];

  const boot = async (): Promise<void> => {
    await bootWith({ setupDone: true, deepgramApiKey: "dg-key" });
    const companion = (await import("@callout-relay/companion")) as unknown as {
      RelayPublisherClient: { prototype: { connect: (...args: unknown[]) => void } };
      BrowserAudioCapture: { prototype: Record<string, unknown> };
    };
    connects = 0;
    starts = 0;
    gates = [];
    companion.RelayPublisherClient.prototype.connect = function (this: {
      state: string;
      hooks: { onState?: (s: string) => void };
    }) {
      connects += 1;
      this.state = "connected";
      this.hooks.onState?.("connected");
    };
    companion.BrowserAudioCapture.prototype.start = async () => {
      starts += 1;
      return true;
    };
    companion.BrowserAudioCapture.prototype.stop = () => undefined;
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "capturing", {
      configurable: true,
      get: () => starts > 0,
    });
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "channels", {
      configurable: true,
      get: () => 1,
    });
    // every preparation waits on a gate the test opens, the way a slow rotate does
    const cr = (window as unknown as { cr: { prepareSession: (...a: unknown[]) => Promise<unknown> } }).cr;
    const real = cr.prepareSession;
    cr.prepareSession = (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        gates.push({ release: () => resolve(real(...args)), fail: reject });
      });
  };

  const button = (): HTMLButtonElement => document.getElementById("startStop") as HTMLButtonElement;
  const sessionState = (): string | undefined => document.getElementById("app")?.dataset.session;
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

  it("stays stopped when the preparation finishes", async () => {
    await boot();
    button().click();
    await settle();
    expect(sessionState()).toBe("starting");
    button().click();
    await settle();
    expect(sessionState()).toBe("idle");

    gates[0]!.release();
    await settle();

    expect(sessionState(), "the start carried on after STOP and went live under a streamer who stopped it").toBe("idle");
    expect(connects, "a publisher was built for a session that had been stopped").toBe(0);
    expect(starts, "the mic was opened for a session that had been stopped").toBe(0);
  });

  it("builds one publisher when START, STOP and START land inside one preparation", async () => {
    await boot();
    button().click();
    await settle();
    button().click();
    await settle();
    button().click();
    await settle();
    expect(gates, "the second START never reached its own preparation").toHaveLength(2);

    gates[0]!.release();
    await settle();
    gates[1]!.release();
    await settle();

    expect(sessionState()).toBe("live");
    expect(connects, "the stopped start built a publisher too, which is left connected and unowned").toBe(1);
  });

  it("does not turn a stopped session into an error when the abandoned preparation fails", async () => {
    await boot();
    button().click();
    await settle();
    button().click();
    await settle();

    gates[0]!.fail(new Error("rotate failed: network timeout"));
    await settle();

    expect(sessionState(), "a preparation the user had already stopped dragged the session into ERROR").toBe("idle");
  });

  // the other side of the same guard: swallowing a stopped start's failure must
  // not swallow the live one's, or every start failure leaves STARTING on screen
  it("still reports the failure of the start that is still going", async () => {
    await boot();
    button().click();
    await settle();

    gates[0]!.fail(new Error("rotate failed: network timeout"));
    await settle();

    expect(sessionState(), "a start that failed on its own was left sitting in STARTING").toBe("error");
    expect((document.getElementById("idleError") as HTMLElement).textContent).toContain("network timeout");
  });
});

/**
 * The model list in SETTINGS, while a session is running.
 *
 * Picking a row switches the engine straight away, live or not - and while
 * live, SETTINGS is the only place a streamer can move to a downloaded local
 * model without a STOP and START that hands viewers a new link. But the rows
 * are big targets: a streamer opening the list mid-stream to download a model
 * for later, and clicking the name rather than exactly on DOWNLOAD, picked a
 * model that was not on disk - which restarted the session onto it and ended
 * the broadcast in ERROR with "Download ... first". Clicking the row of the
 * model already in use bounced a healthy session for nothing: stage cleared,
 * clock reset, a new transcript file started.
 */
describe("the SETTINGS model list during a live session", () => {
  let client: { state: string; hooks: { onSubtitle?: (seg: { id: number; source: string }) => void } };

  const goLive = async (config: Partial<AppConfig>): Promise<void> => {
    await bootWith({ setupDone: true, deepgramApiKey: "dg-key", ...config });
    const companion = (await import("@callout-relay/companion")) as unknown as {
      RelayPublisherClient: { prototype: { connect: (...args: unknown[]) => void } };
      BrowserAudioCapture: { prototype: Record<string, unknown> };
    };
    companion.RelayPublisherClient.prototype.connect = function (this: typeof client & {
      hooks: { onState?: (s: string) => void };
    }) {
      client = this;
      this.state = "connected";
      this.hooks.onState?.("connected");
    };
    companion.BrowserAudioCapture.prototype.start = async () => true;
    companion.BrowserAudioCapture.prototype.stop = () => undefined;
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "capturing", { configurable: true, get: () => true });
    Object.defineProperty(companion.BrowserAudioCapture.prototype, "channels", { configurable: true, get: () => 1 });
    (document.getElementById("startStop") as HTMLButtonElement).click();
    await waitFor(() => document.getElementById("app")?.dataset.session === "live", "the session to go live");
    (document.getElementById("settingsBtn") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 30));
  };

  const session = (): string | undefined => document.getElementById("app")?.dataset.session;
  // one row per local model, in catalogue order
  const rowFor = (id: string): HTMLElement => {
    const rows = [...document.querySelectorAll<HTMLElement>("#settingsModels .model-row")];
    const locals = STT_MODELS.filter((m) => m.provider === "local");
    expect(rows.length, "the settings model list did not draw one row per local model").toBe(locals.length);
    const row = rows[locals.findIndex((m) => m.id === id)];
    if (!row) throw new Error(`no row for ${id} in #settingsModels`);
    return row;
  };

  it("does not throw the broadcast away for a model that is not downloaded", async () => {
    await goLive({});
    const saves = calls.setConfig.length;

    rowFor("local-zipformer-en-20m").click();
    await new Promise((r) => setTimeout(r, 50));

    expect(session(), "clicking a row mid-stream ended the broadcast").toBe("live");
    expect(
      calls.setConfig.slice(saves).filter((p) => "stt" in p),
      "a live session was switched onto a model that is not on disk",
    ).toEqual([]);
    // and it says why, where the click happened - not only in LOG
    const note = document.getElementById("modelsDir") as HTMLElement;
    expect(note.textContent, "the click did nothing visible and said nothing").toMatch(/DOWNLOAD .* FIRST/);
    expect(note.classList.contains("warn")).toBe(true);
  });

  it("takes the warning down again afterwards", async () => {
    await goLive({});
    const note = document.getElementById("modelsDir") as HTMLElement;
    const idle = note.textContent;
    vi.useFakeTimers();
    try {
      rowFor("local-zipformer-en-20m").click();
      expect(note.classList.contains("warn")).toBe(true);
      vi.advanceTimersByTime(6_500);
      expect(note.textContent, "the warning stayed up for good").toBe(idle);
      expect(note.classList.contains("warn")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still switches a live session to a model that is on disk, keeping the link", async () => {
    fakeModels = [{ id: "local-zipformer-en-20m", downloaded: true, sizeMb: 60 }];
    await goLive({});
    const saves = calls.setConfig.length;

    rowFor("local-zipformer-en-20m").click();
    await waitFor(() => calls.setConfig.slice(saves).some((p) => p.stt === "local-zipformer-en-20m"), "the switch to be saved");
    await waitFor(() => session() === "live", "the session to come back on the new model");

    expect(calls.rotated.length, "switching the engine handed viewers a new link").toBe(0);
  });

  it("still picks the model when nothing is running", async () => {
    await bootWith({ setupDone: true, deepgramApiKey: "dg-key" });
    (document.getElementById("settingsBtn") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 30));
    const saves = calls.setConfig.length;

    rowFor("local-zipformer-en-20m").click();
    await new Promise((r) => setTimeout(r, 50));

    expect(
      calls.setConfig.slice(saves).map((p) => p.stt),
      "the lock reached past the live session and the list no longer picks anything",
    ).toEqual(["local-zipformer-en-20m"]);
  });

  it("leaves a live session alone when the row clicked is the model already in use", async () => {
    fakeModels = [{ id: "local-zipformer-en-20m", downloaded: true, sizeMb: 60 }];
    await goLive({ stt: "local-zipformer-en-20m" });
    client.hooks.onSubtitle?.({ id: 1, source: "rush B" });
    const saves = calls.setConfig.length;

    rowFor("local-zipformer-en-20m").click();
    await new Promise((r) => setTimeout(r, 50));

    expect(session()).toBe("live");
    expect(calls.setConfig.slice(saves), "re-picking the model in use saved and restarted for nothing").toEqual([]);
    expect(document.querySelector("#lines .row")?.textContent, "the stage was cleared by a restart").toContain("rush B");
    expect(
      (document.getElementById("log") as HTMLElement).textContent,
      "the log told the streamer to stop the session to switch to the model they are already on",
    ).not.toContain("stop the session to switch");
  });
});

/**
 * A model list rebuilt under the pointer.
 *
 * While a model downloads, main pushes status about four times a second, and
 * every push rebuilt the whole list - rows, bars and buttons - in SETTINGS and
 * on setup step 1. A click is a press and a release on the same element, and
 * Chromium does not deliver it when the pressed element was removed in
 * between: a quarter of a second is well inside a normal click, so CANCEL,
 * and DOWNLOAD or REMOVE on another row, simply did nothing a good share of
 * the time while any download ran. It looked like the buttons were broken.
 *
 * A push that only moves a percentage now moves it in place, and the row is
 * rebuilt only when what it offers changes.
 */
describe("the model list while a download is running", () => {
  const ID = "local-zipformer-en-20m";
  const status = (models: typeof fakeModels) => ({
    companion: { version: "0.8.0" },
    session: { state: "idle" },
    relay: { mode: "embedded", url: "ws://127.0.0.1:8787", viewers: 0, remoteViewers: 0 },
    devices: [],
    config: { ...DEFAULT_CONFIG, setupDone: true },
    localModels: models,
  });
  const cancelIn = (box: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>(`#${box} .model-row button`)].find((b) => b.textContent === "CANCEL");

  it("keeps the button under the pointer when only the percentage moves, in SETTINGS", async () => {
    fakeModels = [{ id: ID, downloaded: false, sizeMb: 44, progress: 12 } as (typeof fakeModels)[number]];
    await bootWith({ setupDone: true });
    (document.getElementById("settingsBtn") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 30));
    const before = cancelIn("settingsModels");
    expect(before, "no CANCEL on the downloading model").toBeDefined();

    pushStatus?.(status([{ id: ID, downloaded: false, sizeMb: 44, progress: 13 } as (typeof fakeModels)[number]]));

    expect(before?.isConnected, "the CANCEL a click was pressed on was thrown away by a progress tick").toBe(true);
    expect(cancelIn("settingsModels")).toBe(before);
    expect(before?.closest(".model-row")?.textContent, "the percentage did not move").toContain("13%");
  });

  it("keeps it on setup step 1 too", async () => {
    const locals = STT_MODELS.filter((m) => m.provider === "local");
    fakeModels = locals.map((m) => ({ id: m.id, downloaded: false, sizeMb: 10, progress: 12 }) as (typeof fakeModels)[number]);
    await bootWith({ setupDone: false });
    (document.querySelector('#obSttSeg [data-value="local"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 30));
    const before = cancelIn("obModels");
    expect(before, "no CANCEL in setup's list").toBeDefined();

    pushStatus?.(status(locals.map((m) => ({ id: m.id, downloaded: false, sizeMb: 10, progress: 13 }) as (typeof fakeModels)[number])));

    expect(before?.isConnected, "setup's CANCEL was thrown away by a progress tick").toBe(true);
    expect(cancelIn("obModels")).toBe(before);
  });

  // the rows that stay put must still move the highlight when another model is
  // picked - the one change a row's buttons do not show
  it("still moves the highlight to the model picked", async () => {
    const [first, second] = STT_MODELS.filter((m) => m.provider === "local");
    fakeModels = [first!, second!].map((m) => ({ id: m.id, downloaded: true, sizeMb: 10 }));
    await bootWith({ setupDone: true, stt: first!.id });
    (document.getElementById("settingsBtn") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 30));

    const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("#settingsModels .model-row")];
    rows()[1]!.click();
    await waitFor(() => calls.setConfig.some((p) => p.stt === second!.id), "the pick to be saved");
    // main answers a save with a status push, and that push is what redraws
    // the list - the model states in it have not changed, only the pick
    pushStatus?.(status(fakeModels));
    await new Promise((r) => setTimeout(r, 30));

    expect(rows()[1]!.classList.contains("picked"), "the model just picked is not highlighted").toBe(true);
    expect(rows()[0]!.classList.contains("picked"), "the old model is still highlighted").toBe(false);
  });

  it("still redraws the row when the download finishes", async () => {
    fakeModels = [{ id: ID, downloaded: false, sizeMb: 44, progress: 99 } as (typeof fakeModels)[number]];
    await bootWith({ setupDone: true });
    (document.getElementById("settingsBtn") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 30));

    pushStatus?.(status([{ id: ID, downloaded: true, sizeMb: 44 }]));

    const buttons = [...document.querySelectorAll("#settingsModels .model-row button")].map((b) => b.textContent);
    expect(buttons, "a finished download still offers CANCEL").not.toContain("CANCEL");
    expect(document.querySelector("#settingsModels")?.textContent, "the finished model does not say READY").toContain("READY");
  });
});
