import { describe, expect, it } from "vitest";
import { CHANGELOG, changesSince } from "../src/index";

/**
 * The panel this drives is shown after the app updates itself, so the two
 * failure modes are both user-visible: showing nothing when a release did land,
 * and showing a release the user is not running yet.
 */

describe("what to show after an update", () => {
  it("shows the release that just landed", () => {
    const got = changesSince("0.5.2", "0.5.3");
    expect(got.map((e) => e.version)).toEqual(["0.5.3"]);
  });

  it("shows every release skipped in a multi-version jump, newest first", () => {
    const got = changesSince("0.5.0", "0.5.3");
    expect(got.map((e) => e.version)).toEqual(["0.5.3", "0.5.2", "0.5.1"]);
  });

  it("shows nothing on a fresh install, which never updated from anything", () => {
    expect(changesSince(undefined, "0.5.3")).toEqual([]);
    expect(changesSince("", "0.5.3")).toEqual([]);
  });

  it("shows nothing when the version has not moved", () => {
    expect(changesSince("0.5.3", "0.5.3")).toEqual([]);
  });

  it("holds back a release written ahead of shipping", () => {
    // 0.5.4 is in the changelog before it is tagged; someone on 0.5.3 must not
    // be told about changes they do not have
    expect(CHANGELOG.some((e) => e.version === "0.5.4")).toBe(true);
    expect(changesSince("0.5.2", "0.5.3").map((e) => e.version)).not.toContain("0.5.4");
  });

  it("says nothing when the app has somehow gone backwards", () => {
    expect(changesSince("0.5.3", "0.5.1")).toEqual([]);
  });

  it("compares numerically, not as text", () => {
    // "0.10.0" < "0.9.0" as strings, and that ordering would hide releases
    expect(changesSince("0.9.0", "0.10.0")).toEqual([]);
    expect(changesSince("0.5.3", "0.10.0").length).toBeGreaterThan(0);
  });

  it("tolerates a v prefix on either side", () => {
    expect(changesSince("v0.5.2", "v0.5.3").map((e) => e.version)).toEqual(["0.5.3"]);
  });
});

describe("the changelog itself", () => {
  it("is ordered newest first, which is the order the panel renders", () => {
    const nums = CHANGELOG.map((e) => e.version.split(".").map(Number));
    for (let i = 1; i < nums.length; i += 1) {
      const [a, b] = [nums[i - 1], nums[i]];
      const newer = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      expect(newer, `${CHANGELOG[i - 1].version} should be newer than ${CHANGELOG[i].version}`).toBeGreaterThan(0);
    }
  });

  it("gives every release a headline and at least one line", () => {
    for (const e of CHANGELOG) {
      expect(e.headline, `${e.version} has no headline`).toBeTruthy();
      expect(e.changes.length, `${e.version} has no changes`).toBeGreaterThan(0);
      expect(e.date, `${e.version} has no date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("uses only the three kinds the panel can label", () => {
    for (const e of CHANGELOG) {
      for (const c of e.changes) expect(["added", "fixed", "changed"]).toContain(c.kind);
    }
  });

  it("carries no emoji - the app is typographic and the user asked for none", () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    for (const e of CHANGELOG) {
      expect(emoji.test(e.headline), `${e.version} headline has emoji`).toBe(false);
      for (const c of e.changes) expect(emoji.test(c.text), `${e.version} line has emoji`).toBe(false);
    }
  });

  it("names no AI tooling - this is read by users, not contributors", () => {
    const text = JSON.stringify(CHANGELOG).toLowerCase();
    for (const word of ["claude", "copilot", "generated with", "co-authored-by"]) {
      expect(text, `changelog mentions "${word}"`).not.toContain(word);
    }
  });
});
