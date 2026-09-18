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

/**
 * The `## ` sections holding live entries that no triage rule looks at.
 *
 * The rule below checks three sections by name, so open work under any other
 * heading - a new `## Found after 1.0`, say - would sit there unseen by it.
 * Two kinds of section may hold live entries, told apart by heading: the
 * release's known limitations (live entries are the point) and `Blocked` (open
 * by design), where everything must sit under a `### B<n>` so the limitations
 * can name it - `strays` is what does not. Every other section, the text
 * before the first heading included, may hold no live entry at all: closed
 * work is struck through, and that includes the `Closed by ...` records. The
 * sections are found, not listed.
 */
function triage(text: string): {
  seen: string[];
  untriaged: { heading: string; live: string[] }[];
  strays: string[];
} {
  const sections: { heading: string; body: string[] }[] = [{ heading: "(before the first ## heading)", body: [] }];
  for (const line of text.split(/\r?\n/)) {
    if (/^## /.test(line)) sections.push({ heading: line.slice(3).trim(), body: [] });
    else sections[sections.length - 1]!.body.push(line);
  }
  const mayBeOpen = (heading: string): boolean => /^Known limitations in 1\.0\b/.test(heading) || /^Blocked\b/.test(heading);

  // Blocked, split at its ### headings: the part before the first one, and
  // every part under a heading without a B-number, is a stray
  const strays: string[] = [];
  for (const s of sections.filter((x) => /^Blocked\b/.test(x.heading))) {
    const parts: { heading: string | null; body: string[] }[] = [{ heading: null, body: [] }];
    for (const line of s.body) {
      if (/^### /.test(line)) parts.push({ heading: line, body: [] });
      else parts[parts.length - 1]!.body.push(line);
    }
    for (const part of parts) {
      if (part.heading === null) strays.push(...liveEntries(part.body.join("\n")).map((e) => e.split("\n")[0] ?? ""));
      else if (!/^### B\d+\b/.test(part.heading)) strays.push(part.heading);
    }
  }

  return {
    seen: sections.map((s) => s.heading),
    untriaged: sections
      .filter((s) => !mayBeOpen(s.heading))
      .map((s) => ({ heading: s.heading, live: liveEntries(s.body.join("\n")).map((e) => e.split("\n")[0] ?? "") }))
      .filter((s) => s.live.length > 0),
    strays,
  };
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

  /**
   * A release ships with its open items either fixed or named.
   *
   * 1.0 was cut against exactly that rule: every item still open was fixed,
   * struck through, or written into `## Known limitations in 1.0` with the
   * reason it does not block the release. That section is what a user-facing
   * README draws from, so an open item left anywhere else is a limitation the
   * release shipped with and nobody said.
   *
   * Held structurally rather than by matching titles: open work may live under
   * `## Blocked`, where each `### B<n>` must be named in the limitations, or in
   * the limitations section itself. `## Not blocked` holds none - no live
   * bullet, no row left in its "Still open" table - because anything there is
   * either done or has been triaged out of it.
   */
  it("leaves nothing open that the release neither fixed nor named as a known limitation", () => {
    const text = doc();
    const section = (heading: RegExp): string | undefined => {
      const lines = text.split(/\r?\n/);
      const at = lines.findIndex((l) => heading.test(l));
      if (at < 0) return undefined;
      const end = lines.findIndex((l, i) => i > at && /^## /.test(l));
      return lines.slice(at + 1, end < 0 ? undefined : end).join("\n");
    };

    const known = section(/^## Known limitations in 1\.0\b/);
    expect(known, "OPEN-WORK.md has no `## Known limitations in 1.0` section").toBeDefined();
    expect(liveEntries(known ?? "").length, "the known limitations section lists nothing").toBeGreaterThan(0);

    const blocked = section(/^## Blocked\b/);
    expect(blocked, "the Blocked section is gone, so nothing here checked it").toBeDefined();
    const ids = [...(blocked ?? "").matchAll(/^### (B\d+)\b/gm)].map((m) => m[1] ?? "");
    const unnamed = ids.filter((id) => !new RegExp(`\\b${id}\\b`).test(known ?? ""));
    expect(unnamed, "blocked items the release does not name as a known limitation").toEqual([]);

    const notBlocked = section(/^## Not blocked\b/);
    expect(notBlocked, "the Not blocked section is gone, so nothing here checked it").toBeDefined();
    const loose = liveEntries(notBlocked ?? "").map((e) => e.split("\n")[0]);
    expect(loose, "open entries under Not blocked that are neither struck through nor moved to the limitations").toEqual(
      [],
    );
    const stillOpen = (notBlocked ?? "").split(/^### /m).find((s) => s.startsWith("Still open")) ?? "";
    const rows = stillOpen
      .split(/\r?\n/)
      .filter((l) => l.startsWith("|") && !/^\|\s*Rank\b/.test(l) && !/^\|[-\s|]+\|$/.test(l));
    expect(rows, "audit findings still in the Still open table rather than fixed or named").toEqual([]);
  });

  it("has no section the triage rule does not know that holds open work", () => {
    const { seen, untriaged, strays } = triage(doc());
    // seven today - the text before the first heading, and six headings. A
    // file read as one section means the splitter found no heading at all.
    expect(seen.length, "the triage read no sections").toBeGreaterThan(4);
    expect(untriaged, "open entries under a heading no triage rule checks").toEqual([]);
    expect(strays, "open work under Blocked that is not a B<n> the limitations can name").toEqual([]);
  });

  it("finds open work under a heading it has never seen, and before the first one", () => {
    const fixture = [
      "# Open work",
      "",
      "- **Left in the preamble.** Nobody triaged this.",
      "",
      "## Known limitations in 1.0",
      "",
      "- **A named limitation.** Allowed.",
      "",
      "## Found after 1.0",
      "",
      "- ~~**Done already.**~~ Struck, so not open.",
      "- **A new open item.** Under a heading the rule never named.",
    ].join("\n");
    const { untriaged } = triage(fixture);

    expect(untriaged.map((u) => u.heading)).toEqual(["(before the first ## heading)", "Found after 1.0"]);
    expect(untriaged[1]?.live).toEqual(["- **A new open item.** Under a heading the rule never named."]);
  });

  /**
   * A `## Closed by ...` section once counted as triaged by its heading, on the
   * grounds that its entries were finished work written as prose. That let an
   * open item sit there unseen - "Still open: ..." under Closed by v0.8.0
   * passed. Closed work is struck through like everywhere else in the file, so
   * a Closed-by record is held to the same rule as any other section.
   */
  it("holds a Closed-by section to the rule too, so open work cannot hide in one", () => {
    const fixture = [
      "## Known limitations in 1.0",
      "",
      "- **A named limitation.** Allowed.",
      "",
      "## Closed by v9.9.9",
      "",
      "- ~~**Finished work.**~~ Struck, as closed work is.",
      "- **Still open: a thing.** Written into a record of finished work.",
    ].join("\n");
    const { untriaged } = triage(fixture);

    expect(untriaged.map((u) => u.heading)).toEqual(["Closed by v9.9.9"]);
    expect(untriaged[0]?.live).toEqual(["- **Still open: a thing.** Written into a record of finished work."]);
  });

  /**
   * Blocked is open by design, and each item there is named in the known
   * limitations by its B<n>. The older rule only looked at headings that
   * already had a B<n>, so a blocked item under any other heading - or a loose
   * bullet between them - was never asked to be named.
   */
  it("wants every blocked item to be a B<n>, so the limitations can name it", () => {
    const fixture = [
      "## Known limitations in 1.0",
      "",
      "- **Something (B7).** Named.",
      "",
      "## Blocked",
      "",
      "- **A loose open bullet.** Under Blocked but under no item.",
      "",
      "### B7 — A named blocked item",
      "",
      "- **A detail of B7.** Part of B7, which is named.",
      "",
      "### C1 — A blocked item with no B-number",
      "",
      "Prose.",
    ].join("\n");
    const { untriaged, strays } = triage(fixture);

    expect(untriaged).toEqual([]);
    expect(strays).toEqual(["- **A loose open bullet.** Under Blocked but under no item.", "### C1 — A blocked item with no B-number"]);
  });

  it("found entries to check, so the two assertions above mean something", () => {
    const live = liveEntries(doc());
    expect(live.length).toBeGreaterThan(3);
    // finding 17 is genuinely open and owner-only; if this ever goes quiet the
    // splitter has broken rather than the backlog having emptied
    expect(doc()).toContain("17 (part)");
  });
});
