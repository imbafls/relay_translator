import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigStore } from "../src/config";

/**
 * Saved transcripts are on by default, and a config.json written by 0.7.0 or
 * anything earlier has never heard of the key. So the question this file pins
 * is what a MISSING value loads as - the answer has to be ON. An update must
 * not quietly leave unsaved the one session the feature was there to save.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-transcripts-"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

const write = (cfg: Record<string, unknown>): void =>
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg));

describe("the saveTranscripts setting", () => {
  it("loads a config written before the key existed as saving", () => {
    write({ stt: "deepgram-nova-3", setupDone: true });
    expect(new ConfigStore(dir).load().saveTranscripts).toBe(true);
  });

  it("keeps an explicit OFF", () => {
    write({ stt: "deepgram-nova-3", saveTranscripts: false });
    expect(new ConfigStore(dir).load().saveTranscripts).toBe(false);
  });
});

describe("the transcriptDir setting", () => {
  it("is absent on a fresh install, so main resolves the default", () => {
    expect(new ConfigStore(dir).load().transcriptDir).toBeUndefined();
  });

  it("survives a reload once chosen", () => {
    const store = new ConfigStore(dir);
    store.load();
    store.update({ transcriptDir: "D:\\Streams\\Transcripts" });
    expect(new ConfigStore(dir).load().transcriptDir).toBe("D:\\Streams\\Transcripts");
  });

  /**
   * USE DOCUMENTS clears the folder by saving "" - merge() skips undefined, so
   * clearing with undefined would leave the old folder in place. "" then has
   * to read as "no folder", which validTranscriptDir does.
   */
  it("can be cleared back to the default with an empty string", () => {
    const store = new ConfigStore(dir);
    store.load();
    store.update({ transcriptDir: "D:\\Streams\\Transcripts" });
    store.update({ transcriptDir: "" });
    expect(new ConfigStore(dir).load().transcriptDir).toBe("");
  });
});
