import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, validTranscriptDir } from "../src/index";

/**
 * `transcriptDir` is the first path-shaped key in AppConfig. Every directory
 * the app has used until now was derived - defaultDataDir(), modelsDir - so
 * none of them could ever be a hand-edited string.
 *
 * This one can. ConfigStore.merge() wholesale-assigns unknown keys through a
 * `Record<string, unknown>` cast with no allowlist, so whatever is in
 * config.json arrives typed as `string | undefined` whether or not it ever was
 * one. validRelayPort is the precedent: validate at the edge, because the
 * point of consumption (fs.mkdirSync, fs.appendFileSync) is far too late.
 */
describe("validTranscriptDir", () => {
  it("rejects the empty and whitespace-only strings", () => {
    expect(validTranscriptDir("")).toBeUndefined();
    expect(validTranscriptDir("   ")).toBeUndefined();
    expect(validTranscriptDir("\t\n")).toBeUndefined();
  });

  it("rejects anything that is not a string", () => {
    expect(validTranscriptDir(undefined)).toBeUndefined();
    expect(validTranscriptDir(null)).toBeUndefined();
    expect(validTranscriptDir(42)).toBeUndefined();
    expect(validTranscriptDir(true)).toBeUndefined();
    expect(validTranscriptDir(["C:\\x"])).toBeUndefined();
    expect(validTranscriptDir({ path: "C:\\x" })).toBeUndefined();
  });

  /**
   * A relative path resolves against process.cwd(), which for a packaged
   * Electron app is wherever Windows happened to launch it from - Program
   * Files, the desktop, a shell's working directory. Transcripts would land
   * somewhere the user cannot predict and the app cannot find again.
   */
  it("rejects relative paths", () => {
    expect(validTranscriptDir("transcripts")).toBeUndefined();
    expect(validTranscriptDir("./transcripts")).toBeUndefined();
    expect(validTranscriptDir("..\\transcripts")).toBeUndefined();
  });

  /**
   * Both absolute forms are accepted on BOTH platforms, deliberately.
   * `path.isAbsolute` answers for the running platform only, and the CI
   * linux-relay job runs `vitest run packages/shared` - so a check written
   * with it would pass on the dev machine and fail the release build.
   */
  it("accepts a Windows absolute path anywhere it runs", () => {
    expect(validTranscriptDir("C:\\Users\\me\\Documents\\Callout Relay")).toBe(
      "C:\\Users\\me\\Documents\\Callout Relay",
    );
    expect(validTranscriptDir("D:/transcripts")).toBe("D:/transcripts");
  });

  it("accepts a POSIX absolute path anywhere it runs", () => {
    expect(validTranscriptDir("/home/me/transcripts")).toBe("/home/me/transcripts");
  });

  it("accepts a UNC path", () => {
    expect(validTranscriptDir("\\\\nas\\share\\transcripts")).toBe("\\\\nas\\share\\transcripts");
  });

  it("trims surrounding whitespace rather than rejecting it", () => {
    expect(validTranscriptDir("  C:\\transcripts  ")).toBe("C:\\transcripts");
  });
});

describe("transcript saving defaults", () => {
  /**
   * The whole feature is for the session you did not know you were about to
   * lose. A transcript you have to switch on beforehand does not cover that
   * case, so this defaults ON and the test says so out loud.
   */
  it("saves transcripts on a fresh install", () => {
    expect(DEFAULT_CONFIG.saveTranscripts).toBe(true);
  });

  /**
   * Required, not `saveTranscripts?: boolean` - the reason the
   * idleBillingStopMinutes comment already gives at length. An optional
   * boolean gets read as `cfg.saveTranscripts ?? false` somewhere downstream
   * and silently defaults the feature to the opposite of what is intended.
   */
  it("carries the key explicitly rather than leaving it absent", () => {
    expect(Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, "saveTranscripts")).toBe(true);
  });

  /**
   * `transcriptDir` is the opposite case: genuinely absent on a fresh install,
   * because the default location needs app.getPath("documents") and only the
   * Electron main process can answer that. Absent must mean "the default",
   * never "nowhere".
   */
  it("leaves the directory absent so main resolves the platform default", () => {
    expect(DEFAULT_CONFIG.transcriptDir).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, "transcriptDir")).toBe(false);
  });
});
