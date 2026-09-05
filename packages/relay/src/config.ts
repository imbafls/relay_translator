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
 * Resolve relay tokens: explicit opts > env > state file > generate.
 * State file keeps tokens stable across restarts ("fixed" link mode).
 */
export function loadState(
  dataDir: string,
  opts: { publisherToken?: string; viewerToken?: string },
): RelayState {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "relay-state.json");
  const persisted = readStateFile(file);

  const state: RelayState = {
    publisherToken:
      opts.publisherToken ||
      process.env.RELAY_PUBLISHER_TOKEN ||
      persistedToken(persisted?.publisherToken) ||
      generateToken(),
    viewerToken:
      opts.viewerToken ||
      process.env.RELAY_VIEWER_TOKEN ||
      persistedToken(persisted?.viewerToken) ||
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

/** Minimal dotenv loader so `pnpm dev:relay` picks up the repo root .env. */
export function tryLoadDotenv(dirs: string[]): void {
  for (const dir of dirs) {
    const file = path.join(dir, ".env");
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const [, key, raw] = m;
        const value = raw.replace(/^["']|["']$/g, "");
        if (process.env[key] === undefined) process.env[key] = value;
      }
    } catch {
      // ignore unreadable .env
    }
  }
}
