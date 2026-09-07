import * as fs from "fs";
import * as path from "path";

/**
 * The app's log, on disk.
 *
 * `log()` in the desktop app wrote to stdout and nowhere else. A packaged
 * Electron app has no console attached, so every reason it ever gave was
 * discarded the moment it was produced.
 *
 * That is the reason B6 stayed open and unreproducible: the model store records
 * exactly why a download failed - "model download failed: <id> - <message>" -
 * the renderer shows it in a tooltip that vanishes on the next render, and
 * nothing keeps it. A user says "it failed", and there is nothing left to read.
 *
 * Bounded, because this runs for the length of a session and nobody prunes it.
 * When it grows past the cap the oldest half goes, because the interesting line
 * is almost always the last one before someone gave up.
 *
 * It never throws. A read-only directory, a full disk or a locked file is not
 * worth taking the app down for, and the caller still prints to stdout.
 */
export interface FileLog {
  (level: "info" | "warn" | "error", message: string): void;
  close(): void;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;

export function openFileLog(dir: string, opts: { maxBytes?: number } = {}): FileLog {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const file = path.join(dir, "relay.log");
  let broken = false;

  const roll = (): void => {
    try {
      const size = fs.statSync(file).size;
      if (size <= maxBytes) return;
      // keep the newest half. Reading the whole file to trim it is fine at this
      // size and avoids a second file to reason about.
      const kept = fs.readFileSync(file, "utf8").slice(-Math.floor(maxBytes / 2));
      const from = kept.indexOf("\n");
      fs.writeFileSync(file, from >= 0 ? kept.slice(from + 1) : kept);
    } catch {
      /* a log that cannot be trimmed is still a log */
    }
  };

  const write: FileLog = ((level, message) => {
    if (broken) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${message}\n`);
      roll();
    } catch {
      // once, then stop trying: a log that fails every line would turn one bad
      // path into a syscall per message for the rest of the session
      broken = true;
    }
  }) as FileLog;

  write.close = (): void => {
    broken = true;
  };
  return write;
}
