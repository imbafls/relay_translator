import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AppConfig, DEFAULT_CONFIG, resolveSourceIds } from "@callout-relay/shared";

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
    this.cached = syncSources(this.cached, {}, resolveSourceIds(this.cached));
    return this.withEnv(this.cached);
  }

  /**
   * The config as callers should see it: what is stored, plus any secret the
   * environment supplies for a field that has none.
   *
   * This is deliberately not what gets written. The fallback used to live in
   * `merge()`, which `update()` runs before `persist()`, so it applied on the
   * write path: clearing a key in KEYS sent `""`, the fallback saw a falsy
   * value and put the environment's key back, and `persist` wrote it to
   * config.json. The field refilled itself and there was no way to clear a key
   * from the app - and any unrelated save copied an env-only secret into the
   * file, where it outlived the environment and quietly won over a rotated one.
   */
  private withEnv(cfg: AppConfig): AppConfig {
    const out = { ...cfg };
    if (!out.deepgramApiKey && process.env.DEEPGRAM_API_KEY) {
      out.deepgramApiKey = process.env.DEEPGRAM_API_KEY;
    }
    if (!out.geminiApiKey && process.env.GEMINI_API_KEY) {
      out.geminiApiKey = process.env.GEMINI_API_KEY;
    }
    return out;
  }

  get(): AppConfig {
    return this.cached ? this.withEnv(this.cached) : this.load();
  }

  update(patch: Partial<AppConfig>): AppConfig {
    // merge into what is stored, never into the env-applied view, or the
    // environment's value is what gets persisted
    if (!this.cached) this.load();
    const before = resolveSourceIds(this.cached as AppConfig);
    this.cached = this.merge(this.cached as AppConfig, patch);
    this.cached = syncSources(this.cached, patch, before);
    this.persist();
    return this.withEnv(this.cached);
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

    return out;
  }
}

/**
 * Keep `sources` and the deprecated audioSource/audioSource2 pair telling the
 * same story after a patch.
 *
 * The pair is not dead weight: it is what the Stream Deck property inspector
 * writes through the control API, and such a patch arrives with no `sources`
 * in it at all. Merged and left alone it would sit beside a list that
 * resolveSourceIds prefers, so a Stream Deck key press would appear to do
 * nothing - or worse, revert a source the user had just chosen.
 *
 * A legacy patch names a SLOT, not the whole list. An old client patching
 * `audioSource` is saying "slot 0 is this"; it has no idea a third slot exists,
 * so it cannot be asking to delete one. Higher slots survive.
 */
function syncSources(cfg: AppConfig, patch: Partial<AppConfig>, before: string[]): AppConfig {
  const out = { ...cfg };
  const namesList = Object.prototype.hasOwnProperty.call(patch, "sources");
  const legacySlot: Record<number, string | undefined> = {
    0: Object.prototype.hasOwnProperty.call(patch, "audioSource") ? patch.audioSource : undefined,
    1: Object.prototype.hasOwnProperty.call(patch, "audioSource2") ? patch.audioSource2 : undefined,
  };
  const touchesLegacy = legacySlot[0] !== undefined || legacySlot[1] !== undefined;

  if (!namesList && touchesLegacy) {
    const next = [...before];
    for (const slot of [0, 1]) {
      const value = legacySlot[slot];
      if (value === undefined) continue;
      if (slot < next.length) next[slot] = value;
      else if (value) next.push(value);
    }
    out.sources = next;
  }

  out.sources = resolveSourceIds(out);
  // an older build reads only the pair, so leave it pointing at the first two
  out.audioSource = out.sources[0] ?? "";
  out.audioSource2 = out.sources[1] ?? "";
  return out;
}
