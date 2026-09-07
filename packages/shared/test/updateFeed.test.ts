import { describe, expect, it } from "vitest";
import { updateFeedAction } from "../src/index";

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
