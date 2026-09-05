import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AppConfig, DEFAULT_CONFIG } from "@callout-relay/shared";

export function defaultDataDir(): string {
  if (process.env.CALLOUT_RELAY_DATA) return process.env.CALLOUT_RELAY_DATA;
  const base = process.env.APPDATA || path.join(os.homedir(), ".config");
  return path.join(base, "callout-relay");
}

/**
 * Config file lives in the data dir; secrets can also come from env.
 * Unknown keys are preserved so version skew never wipes user settings.
 */
export class ConfigStore {
  private cached: AppConfig | null = null;

  constructor(readonly dataDir: string = defaultDataDir()) {}

  private get file(): string {
    return path.join(this.dataDir, "config.json");
  }

  load(): AppConfig {
    let stored: Partial<AppConfig> = {};
    try {
      const raw = fs.readFileSync(this.file, "utf8").replace(/^\uFEFF/, "");
      stored = JSON.parse(raw);
    } catch {
      console.warn(`[companion] config file unreadable, using defaults: ${this.file}`);
    }
    this.cached = this.merge(DEFAULT_CONFIG, stored);
    // migration: pre-0.3 configs chose OBS with a boolean instead of `output`
    if (stored.output === undefined && stored.obsOverlay === true) {
      this.cached.output = "obs";
    }
    // migration: pre-0.4 configs had no setup flag; a saved Deepgram key means
    // onboarding was completed once
    if (stored.setupDone === undefined && (stored.deepgramApiKey || process.env.DEEPGRAM_API_KEY)) {
      this.cached.setupDone = true;
    }
    return this.cached;
  }

  get(): AppConfig {
    return this.cached || this.load();
  }

  update(patch: Partial<AppConfig>): AppConfig {
    this.cached = this.merge(this.get(), patch);
    this.persist();
    return this.cached;
  }

  persist(): void {
    if (!this.cached) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cached, null, 2), "utf8");
  }

  private merge(base: AppConfig, patch: Partial<AppConfig>): AppConfig {
    const out: AppConfig = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (key === "languages" && value && typeof value === "object") {
        out.languages = { ...base.languages, ...(value as Partial<AppConfig["languages"]>) };
      } else {
        (out as unknown as Record<string, unknown>)[key] = value;
      }
    }
    // env fallback for secrets
    if (!out.deepgramApiKey && process.env.DEEPGRAM_API_KEY) {
      out.deepgramApiKey = process.env.DEEPGRAM_API_KEY;
    }
    if (!out.geminiApiKey && process.env.GEMINI_API_KEY) {
      out.geminiApiKey = process.env.GEMINI_API_KEY;
    }
    return out;
  }
}
