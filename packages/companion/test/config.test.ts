import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigStore } from "../src/config";

/**
 * config.json is the user's whole setup: which model, which languages, and both
 * API keys. It is rewritten on every settings change while a session may be
 * running, so it gets read back after crashes, power cuts and hand edits.
 */

let dir: string;
const ENV_KEYS = ["DEEPGRAM_API_KEY", "GEMINI_API_KEY", "CALLOUT_RELAY_DATA"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-config-"));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // load() warns on an unreadable file; that is the behaviour under test
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

const file = (): string => path.join(dir, "config.json");
const write = (contents: string): void => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file(), contents, "utf8");
};

describe("keeping what the user set", () => {
  it("reads back what it saved", () => {
    new ConfigStore(dir).update({ deepgramApiKey: "dg-key", stt: "local-zipformer-en" });
    const loaded = new ConfigStore(dir).load();
    expect(loaded.deepgramApiKey).toBe("dg-key");
    expect(loaded.stt).toBe("local-zipformer-en");
  });

  it("merges a partial language change instead of dropping the other half", () => {
    const store = new ConfigStore(dir);
    store.update({ languages: { source: "de", target: "ja" } });
    const after = store.update({ languages: { target: "ko" } as never });
    expect(after.languages).toEqual({ source: "de", target: "ko" });
  });

  it("keeps keys it does not know about, so a downgrade does not wipe them", () => {
    write(JSON.stringify({ deepgramApiKey: "dg-key", somethingNewer: { a: 1 } }));
    const loaded = new ConfigStore(dir).load() as unknown as Record<string, unknown>;
    expect(loaded.somethingNewer).toEqual({ a: 1 });
  });

  it("leaves no stray temp file behind", () => {
    new ConfigStore(dir).update({ stt: "deepgram-nova-3" });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("secrets from the environment", () => {
  it("fills in a key that is not in the file", () => {
    process.env.GEMINI_API_KEY = "gm-from-env";
    expect(new ConfigStore(dir).load().geminiApiKey).toBe("gm-from-env");
  });

  it("does not override a key the user actually saved", () => {
    write(JSON.stringify({ geminiApiKey: "gm-from-file" }));
    process.env.GEMINI_API_KEY = "gm-from-env";
    expect(new ConfigStore(dir).load().geminiApiKey).toBe("gm-from-file");
  });
});

describe("a config file that did not survive the last write", () => {
  it("does not throw on a file holding a bare null", () => {
    write("null");
    expect(() => new ConfigStore(dir).load()).not.toThrow();
  });

  it.each([
    ["an array", "[]"],
    ["a bare string", '"hello"'],
    ["a number", "42"],
  ])("does not adopt %s as settings", (_name, contents) => {
    write(contents);
    const loaded = new ConfigStore(dir).load() as unknown as Record<string, unknown>;
    // a string would otherwise merge in as numeric keys 0, 1, 2...
    expect(loaded["0"]).toBeUndefined();
    expect(loaded.stt).toBeTruthy();
  });

  it("recovers the API keys from the previous copy rather than resetting", () => {
    const store = new ConfigStore(dir);
    store.update({ deepgramApiKey: "dg-key", geminiApiKey: "gm-key" });
    // a second save is what creates the backup of the first
    store.update({ stt: "local-zipformer-en" });
    // now the live file is cut short, the way a crash mid-write leaves it
    fs.writeFileSync(file(), '{"deepgramApiKey": "dg-k', "utf8");

    const recovered = new ConfigStore(dir).load();
    expect(recovered.deepgramApiKey).toBe("dg-key");
    expect(recovered.geminiApiKey).toBe("gm-key");
  });

  it("falls back to defaults when there is no backup either", () => {
    write("{ truncated");
    const loaded = new ConfigStore(dir).load();
    expect(loaded.deepgramApiKey).toBeUndefined();
    expect(loaded.stt).toBeTruthy();
  });

  it("does not let a torn file overwrite a good backup", () => {
    const store = new ConfigStore(dir);
    store.update({ deepgramApiKey: "dg-key" });
    store.update({ stt: "local-zipformer-en" });
    fs.writeFileSync(file(), "{ torn", "utf8");

    // saving on top of a torn file must not promote it to the backup
    new ConfigStore(dir).update({ showLatency: false });
    const bak = JSON.parse(fs.readFileSync(`${file()}.bak`, "utf8"));
    expect(bak.deepgramApiKey).toBe("dg-key");
  });
});

describe("migrations from older versions", () => {
  it("moves a pre-0.3 obsOverlay flag onto output", () => {
    write(JSON.stringify({ obsOverlay: true }));
    expect(new ConfigStore(dir).load().output).toBe("obs");
  });

  it("leaves output alone when the newer field is already set", () => {
    write(JSON.stringify({ obsOverlay: true, output: "phone" }));
    expect(new ConfigStore(dir).load().output).toBe("phone");
  });

  it("treats a saved Deepgram key as pre-0.4 proof that setup was done", () => {
    write(JSON.stringify({ deepgramApiKey: "dg-key" }));
    expect(new ConfigStore(dir).load().setupDone).toBe(true);
  });

  it("does not claim setup was done for a fresh install", () => {
    expect(new ConfigStore(dir).load().setupDone).toBe(false);
  });
});
