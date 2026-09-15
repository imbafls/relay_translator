import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { isAllowedUpdateFeed, updateFeedAction } from "../src/index";

const root = path.resolve(__dirname, "..", "..", "..");

/**
 * The decision half of audit finding 27, pulled out of the updater so it can
 * be run. The updater's own caching bug - `load()` returned early and never
 * re-applied the feed, so a changed `updateFeedUrl` did nothing until the app
 * was restarted - is guarded at the source in `startupGuards.test.ts`, since
 * `apps/standalone/src/updater.ts` imports Electron.
 */
describe("what to do with the update feed", () => {
  it("does nothing when there is no override and never was one", () => {
    expect(updateFeedAction(undefined, undefined)).toEqual({ action: "none" });
    expect(updateFeedAction("", undefined)).toEqual({ action: "none" });
    expect(updateFeedAction("   ", undefined)).toEqual({ action: "none" });
  });

  it("applies an override that is not the one already applied", () => {
    expect(updateFeedAction("https://feed.example/updates/", undefined)).toEqual({
      action: "set",
      url: "https://feed.example/updates/",
    });
    expect(updateFeedAction("https://b.example/", "https://a.example/")).toEqual({
      action: "set",
      url: "https://b.example/",
    });
  });

  it("does not re-apply the feed it is already on", () => {
    expect(updateFeedAction("https://feed.example/", "https://feed.example/")).toEqual({ action: "none" });
    // the config value is trimmed before it is compared, or every check would
    // re-set the same feed because someone pasted a trailing space
    expect(updateFeedAction("  https://feed.example/  ", "https://feed.example/")).toEqual({ action: "none" });
  });

  it("refuses a feed that isAllowedUpdateFeed rejects, rather than silently keeping the old one", () => {
    expect(updateFeedAction("http://evil.example/updates/", undefined)).toEqual({
      action: "refused",
      url: "http://evil.example/updates/",
    });
    expect(updateFeedAction("not a url", "https://feed.example/")).toEqual({ action: "refused", url: "not a url" });
    // loopback http is the developer serving their own build, and is allowed
    expect(updateFeedAction("http://127.0.0.1:8080/u/", undefined)).toEqual({
      action: "set",
      url: "http://127.0.0.1:8080/u/",
    });
  });

  it("says a restart is needed when an override is cleared, because it cannot be undone", () => {
    // electron-updater has no way back to the packaged app-update.yml once
    // setFeedURL has replaced it. Reporting "none" here would leave the app
    // checking a feed the user just deleted and telling them it was gone.
    expect(updateFeedAction(undefined, "https://feed.example/")).toEqual({ action: "restart-needed" });
    expect(updateFeedAction("", "https://feed.example/")).toEqual({ action: "restart-needed" });
  });
});

/**
 * The rule that decides where an update may come from.
 *
 * CLAUDE.md names `isAllowedUpdateFeed()` as the thing that bounds the biggest
 * known-open risk in this repo: there is no code signing, so electron-updater's
 * `verifySignature` returns early and the only integrity proof for an update is
 * the sha512 in the feed's own `latest.yml`. A feed the user did not choose is
 * therefore a binary the user did not choose - which is the attack `Stop a web
 * page choosing which binary the app runs` closed.
 *
 * It had no direct test. One case reached it through `updateFeedAction`, and
 * everything else about the boundary - which schemes, which hosts - was
 * asserted nowhere.
 *
 * **`[::1]` is the reachable IPv6 form and `::1` is not.** WHATWG URL always
 * serialises an IPv6 host with brackets, and `new URL("http://::1/")` throws
 * outright, so the bare entry in the allowlist can never match. It is harmless
 * where it is; what would not be harmless is somebody tidying the list by
 * taking the brackets OFF `[::1]`, which reads like a correction and would stop
 * IPv6 loopback working. That is pinned below rather than explained in a
 * comment nobody runs.
 */
describe("where an update is allowed to come from", () => {
  const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

  it("treats an unset feed as the packaged one", () => {
    expect(isAllowedUpdateFeed(undefined)).toBe(true);
    expect(isAllowedUpdateFeed(null)).toBe(true);
    expect(isAllowedUpdateFeed("")).toBe(true);
  });

  it("allows https anywhere, which is the whole basis of the rule", () => {
    expect(isAllowedUpdateFeed("https://github.com/x/y/releases/latest")).toBe(true);
    expect(isAllowedUpdateFeed("https://example.invalid/feed/")).toBe(true);
  });

  it("allows plain http only on the loopback names, a developer serving their own build", () => {
    for (const host of LOOPBACK) {
      expect(isAllowedUpdateFeed(`http://${host}:9/`), `${host} is a loopback name and was refused`).toBe(true);
    }
  });

  it("refuses plain http everywhere else, including the addresses that look local", () => {
    for (const host of ["example.com", "0.0.0.0", "127.0.0.2", "localhost.example.com", "10.0.0.1"]) {
      expect(
        isAllowedUpdateFeed(`http://${host}:9/`),
        `${host} was accepted over plain http, so an update could be served from it`,
      ).toBe(false);
    }
  });

  it("keeps the bracketed IPv6 form, because the bare one cannot be reached", () => {
    // if this ever flips, the list was "tidied" and IPv6 loopback stopped working
    expect(isAllowedUpdateFeed("http://[::1]:9/"), "the bracketed IPv6 loopback stopped being allowed").toBe(true);
    // not a URL at all - the catch is what refuses it, not the host list
    expect(() => new URL("http://::1:9/")).toThrow();
    expect(isAllowedUpdateFeed("http://::1:9/")).toBe(false);
  });

  it("refuses anything that is not http or https, and anything unparseable", () => {
    for (const url of ["file:///C:/tmp/latest.yml", "ftp://example.com/", "javascript:alert(1)", "not a url", "://x"]) {
      expect(isAllowedUpdateFeed(url), `${url} was accepted as an update feed`).toBe(false);
    }
  });

  it("is described by CLAUDE.md with the same list it enforces", () => {
    const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    const said = /only for loopback \(([^)]*)\)/.exec(claude)?.[1] ?? "";
    const named = [...said.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    expect(named.length, "CLAUDE.md no longer lists the loopback names, so this checks nothing").toBeGreaterThan(2);

    const unreachable = named.filter((h) => !isAllowedUpdateFeed(`http://${h}:9/`));
    expect(
      unreachable,
      `CLAUDE.md tells a reader these are allowed over http and they are not: ${unreachable.join(", ")}. ` +
        "That sentence is the stated mitigation for shipping unsigned updates.",
    ).toEqual(["::1"]);
  });
});
