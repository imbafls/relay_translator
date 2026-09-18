import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TranscriptLine } from "@callout-relay/relay";
import {
  TranscriptWriter,
  deleteTranscript,
  exportTranscript,
  isSessionId,
  listTranscripts,
  readTranscript,
  sessionIdFor,
  toSrt,
  toText,
  transcriptFile,
} from "../src/transcripts";

/**
 * Saved transcripts exist for one case: the session that did not end cleanly.
 * A crash, a power cut, a relay restart, a dropped socket. So everything here
 * runs against a real directory on a real disk, reads the file back RAW as
 * well as through the reader, and checks what is on disk before anything has
 * been closed - because a writer that only flushes on close passes every test
 * that closes first, and fails the only case the feature is for.
 */

let dir: string;
let clock: number;
const now = (): number => clock;
const LANGS = { source: "en", target: "vi" };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcripts-"));
  clock = Date.UTC(2026, 8, 10, 12, 0, 0);
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

const line = (id: number, source: string, extra: Partial<TranscriptLine> = {}): TranscriptLine => ({
  type: "subtitle",
  id,
  source,
  latency: { stt: 400 },
  ...extra,
});
const tr = (id: number, source: string, target: string): TranscriptLine => ({
  type: "subtitle",
  id,
  source,
  target,
  latency: { stt: 400, translate: 600 },
});

function writer(
  over: { enabled?: () => boolean; dir?: () => string; onChange?: () => void } = {},
): TranscriptWriter {
  return new TranscriptWriter({
    dir: over.dir ?? (() => dir),
    enabled: over.enabled ?? (() => true),
    appVersion: "0.8.0",
    now,
    onChange: over.onChange,
  });
}

const jsonl = (): string[] => fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
const rawRecords = (file: string): Record<string, unknown>[] =>
  fs
    .readFileSync(path.join(dir, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe("writing", () => {
  /**
   * The file is created by the first line, not by START. A START that fails -
   * no key, a busy port, a dead device - should not leave an empty transcript
   * behind for every attempt.
   */
  it("writes nothing until the first line arrives", () => {
    const w = writer();
    w.open({ languages: LANGS, translates: true });
    expect(jsonl()).toEqual([]);

    w.write(line(1, "rush B"));
    expect(jsonl()).toHaveLength(1);
  });

  it("puts each line on disk as it arrives, before anything is closed", () => {
    const w = writer();
    w.open({ languages: LANGS, translates: true });
    w.write(line(1, "rush B"));
    const [file] = jsonl();
    // not closed: this is the state a crash leaves behind
    expect(rawRecords(file).map((r) => r.kind)).toEqual(["session", "line"]);

    w.write(line(2, "one on A"));
    expect(rawRecords(file).map((r) => r.kind)).toEqual(["session", "line", "line"]);
  });

  /**
   * Deepgram sends a finished empty utterance every few seconds on a silent
   * channel. The relay still needs that final to retire its interim row, but a
   * saved session does not: one real 94-minute session held 3,105 empty records
   * and only 657 records with words.
   */
  it("does not save recogniser finals with no words", () => {
    const w = writer();
    w.open({ languages: LANGS, translates: true });
    w.write(line(1, ""));
    w.write(line(2, " \t "));

    expect(jsonl(), "silent finals created a transcript file").toEqual([]);

    w.write(line(3, "rush B"));
    const [file] = jsonl();
    expect(rawRecords(file).filter((r) => r.kind === "line")).toMatchObject([{ n: 1, source: "rush B" }]);
  });

  /**
   * `target: ""` is the relay saying a line's translation is not coming - so
   * the live stage can take its "…" down. It arrives on the same tap as a real
   * translation, and a saved session records what was said and translated, not
   * which translations failed: it writes nothing, and the line stays as it was.
   */
  it("does not save a translation that is not coming", () => {
    const w = writer();
    w.open({ languages: LANGS, translates: true });
    w.write(line(1, "push B"));
    w.write(tr(1, "push B", ""));
    w.close();

    const [file] = jsonl();
    expect(
      rawRecords(file).map((r) => r.kind),
      "a failed translation was written into the saved session",
    ).toEqual(["session", "line"]);
    const t = readTranscript(dir, file.replace(/\.jsonl$/, ""))!;
    expect(t.rows[0]?.target).toBeUndefined();
  });

  /**
   * With translation on, the relay emits one utterance twice under one id:
   * the line, then the same line again carrying `target`. Recording each emit
   * as a line would double every utterance in the archive.
   */
  it("records a translated utterance as one line, not two", () => {
    const w = writer();
    w.open({ languages: LANGS, translates: true });
    w.write(line(1, "push B"));
    w.write(tr(1, "push B", "B'ye geliyorlar"));
    w.close();

    const [file] = jsonl();
    expect(rawRecords(file).filter((r) => r.kind === "line")).toHaveLength(1);
    const t = readTranscript(dir, file.replace(/\.jsonl$/, ""))!;
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({ source: "push B", target: "B'ye geliyorlar" });
  });

  /**
   * Segment ids restart at 1 on every new publisher socket, and a reconnect
   * inside one session does not start a new file. So ids repeat within a
   * file, and merging a translation by relay id alone would hang it on
   * whichever earlier line happened to share the number.
   */
  it("hangs a translation on the right line after ids restart mid-session", () => {
    const w = writer();
    w.open({ languages: LANGS, translates: true });
    w.write(line(1, "first"));
    w.write(line(2, "second"));
    // publisher socket reconnects: the relay starts counting again
    w.write(line(1, "third"));
    w.write(tr(1, "third", "thứ ba"));
    w.close();

    expect(jsonl()).toHaveLength(1);
    const rows = readTranscript(dir, jsonl()[0].replace(/\.jsonl$/, ""))!.rows;
    expect(rows.map((r) => r.source)).toEqual(["first", "second", "third"]);
    expect(rows[0].target).toBeUndefined();
    expect(rows[2].target).toBe("thứ ba");
  });

  /**
   * STOP lets the last utterance finish, but its translation is a separate
   * round trip to Gemini and can land after the session has been closed.
   */
  it("still records a translation that lands just after STOP", () => {
    const w = writer();
    w.open({ languages: LANGS, translates: true });
    w.write(line(1, "last call"));
    w.close();
    clock += 2000;
    w.write(tr(1, "last call", "lần cuối"));

    const rows = readTranscript(dir, jsonl()[0].replace(/\.jsonl$/, ""))!.rows;
    expect(rows[0].target).toBe("lần cuối");
  });

  it("does not write a line when no session is open", () => {
    const w = writer();
    w.write(line(1, "stray"));
    expect(jsonl()).toEqual([]);
  });

  it("writes nothing at all while saving is switched off", () => {
    const w = writer({ enabled: () => false });
    w.open({ languages: LANGS, translates: true });
    w.write(line(1, "not kept"));
    expect(jsonl()).toEqual([]);
    expect(w.status().state).toBe("off");
  });

  it("gives two sessions started in the same second two files", () => {
    const w = writer();
    w.open({ languages: LANGS, translates: true });
    w.write(line(1, "a"));
    w.close();
    w.open({ languages: LANGS, translates: true });
    w.write(line(1, "b"));
    w.close();

    expect(jsonl()).toHaveLength(2);
  });

  it("opens every file with a header saying what it is", () => {
    const w = writer();
    w.open({ languages: LANGS, translates: true });
    w.write(line(1, "rush B"));
    const t = readTranscript(dir, jsonl()[0].replace(/\.jsonl$/, ""))!;
    expect(t.header).toMatchObject({ startedAt: clock, app: "0.8.0", languages: LANGS, translates: true });
  });

  it("keeps the speaker a line was attributed to", () => {
    const w = writer();
    w.open({ languages: LANGS, translates: false });
    w.write(line(1, "one on A", { channel: 1, speaker: "CHAT" }));
    const t = readTranscript(dir, jsonl()[0].replace(/\.jsonl$/, ""))!;
    expect(t.rows[0]).toMatchObject({ channel: 1, speaker: "CHAT" });
  });

  /**
   * Never throws: a full disk or a pulled USB drive must not cost a single
   * caption. But unlike relay.log it does not give up for good after one
   * failure - lines arrive every few seconds, not every millisecond, and a
   * drive that comes back should start receiving them again.
   */
  it("reports a folder it cannot write to, without throwing", () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "a file where a folder should be");
    const w = writer({ dir: () => path.join(blocker, "Transcripts") });
    w.open({ languages: LANGS, translates: true });

    expect(() => w.write(line(1, "lost"))).not.toThrow();
    expect(w.status().state).toBe("failed");
    expect(w.status().error).toBeTruthy();
  });

  it("starts saving again once the folder can be written", () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "x");
    const target = path.join(blocker, "Transcripts");
    const w = writer({ dir: () => target });
    w.open({ languages: LANGS, translates: true });
    w.write(line(1, "lost"));
    expect(w.status().state).toBe("failed");

    fs.rmSync(blocker);
    w.write(line(2, "kept"));
    expect(w.status().state).toBe("saving");
    expect(fs.readdirSync(target).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
  });
});

describe("reading", () => {
  const id = (): string => jsonl()[0].replace(/\.jsonl$/, "");

  it("reads every complete record from a file cut off mid-line", () => {
    const w = writer();
    w.open({ languages: LANGS, translates: false });
    w.write(line(1, "survived"));
    // the crash: half a record, no newline
    fs.appendFileSync(path.join(dir, jsonl()[0]), '{"v":1,"kind":"line","n":2,"id":2,"t":1,"sou');

    const t = readTranscript(dir, id())!;
    expect(t.rows.map((r) => r.source)).toEqual(["survived"]);
  });

  it("skips a corrupt record and keeps the ones after it", () => {
    const w = writer();
    w.open({ languages: LANGS, translates: false });
    w.write(line(1, "before"));
    fs.appendFileSync(path.join(dir, jsonl()[0]), "garbage{\n");
    w.write(line(2, "after"));

    expect(readTranscript(dir, id())!.rows.map((r) => r.source)).toEqual(["before", "after"]);
  });

  it("lists sessions newest first, with their line counts", () => {
    const w = writer();
    w.open({ languages: LANGS, translates: false });
    w.write(line(1, "a"));
    w.close();
    clock += 60 * 60 * 1000;
    w.open({ languages: LANGS, translates: false });
    w.write(line(1, "b"));
    w.write(line(2, "c"));
    w.close();

    const list = listTranscripts(dir);
    expect(list.map((s) => s.lines)).toEqual([2, 1]);
    expect(list[0].startedAt).toBeGreaterThan(list[1].startedAt);
  });

  it("lists only transcript files, whatever else is in the folder", () => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
    fs.writeFileSync(path.join(dir, "random.jsonl"), "{}\n");
    const w = writer();
    w.open({ languages: LANGS, translates: false });
    w.write(line(1, "a"));
    w.close();

    expect(listTranscripts(dir)).toHaveLength(1);
  });

  it("lists nothing, rather than throwing, for a folder that is not there yet", () => {
    expect(listTranscripts(path.join(dir, "never-created"))).toEqual([]);
  });
});

describe("session ids", () => {
  it("accepts what it mints, including a same-second suffix", () => {
    const id = sessionIdFor(clock);
    expect(isSessionId(id)).toBe(true);
    expect(isSessionId(`${id}-2`)).toBe(true);
  });

  /**
   * The renderer names a transcript by id and main turns that into a path it
   * hands to fs and shell. An id that can climb out of the folder would turn
   * DELETE into "delete anything this user can".
   */
  it("rejects anything that could name a file outside the folder", () => {
    for (const bad of ["", "..", "../x", "a/b", "a\\b", "C:\\x", "2026-09-10T12-00-00.jsonl", "2026-09-10T12-00-00/../x"]) {
      expect(isSessionId(bad), bad).toBe(false);
      expect(transcriptFile(dir, bad), bad).toBeUndefined();
    }
  });

  it("resolves a valid id to a file inside the folder", () => {
    const id = sessionIdFor(clock);
    expect(transcriptFile(dir, id)).toBe(path.join(dir, `${id}.jsonl`));
  });
});

describe("export", () => {
  function sample() {
    const w = writer();
    w.open({ languages: LANGS, translates: true });
    clock += 2000;
    w.write(line(1, "push B"));
    w.write(tr(1, "push B", "B'ye geliyorlar"));
    clock += 3000;
    w.write(line(2, "one on A", { speaker: "CHAT", channel: 1 }));
    w.close();
    return readTranscript(dir, jsonl()[0].replace(/\.jsonl$/, ""))!;
  }

  it("writes text with elapsed times, both languages and the speaker", () => {
    const text = toText(sample());
    expect(text).toContain("[00:00:02] push B");
    expect(text).toContain("B'ye geliyorlar");
    expect(text).toContain("[00:00:05] CHAT: one on A");
  });

  it("writes SRT a video editor will accept", () => {
    const srt = toSrt(sample());
    const cues = srt.trim().split(/\r?\n\r?\n/);
    expect(cues).toHaveLength(2);
    expect(cues[0].split(/\r?\n/)).toEqual([
      "1",
      "00:00:02,000 --> 00:00:05,000",
      "push B",
      "B'ye geliyorlar",
    ]);
    expect(cues[1].split(/\r?\n/)[0]).toBe("2");
    expect(cues[1]).toMatch(/^2\r?\n00:00:05,000 --> 00:00:0\d,\d{3}\r?\nCHAT: one on A$/);
  });

  /**
   * The case above has three seconds between lines, which is slow speech. Real
   * game comms are not: "push B", "one left", "rotating" land a few hundred
   * milliseconds apart, and that is the shape of nearly every transcript this
   * app writes. The test above is named for what a video editor will accept
   * and never exercises it.
   *
   * A cue used to be held open for a minimum readable time whatever the next
   * one did, so four lines 400ms apart produced cues a full second long, each
   * running over the next two. At 0.9s into that file three cues are live at
   * once, from ONE speaker. A player that stacks overlapping subtitles shows
   * three lines piling up; one that shows the last to start flickers between
   * them.
   *
   * There is no way to keep that floor and not overlap, because the floor only
   * ever binds when the next line is already closer than the floor. So a cue
   * now ends where the next begins. A short cue is what was actually said in
   * that window, and the screen is never empty: the next cue takes over the
   * instant this one ends.
   */
  it("gives a fast speaker cues that do not run over each other", () => {
    const w = writer();
    w.open({ languages: LANGS, translates: false });
    for (let i = 1; i <= 4; i++) {
      clock += 400;
      w.write(line(i, `line ${i}`));
    }
    w.close();
    const t = readTranscript(dir, jsonl()[0].replace(/\.jsonl$/, ""))!;

    const ms = (h: string, mi: string, se: string, mil: string): number =>
      Number(h) * 3600000 + Number(mi) * 60000 + Number(se) * 1000 + Number(mil);
    const times = toSrt(t)
      .trim()
      .split(/\r?\n\r?\n/)
      .map((cue) => {
        const m = /(\d\d):(\d\d):(\d\d),(\d{3}) --> (\d\d):(\d\d):(\d\d),(\d{3})/.exec(cue);
        if (!m) throw new Error(`no timing line in cue: ${JSON.stringify(cue)}`);
        return { from: ms(m[1], m[2], m[3], m[4]), to: ms(m[5], m[6], m[7], m[8]) };
      });

    expect(times.length, "the sample stopped producing four cues").toBe(4);

    const overlapping = times
      .map((cue, i) => ({ cue, next: times[i + 1], i }))
      .filter(({ cue, next }) => next && cue.to > next.from)
      .map(({ cue, next, i }) => `cue ${i + 1} ends at ${cue.to}ms and cue ${i + 2} starts at ${next.from}ms`);
    expect(
      overlapping,
      "cues run over each other, so a player has more than one on screen at a time from a single speaker",
    ).toEqual([]);

    // and the rule stated exactly: each cue lasts until the next begins, with
    // the last one getting the fixed tail
    expect(times.map((c) => c.to - c.from)).toEqual([400, 400, 400, 4000]);
  });
});

describe("export and delete", () => {
  function saved(): string {
    const w = writer();
    w.open({ languages: LANGS, translates: true });
    clock += 2000;
    w.write(line(1, "push B"));
    w.write(tr(1, "push B", "B'ye geliyorlar"));
    w.close();
    return jsonl()[0].replace(/\.jsonl$/, "");
  }

  /**
   * UTF-8 with a byte-order mark. Without one, older Windows tools - and
   * several subtitle editors still in use - read the file in the system code
   * page, and every Vietnamese diacritic arrives as mojibake.
   */
  it("writes a .txt beside the transcript, marked as UTF-8", () => {
    const id = saved();
    const file = exportTranscript(dir, id, "txt")!;
    expect(file).toBe(path.join(dir, `${id}.txt`));
    const bytes = fs.readFileSync(file);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toContain("B'ye geliyorlar");
  });

  it("writes an .srt beside the transcript", () => {
    const id = saved();
    const file = exportTranscript(dir, id, "srt")!;
    expect(file).toBe(path.join(dir, `${id}.srt`));
    expect(fs.readFileSync(file, "utf8")).toContain("00:00:02,000 --> ");
  });

  it("exports nothing for an id that names no transcript", () => {
    expect(exportTranscript(dir, "../../x", "txt")).toBeUndefined();
    expect(exportTranscript(dir, sessionIdFor(clock + 999_999), "txt")).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("deletes the transcript along with anything exported from it", () => {
    const id = saved();
    exportTranscript(dir, id, "txt");
    exportTranscript(dir, id, "srt");
    expect(deleteTranscript(dir, id)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  /** the renderer's id is untrusted input on its way to fs.rmSync */
  it("refuses to delete anything an id does not name", () => {
    const keep = path.join(dir, "keep.txt");
    fs.writeFileSync(keep, "mine");
    for (const bad of ["", "..", "../keep", "keep", "keep.txt", "C:\\Windows"]) {
      expect(deleteTranscript(dir, bad), bad).toBe(false);
    }
    expect(fs.existsSync(keep)).toBe(true);
  });

  it("answers false for a transcript that is already gone", () => {
    expect(deleteTranscript(dir, sessionIdFor(clock))).toBe(false);
  });
});

describe("status changes", () => {
  /**
   * The app shows SAVING / NOT SAVING from a status push, and pushes go out
   * only when something asks for one. A write that starts failing half-way
   * through a session - a drive pulled, a disk filling up - is exactly the
   * change nothing else would announce.
   */
  it("announces a write starting to fail, and recovering", () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "x");
    let changes = 0;
    const w = writer({ dir: () => path.join(blocker, "T"), onChange: () => changes++ });
    w.open({ languages: LANGS, translates: false });
    const opened = changes;

    w.write(line(1, "lost"));
    expect(changes).toBeGreaterThan(opened);
    const failed = changes;

    w.write(line(2, "still lost"));
    expect(changes, "the same failure again is not news").toBe(failed);

    fs.rmSync(blocker);
    w.write(line(3, "kept"));
    expect(changes).toBeGreaterThan(failed);
  });

  it("announces the file appearing and the session closing, not every line", () => {
    let changes = 0;
    const w = writer({ onChange: () => changes++ });
    w.open({ languages: LANGS, translates: false });
    const a = changes;

    w.write(line(1, "a"));
    expect(changes, "the first line creates the file, and status now names it").toBeGreaterThan(a);
    const b = changes;

    w.write(line(2, "b"));
    expect(changes, "an ordinary line is not a status change").toBe(b);

    w.close();
    expect(changes).toBeGreaterThan(b);
  });

  it("survives a listener that throws", () => {
    const w = writer({
      onChange: () => {
        throw new Error("window already destroyed");
      },
    });
    w.open({ languages: LANGS, translates: false });
    expect(() => w.write(line(1, "a"))).not.toThrow();
    expect(() => w.close()).not.toThrow();
    expect(jsonl()).toHaveLength(1);
  });
});
