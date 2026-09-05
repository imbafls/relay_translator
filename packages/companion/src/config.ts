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

  /** parse one config file, or undefined if it is missing, torn or not an object */
  private read(file: string): Partial<AppConfig> | undefined {
    try {
      const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
      const parsed: unknown = JSON.parse(raw);
      // a bare null, string or array is not a config, and merging one either
      // throws or writes numeric keys into the settings
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      return parsed as Partial<AppConfig>;
    } catch {
      return undefined;
    }
  }

  load(): AppConfig {
    let stored = this.read(this.file);
    if (!stored) {
      // this file holds the user's API keys and their whole setup. Resetting to
      // defaults because a write was cut short loses all of it silently, so the
      // last known-good copy gets a turn first.
      const previous = this.read(`${this.file}.bak`);
      if (previous) {
        console.warn(`[companion] config unreadable, recovered the previous one: ${this.file}`);
        stored = previous;
      } else {
        console.warn(`[companion] config file unreadable, using defaults: ${this.file}`);
        stored = {};
      }
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
    // keep the copy we are about to replace, but only while it still parses,
    // so a good backup is never overwritten by a torn one
    try {
      if (this.read(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    } catch {
      /* a backup is a nicety; failing to make one must not block the save */
    }
    // write beside it and rename over the top: a crash part way through a
    // plain write leaves JSON that does not parse, and that used to read as
    // "no config", taking the user's keys with it
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.cached, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  private merge(base: AppConfig, patch: Partial<AppConfig>): AppConfig {
    const out: AppConfig = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      // `null` is not "leave this alone". It used to pass here, fail the
      // `value &&` test below, and fall through to the wholesale assignment -
      // so a patch of `{languages: null}` overwrote the default and was
      // persisted, and every later boot threw on `config.languages.source`
      // before the app had drawn anything.
      if (value === undefined || value === null) continue;
      if (key === "languages" && value && typeof value === "object") {
        out.languages = { ...base.languages, ...(value as Partial<AppConfig["languages"]>) };
      } else {
        (out as unknown as Record<string, unknown>)[key] = value;
      }
    }
    // A file written before that guard existed, or edited by hand, can still
    // hold a broken `languages` - and the renderer reads it before it draws,
    // so it has to be repaired on the way in rather than merely prevented.
    const langs = out.languages as AppConfig["languages"] | null | undefined;
    if (!langs || typeof langs !== "object" || typeof langs.source !== "string" || typeof langs.target !== "string") {
      out.languages = { ...DEFAULT_CONFIG.languages };
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
