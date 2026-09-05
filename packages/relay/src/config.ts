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

function readStateFile(file: string): Partial<RelayState> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
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
      persisted?.publisherToken ||
      generateToken(),
    viewerToken:
      opts.viewerToken ||
      process.env.RELAY_VIEWER_TOKEN ||
      persisted?.viewerToken ||
      generateToken(),
  };
  saveState(dataDir, state);
  return state;
}

export function saveState(dataDir: string, state: RelayState): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "relay-state.json");
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
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
