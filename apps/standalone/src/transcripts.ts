import * as fs from "fs";
import * as path from "path";
import type {
  Languages,
  SubtitleLatency,
  Transcript,
  TranscriptHeader,
  TranscriptRow,
  TranscriptStatus,
  TranscriptSummary,
} from "@callout-relay/shared";
import type { TranscriptLine } from "@callout-relay/relay";

/**
 * Saved transcripts: the app's own copy of every finished line, on this PC,
 * written as the session runs.
 *
 * The feature exists for the session that does NOT end cleanly - a crash, a
 * power cut, a relay restart, a dropped socket. Everything below follows from
 * that. Each line is appended the moment it arrives, synchronously, with no
 * buffer: a buffer is exactly what a crash throws away. A file written only on
 * STOP would pass every test that stops first and fail the only case that
 * matters.
 *
 * One file per session, JSON Lines, never rewritten:
 *
 *   {"v":1,"kind":"session","id":…,"startedAt":…,"app":"0.8.0","languages":{…},"translates":true}
 *   {"v":1,"kind":"line","n":1,"id":42,"t":…,"source":"push B","latency":{"stt":410}}
 *   {"v":1,"kind":"tr","n":1,"id":42,"t":…,"target":"B'ye geliyorlar","latency":{…}}
 *
 * A translation is its own record rather than a rewrite of its line, because
 * the relay emits one utterance twice (the line, then the line again carrying
 * `target`) and rewriting would mean holding the line until its twin arrives.
 * The reader merges them. A file cut off mid-record by a crash still reads:
 * every complete line before the damage survives.
 *
 * Nothing here imports Electron, so all of it runs under plain Node in tests.
 * main.ts supplies the folder, which is where app.getPath lives.
 */

const FORMAT = 1;
const EXT = ".jsonl";

/**
 * How long after STOP a translation still in flight may reach its file. STOP
 * lets the last utterance finish; its translation is a separate round trip and
 * can land after the session has closed.
 */
const LATE_TRANSLATION_MS = 30_000;

/**
 * A session id is its local start time to the second, with a suffix when two
 * start in the same second. It is also the file name, and the renderer names
 * transcripts by it - so this pattern is the whole of the defence against an
 * id that climbs out of the folder. It admits no separator, no dot and no
 * drive letter.
 */
const ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{1,3})?$/;

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

export function sessionIdFor(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

/** the file a session id names, or undefined for anything that is not one */
export function transcriptFile(dir: string, id: unknown): string | undefined {
  if (!isSessionId(id)) return undefined;
  const file = path.join(dir, id + EXT);
  // the pattern already rules this out; checked anyway because a mistake here
  // hands fs.rmSync a path of the renderer's choosing
  return path.resolve(path.dirname(file)) === path.resolve(dir) ? file : undefined;
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

export interface TranscriptWriterOptions {
  /** the folder a NEW file goes into - read when the file is created */
  dir: () => string;
  /** SETTINGS → SAVE TRANSCRIPTS. Read on every line, so OFF stops the next one. */
  enabled: () => boolean;
  appVersion: string;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /**
   * status() has changed: a session opened or closed, its file appeared, or a
   * write started failing or recovered. Not called per line. The app shows
   * SAVING / NOT SAVING from a status push, and a write that starts failing
   * half-way through a session is exactly the change nothing else announces.
   */
  onChange?: () => void;
}

interface Session {
  startedAt: number;
  languages: Languages;
  translates: boolean;
  /** set by the first line that reaches the disk */
  id?: string;
  file?: string;
  /** the last `n` written */
  n: number;
  /** relay segment id -> `n` of the latest line carrying it */
  byId: Map<number, number>;
}

export class TranscriptWriter {
  private current: Session | null = null;
  /** the session STOP just closed, kept for a translation still in flight */
  private recent: { session: Session; closedAt: number } | null = null;
  private error: string | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: TranscriptWriterOptions) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * A session is starting. Creates nothing on disk: the first line does that,
   * so a START that fails leaves no empty file behind. A second open() while
   * one is already open is a reconnect inside the same session, not a new one.
   */
  open(meta: { languages: Languages; translates: boolean }): void {
    if (this.current) return;
    this.recent = null;
    this.error = undefined;
    this.current = {
      startedAt: this.now(),
      languages: { ...meta.languages },
      translates: meta.translates,
      n: 0,
      byId: new Map(),
    };
    this.changed();
  }

  close(): void {
    const had = this.current !== null;
    if (this.current?.file) this.recent = { session: this.current, closedAt: this.now() };
    this.current = null;
    if (had) this.changed();
  }

  /** never throws: a disk that cannot be written must not cost anyone a caption */
  write(line: TranscriptLine): void {
    if (!this.opts.enabled()) return;
    if (line.target === undefined) {
      if (this.current) this.appendLine(this.current, line);
      return;
    }
    const session = this.sessionFor(line.id);
    if (session) this.appendTranslation(session, line);
  }

  status(): TranscriptStatus {
    const dir = this.current?.file ? path.dirname(this.current.file) : this.opts.dir();
    if (!this.opts.enabled()) return { state: "off", dir };
    if (this.error) return { state: "failed", dir, session: this.current?.id, error: this.error };
    if (this.current) return { state: "saving", dir, session: this.current.id };
    return { state: "idle", dir };
  }

  private sessionFor(id: number): Session | null {
    if (this.current?.byId.has(id)) return this.current;
    const r = this.recent;
    if (r && this.now() - r.closedAt <= LATE_TRANSLATION_MS && r.session.byId.has(id)) return r.session;
    return this.current;
  }

  private appendLine(s: Session, line: TranscriptLine): void {
    const n = s.n + 1;
    const rec: Record<string, unknown> = { v: FORMAT, kind: "line", n, id: line.id, t: this.now(), source: line.source };
    // only on the fallback below: a translation whose line never made it to disk
    if (line.target !== undefined) rec.target = line.target;
    if (line.channel !== undefined) rec.channel = line.channel;
    if (line.speaker !== undefined) rec.speaker = line.speaker;
    if (line.color !== undefined) rec.color = line.color;
    if (line.latency) rec.latency = line.latency;
    if (!this.append(s, rec)) return;
    s.n = n;
    s.byId.set(line.id, n);
  }

  private appendTranslation(s: Session, line: TranscriptLine): void {
    const n = s.byId.get(line.id);
    // its line was never written - saving switched on mid-utterance, or that
    // write failed. Keep the translation as a whole line rather than drop it.
    if (n === undefined) return this.appendLine(s, line);
    const rec: Record<string, unknown> = { v: FORMAT, kind: "tr", n, id: line.id, t: this.now(), target: line.target };
    if (line.latency) rec.latency = line.latency;
    this.append(s, rec);
  }

  /** a listener that throws - a window already destroyed on quit - must not cost a line */
  private changed(): void {
    try {
      this.opts.onChange?.();
    } catch {
      /* noop */
    }
  }

  private append(s: Session, rec: Record<string, unknown>): boolean {
    let created = false;
    try {
      if (!s.file) {
        const dir = this.opts.dir();
        fs.mkdirSync(dir, { recursive: true });
        const { id, file } = claim(dir, s.startedAt);
        const header: TranscriptHeader = {
          v: FORMAT,
          kind: "session",
          id,
          startedAt: s.startedAt,
          app: this.opts.appVersion,
          languages: s.languages,
          translates: s.translates,
        };
        // "wx": fail rather than append onto a file another session claimed
        fs.writeFileSync(file, JSON.stringify(header) + "\n", { flag: "wx" });
        s.id = id;
        s.file = file;
        created = true;
      }
      fs.appendFileSync(s.file, JSON.stringify(rec) + "\n");
      const recovered = this.error !== undefined;
      if (recovered) this.opts.log?.("info", `transcript saving resumed in ${path.dirname(s.file)}`);
      this.error = undefined;
      if (created || recovered) this.changed();
      return true;
    } catch (err) {
      const message = String((err as Error)?.message || err);
      // once per distinct reason, not once per line
      if (message !== this.error) {
        this.opts.log?.("error", `transcript line not saved: ${message}`);
        this.error = message;
        this.changed();
      } else if (created) {
        // the header landed and the line did not: status now names a file
        this.changed();
      }
      return false;
    }
  }
}

function claim(dir: string, startedAt: number): { id: string; file: string } {
  const base = sessionIdFor(startedAt);
  for (let k = 1; k < 1000; k++) {
    const id = k === 1 ? base : `${base}-${k}`;
    const file = path.join(dir, id + EXT);
    if (!fs.existsSync(file)) return { id, file };
  }
  throw new Error(`no free transcript name for ${base}`);
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function parse(id: string, text: string): Transcript {
  let header: TranscriptHeader | undefined;
  const rows: TranscriptRow[] = [];
  const byN = new Map<number, TranscriptRow>();
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(raw);
    } catch {
      // a record a crash cut off, or damage mid-file: skip it, keep the rest
      continue;
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
    if (rec.kind === "session") {
      if (!header) header = rec as unknown as TranscriptHeader;
    } else if (rec.kind === "line" && typeof rec.source === "string" && typeof rec.n === "number") {
      const row: TranscriptRow = { n: rec.n, id: num(rec.id), t: num(rec.t), source: rec.source };
      if (typeof rec.target === "string") row.target = rec.target;
      if (typeof rec.channel === "number") row.channel = rec.channel;
      if (typeof rec.speaker === "string") row.speaker = rec.speaker;
      if (typeof rec.color === "string") row.color = rec.color;
      if (rec.latency && typeof rec.latency === "object") row.latency = rec.latency as SubtitleLatency;
      rows.push(row);
      byN.set(row.n, row);
    } else if (rec.kind === "tr" && typeof rec.n === "number" && typeof rec.target === "string") {
      const row = byN.get(rec.n);
      if (!row) continue;
      row.target = rec.target;
      if (rec.latency && typeof rec.latency === "object") row.latency = rec.latency as SubtitleLatency;
    }
  }
  return { id, header, rows };
}

export function readTranscript(dir: string, id: unknown): Transcript | undefined {
  const file = transcriptFile(dir, id);
  if (!file) return undefined;
  try {
    return parse(id as string, fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** every session in the folder, newest first; [] for a folder not there yet */
export function listTranscripts(dir: string): TranscriptSummary[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: TranscriptSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(EXT)) continue;
    const id = name.slice(0, -EXT.length);
    if (!isSessionId(id)) continue;
    const file = path.join(dir, name);
    let text: string;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const t = parse(id, text);
    const startedAt = t.header?.startedAt ?? t.rows[0]?.t ?? stat.mtimeMs;
    out.push({
      id,
      startedAt,
      endedAt: t.rows.length ? t.rows[t.rows.length - 1].t : startedAt,
      lines: t.rows.length,
      bytes: stat.size,
      languages: t.header?.languages,
    });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

const hms = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};
const srtTime = (ms: number): string => {
  const safe = Math.max(0, Math.round(ms));
  return `${hms(safe)},${pad(safe % 1000, 3)}`;
};
const startOf = (t: Transcript): number => t.header?.startedAt ?? t.rows[0]?.t ?? 0;
const said = (r: TranscriptRow): string => (r.speaker ? `${r.speaker}: ` : "") + r.source;

// CRLF throughout: this is a Windows app, and both files are opened by
// whatever Windows hands them to - Notepad, a video editor, a subtitle tool
const EOL = "\r\n";

/** readable text, each line stamped with its time into the session */
export function toText(t: Transcript): string {
  const start = startOf(t);
  const out = [`Callout Relay transcript - ${new Date(start).toLocaleString()}`];
  if (t.header?.translates) out.push(`${t.header.languages.source} -> ${t.header.languages.target}`);
  out.push("");
  for (const r of t.rows) {
    const stamp = `[${hms(r.t - start)}]`;
    out.push(`${stamp} ${said(r)}`);
    if (r.target) out.push(`${" ".repeat(stamp.length + 1)}${r.target}`);
  }
  return out.join(EOL) + EOL;
}

/** a cue shows until the next one starts, within these bounds */
const MIN_CUE_MS = 1000;
const MAX_CUE_MS = 6000;
const LAST_CUE_MS = 4000;

/** SubRip, with the translation as the cue's second line */
export function toSrt(t: Transcript): string {
  const start = startOf(t);
  const cues = t.rows.map((r, i) => {
    const from = r.t - start;
    const next = t.rows[i + 1];
    const until = next ? next.t - start : from + LAST_CUE_MS;
    const to = Math.min(Math.max(until, from + MIN_CUE_MS), from + MAX_CUE_MS);
    const text = [said(r)];
    if (r.target) text.push(r.target);
    return [String(i + 1), `${srtTime(from)} --> ${srtTime(to)}`, ...text].join(EOL);
  });
  return cues.join(EOL + EOL) + EOL;
}

/**
 * UTF-8 with a byte-order mark. Without one, older Windows tools - and several
 * subtitle editors still in use - read the file in the system code page, and
 * every Vietnamese diacritic arrives as mojibake.
 */
const BOM = "﻿";

/** write a readable copy beside the transcript; the file written, or undefined */
export function exportTranscript(dir: string, id: unknown, format: "txt" | "srt"): string | undefined {
  const t = readTranscript(dir, id);
  if (!t) return undefined;
  const file = path.join(dir, `${t.id}.${format}`);
  try {
    fs.writeFileSync(file, BOM + (format === "srt" ? toSrt(t) : toText(t)), "utf8");
    return file;
  } catch {
    return undefined;
  }
}

/** remove a transcript, and the readable copies exported from it */
export function deleteTranscript(dir: string, id: unknown): boolean {
  const file = transcriptFile(dir, id);
  if (!file) return false;
  try {
    fs.rmSync(file);
  } catch {
    return false;
  }
  for (const ext of [".txt", ".srt"]) {
    try {
      fs.rmSync(path.join(dir, `${id as string}${ext}`), { force: true });
    } catch {
      /* a copy that will not go does not undo the delete */
    }
  }
  return true;
}
