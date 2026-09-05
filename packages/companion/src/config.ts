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
    // migration: pre-0.4 configs had one source and no setup flag; a saved
    // Deepgram key means onboarding already ran
    if (!Array.isArray(stored.audioSources) && stored.audioSource) {
      this.cached.audioSources = [stored.audioSource];
    }
    if (stored.setupComplete === undefined && stored.deepgramApiKey) {
      this.cached.setupComplete = true;
    }
    this.cached = this.reconcileSources(this.cached);
    return this.cached;
  }

  /**
   * `audioSource` (primary) and `audioSources` (all) describe one thing:
   * de-duplicate the list and keep the primary equal to its first entry.
   */
  private reconcileSources(cfg: AppConfig): AppConfig {
    const sources = Array.isArray(cfg.audioSources) ? cfg.audioSources : [];
    const unique: string[] = [];
    for (const s of sources) if (typeof s === "string" && s && !unique.includes(s)) unique.push(s);
    if (unique.length === 0) unique.push(cfg.audioSource || DEFAULT_CONFIG.audioSource);
    return { ...cfg, audioSources: unique, audioSource: unique[0] };
  }

  get(): AppConfig {
    return this.cached || this.load();
  }

  update(patch: Partial<AppConfig>): AppConfig {
    const before = this.get();
    const merged = this.merge(before, patch);
    // a single-field patch (Stream Deck inspector, old callers) swaps the
    // primary and keeps the extra sources
    if (patch.audioSource !== undefined && patch.audioSources === undefined) {
      const extras = (before.audioSources || []).slice(1).filter((s) => s !== patch.audioSource);
      merged.audioSources = [patch.audioSource, ...extras];
    }
    this.cached = this.reconcileSources(merged);
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
