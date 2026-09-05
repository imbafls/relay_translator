import { describe, expect, it } from "vitest";
import { CONTROL_PATCHABLE_KEYS, controlConfigPatch, isAllowedUpdateFeed } from "../src/index";

/**
 * What a remote control may change, and which update feed may be trusted.
 *
 * These two are one attack when put together: the control API on 47477 has no
 * credential and admits `Origin: null`, so a sandboxed iframe on any page can
 * POST to it; and `updateFeedUrl` decides which executable the app downloads
 * and runs on quit. Setting that one field from a web page is code execution.
 */

describe("what a remote control may change", () => {
  it("keeps the settings a Stream Deck actually sends", () => {
    // exactly what pi.js posts: stt, translation, audioSource, languages,
    // translationEnabled
    const { allowed, rejected } = controlConfigPatch({
      stt: "deepgram-nova-3",
      translation: "gemini-3.1-flash-lite",
      audioSource: "default-mic",
      languages: { source: "en", target: "vi" },
      translationEnabled: false,
    });
    expect(rejected).toEqual([]);
    expect(Object.keys(allowed).sort()).toEqual(
      ["audioSource", "languages", "stt", "translation", "translationEnabled"].sort(),
    );
  });

  it.each([
    ["the update feed, which chooses the binary that gets run", "updateFeedUrl", "https://evil.example/"],
    ["the relay endpoint", "relayUrl", "ws://evil.example"],
    ["the publisher token", "publisherToken", "stolen"],
    ["the viewer token", "viewerToken", "stolen"],
    ["a Deepgram key", "deepgramApiKey", "planted"],
    ["a Gemini key", "geminiApiKey", "planted"],
    ["the public base url", "publicBaseUrl", "https://evil.example"],
    ["whether updates happen at all", "autoUpdate", false],
    ["whether setup is finished", "setupDone", true],
  ])("refuses %s", (_what, key, value) => {
    const { allowed, rejected } = controlConfigPatch({ [key]: value });
    expect(allowed).toEqual({});
    expect(rejected).toEqual([key]);
  });

  it("keeps the good half of a mixed patch and names the rest", () => {
    const { allowed, rejected } = controlConfigPatch({
      translationEnabled: true,
      updateFeedUrl: "https://evil.example/",
    });
    expect(allowed).toEqual({ translationEnabled: true });
    expect(rejected).toEqual(["updateFeedUrl"]);
  });

  it.each([[null], [undefined], ["a string"], [42], [[]]])("survives %p as a patch", (patch) => {
    expect(controlConfigPatch(patch as never)).toEqual({ allowed: {}, rejected: [] });
  });

  it("never lets a secret through, whatever the list says", () => {
    const forbidden = ["deepgramApiKey", "geminiApiKey", "publisherToken", "viewerToken", "updateFeedUrl"];
    for (const key of forbidden) {
      expect(CONTROL_PATCHABLE_KEYS as readonly string[]).not.toContain(key);
    }
  });
});

describe("which update feed may be trusted", () => {
  it("allows an unset feed, which means the packaged one", () => {
    expect(isAllowedUpdateFeed(undefined)).toBe(true);
    expect(isAllowedUpdateFeed("")).toBe(true);
  });

  it("allows https", () => {
    expect(isAllowedUpdateFeed("https://relay.supr.systems/updates/")).toBe(true);
  });

  it("allows http on loopback, which is a developer serving their own build", () => {
    expect(isAllowedUpdateFeed("http://127.0.0.1:8787/updates/")).toBe(true);
    expect(isAllowedUpdateFeed("http://localhost:8787/updates/")).toBe(true);
  });

  it("refuses plain http anywhere else", () => {
    // the build sets no publisherName, so electron-updater's signature check
    // returns early - http hands the installer to anyone on the path
    expect(isAllowedUpdateFeed("http://relay.supr.systems/updates/")).toBe(false);
    expect(isAllowedUpdateFeed("http://192.168.1.9/updates/")).toBe(false);
  });

  it.each([
    ["file:///C:/evil/"],
    ["ftp://evil.example/"],
    ["javascript:alert(1)"],
    ["not a url at all"],
  ])("refuses %s", (url) => {
    expect(isAllowedUpdateFeed(url)).toBe(false);
  });
});
