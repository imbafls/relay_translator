import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export interface RelayState {
  publisherToken: string;
  viewerToken: string;
}

export function generateToken(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("hex");
}

function readStateFile(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * We only ever write strings here, but the file is on a box that gets
 * redeployed and restarted, and it can come back hand-edited, copied in from
 * another machine, or half-written. A token that is not a usable string can
 * never equal the one off a query param, so adopting it would bring the relay
 * up refusing every connection it exists to accept - and persist that state.
 */
function persistedToken(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The characters a viewer token may be made of.
 *
 * The same sentence as `persistedToken` above, one layer further along. A
 * viewer token is not only compared against a query param - it is written into
 * the middle of a URL PATH and read back out of one, and both ends of that
 * round trip already fix its alphabet:
 *
 *   - `packages/viewer/public/app.js` takes it off the path with
 *     `/\/watch\/([A-Za-z0-9_-]+)/`, and that file is served as-is with no
 *     build step, so it can import nothing and the class is a literal there.
 *   - `apps/hosted-relay/src/routes.ts` decides whether `/watch/<x>` is a page
 *     or an asset on whether `x` holds a dot, and says so in its own comment.
 *
 * So a token with a dot in it - `team.alpha`, a version, an IP - does not make
 * a link that half works. The relay comes up, serves the page, and refuses
 * every viewer that opens it, because the page asks with the part before the
 * dot. Adopting one persists that state, which is exactly what the note above
 * exists to prevent.
 *
 * The publisher token is deliberately not held to this: it travels as a query
 * parameter, encoded on the way out and decoded on the way in, so it survives
 * characters a path cannot carry.
 */
const VIEWER_TOKEN = /^[A-Za-z0-9_-]+$/;

export function usableViewerToken(value: unknown): string | undefined {
  return typeof value === "string" && VIEWER_TOKEN.test(value) ? value : undefined;
}

/**
 * Resolve relay tokens: explicit opts > env > state file > generate.
 * State file keeps tokens stable across restarts ("fixed" link mode).
 */
export function loadState(
  dataDir: string,
  opts: { publisherToken?: string; viewerToken?: string },
  log?: (level: "info" | "warn" | "error", message: string) => void,
): RelayState {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "relay-state.json");
  const persisted = readStateFile(file);

  /**
   * A refused token is said out loud and then skipped rather than being made
   * to work. Silence here is the bad outcome: whoever set it would watch the
   * relay start cleanly and every viewer be turned away, with the link they
   * chose nowhere in sight.
   */
  const viewer = (value: unknown, where: string): string | undefined => {
    const usable = usableViewerToken(value);
    if (!usable && persistedToken(value)) {
      log?.("warn", `${where} holds a viewer token a link cannot carry (A-Z a-z 0-9 _ - only) - ignoring it`);
    }
    return usable;
  };

  const state: RelayState = {
    publisherToken:
      opts.publisherToken ||
      process.env.RELAY_PUBLISHER_TOKEN ||
      persistedToken(persisted?.publisherToken) ||
      generateToken(),
    viewerToken:
      viewer(opts.viewerToken, "the config this relay was started with") ||
      viewer(process.env.RELAY_VIEWER_TOKEN, "RELAY_VIEWER_TOKEN") ||
      viewer(persisted?.viewerToken, "relay-state.json") ||
      generateToken(),
  };
  saveState(dataDir, state);
  return state;
}

export function saveState(dataDir: string, state: RelayState): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "relay-state.json");
  // write beside it and rename over the top, so a crash or a full disk part
  // way through cannot leave a truncated file - that parses as nothing on the
  // next boot, and everyone's viewer link changes underneath them
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function relayDataDir(): string {
  const base =
    process.env.CALLOUT_RELAY_DATA ||
    (process.env.APPDATA
      ? path.join(process.env.APPDATA, "callout-relay")
      : path.join(require("os").homedir(), ".callout-relay"));
  return base;
}

/**
 * Minimal dotenv loader. Not only a dev convenience: cli.ts runs it on the
 * directory beside the binary, so on the VPS this is what reads
 * /opt/callout-relay/.env and supplies DEEPGRAM_API_KEY and GEMINI_API_KEY. A
 * value read slightly wrong is a key that fails authentication for a reason
 * nothing on the box will explain, so the parsing is deliberately forgiving
 * about how the file was written and strict about what ends up in the value.
 */
export function tryLoadDotenv(dirs: string[]): void {
  for (const dir of dirs) {
    const file = path.join(dir, ".env");
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      // every line ending, not just LF and CRLF: a lone CR is not a line
      // terminator `.` will cross, so one anywhere in the file used to make the
      // regex fail and drop that assignment without a word
      for (const line of text.split(/\r\n|\r|\n/)) {
        //  `(.*?)\s*$` is lazy on purpose. Greedy `.*` swallows trailing
        //  whitespace and leaves `\s*$` matching nothing, so a key pasted with
        //  a space after it kept the space.
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        const key = m[1];
        if (key === undefined) continue;
        // the value group is `(.*?)`, which matches the empty string, so a bare
        // `KEY=` is a real line setting a real empty value - not a parse failure
        const raw = m[2] ?? "";
        // quotes have to match to count, and whatever is inside them is kept
        // verbatim - that is the way to write a value with real spaces in it
        const quoted = /^(["'])([\s\S]*)\1$/.exec(raw);
        const value = quoted?.[2] ?? raw;
        if (process.env[key] === undefined) process.env[key] = value;
      }
    } catch {
      // ignore unreadable .env
    }
  }
}
