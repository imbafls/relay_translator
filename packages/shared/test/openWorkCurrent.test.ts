import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { LOCAL_VAD, STT_MODELS } from "../src/index";

/**
 * `docs/OPEN-WORK.md` is the consolidated backlog, and CLAUDE.md sends a new
 * session to it first. That makes a stale entry there worse than a stale
 * comment: it does not mislead someone reading the code, it sends them to
 * re-do work that is already done.
 *
 * CLAUDE.md says a guard test cannot catch a stale claim, only a dangling
 * pointer, and that is how this file and HANDOFF.md both drifted before. True
 * in general. Not true of a claim that contradicts something the code can be
 * asked about directly - which is what these two are, and it is the same trick
 * `reap.test.ts` plays on the hosted README.
 *
 * The file's own convention for a closed item is to strike it through and date
 * it, so what is asserted is that no LIVE entry makes the claim. Deleting the
 * entry satisfies that too; leaving it struck through is what the file does
 * everywhere else.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const doc = (): string => fs.readFileSync(path.join(root, "docs", "OPEN-WORK.md"), "utf8");

/**
 * Bullet entries that are not struck through, joined back up - a bullet runs
 * until the next one starts or the next heading, so its continuation lines
 * come with it.
 */
function liveEntries(text: string): string[] {
  const out: string[] = [];
  let current: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^- /.test(line)) {
      if (current) out.push(current.join("\n"));
      // `- ~~**Thing.**~~ Fixed ...` is the file's way of saying "closed"
      current = /^- ~~/.test(line) ? null : [line];
    } else if (/^#{1,6} /.test(line)) {
      if (current) out.push(current.join("\n"));
      current = null;
    } else if (current) {
      current.push(line);
    }
  }
  if (current) out.push(current.join("\n"));
  return out;
}

describe("the entry splitter", () => {
  it("keeps a live entry with its continuation and drops a struck one", () => {
    const sample = [
      "## Section",
      "- **Still broken.** first line",
      "  second line of the same entry",
      "- ~~**Was broken.**~~ Fixed 2026-01-01.",
      "  a note under the fixed one",
      "- **Also broken.** alone",
    ].join("\n");

    const live = liveEntries(sample);
    expect(live).toHaveLength(2);
    expect(live[0]).toContain("second line of the same entry");
    expect(live.join("\n")).not.toContain("Was broken");
    expect(live.join("\n")).not.toContain("a note under the fixed one");
  });
});

describe("what the backlog still calls open", () => {
  it("does not say file-based models have no integrity check, when every one carries a digest", () => {
    const withUrl = [
      ...STT_MODELS.flatMap((m) => (m.files ?? []).filter((f) => f.url)),
      ...(LOCAL_VAD.files ?? []).filter((f) => f.url),
    ];
    const undigested = withUrl.filter((f) => !/^[0-9a-f]{64}$/.test(f.sha256 ?? ""));

    // only meaningful while the code is actually in the state the doc denies
    expect(withUrl.length).toBeGreaterThan(0);
    if (undigested.length > 0) return;

    const offenders = liveEntries(doc()).filter((e) => /no integrity check/i.test(e));
    expect(
      offenders,
      `every one of the ${withUrl.length} catalogue files that crosses the network carries a sha256, ` +
        `but OPEN-WORK.md still lists this as open:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("does not say every silent final forces a storage write, when the write is gated on words", () => {
    const roomSrc = fs.readFileSync(path.join(root, "apps", "hosted-relay", "src", "room.ts"), "utf8");
    // the gate this entry asked for: advance the persisted id only for a line
    // that carries words
    const gated = /if \(hasWords\(msg\) && id > room\.lastSegId\)/.test(roomSrc);
    if (!gated) return;

    const offenders = liveEntries(doc()).filter((e) => /silent final forces a Durable Object storage write/i.test(e));
    expect(
      offenders,
      `room.ts advances lastSegId only when the line carries words, but OPEN-WORK.md still lists this as open:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  /**
   * The phantom viewer: one room reported a reader with nothing watching, and
   * both this file and the hosted README carried it as unexplained and open.
   * A cause was found to fit - a phone gone without a FIN, its socket held by a
   * room that has no timer - and never proven, because the room was gone.
   *
   * It does not need proving any more to be closed. The count cannot be held
   * up: `liveViewers()` drops a socket silent past `VIEWER_SILENT_MS`, and skips
   * one the room has already closed, so whatever held that socket would now be
   * let go on the next wake-up. An open entry telling the next session to chase
   * it sends them after something the code no longer permits.
   */
  it("does not call the phantom viewer open, when no socket can hold the count up", () => {
    const roomSrc = fs.readFileSync(path.join(root, "apps", "hosted-relay", "src", "room.ts"), "utf8");
    const sweeps =
      /now - last\.getTime\(\) < VIEWER_SILENT_MS/.test(roomSrc) &&
      /if \(ws\.readyState !== READY_OPEN\) continue;/.test(roomSrc);
    if (!sweeps) return;

    const readme = fs.readFileSync(path.join(root, "apps", "hosted-relay", "README.md"), "utf8");
    const offenders = [...liveEntries(doc()), ...liveEntries(readme)].filter((e) =>
      /unexplained viewer socket/i.test(e),
    );
    expect(
      offenders,
      "room.ts drops a viewer that has been silent past VIEWER_SILENT_MS and never counts one it closed, " +
        `but a backlog still lists the phantom viewer as open:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("found entries to check, so the two assertions above mean something", () => {
    const live = liveEntries(doc());
    expect(live.length).toBeGreaterThan(3);
    // finding 17 is genuinely open and owner-only; if this ever goes quiet the
    // splitter has broken rather than the backlog having emptied
    expect(doc()).toContain("17 (part)");
  });
});
