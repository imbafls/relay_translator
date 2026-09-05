import { LanguageCode } from "@callout-relay/shared";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  vi: "Vietnamese",
  es: "Spanish",
  pt: "Portuguese",
  fr: "French",
  de: "German",
  ru: "Russian",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  th: "Thai",
  id: "Indonesian",
};

function langName(code: LanguageCode): string {
  return LANGUAGE_NAMES[code] || code;
}

export interface Translator {
  translate(text: string): Promise<string>;
}

export interface GeminiUsageReporter {
  onUse(use: { cached: boolean; tokensIn: number; tokensOut: number }): void;
}

export interface CreateTranslatorOpts {
  apiKey: string;
  model: string;
  source: LanguageCode;
  target: LanguageCode;
  /** abort a single attempt after this long (ms) */
  timeoutMs?: number;
  /** optional usage accounting (cache hits + tokens) */
  stats?: GeminiUsageReporter;
  /** override the API origin (tests, a proxy, a regional endpoint) */
  baseUrl?: string;
  /** backoff before each attempt, ms; the first is always immediate */
  backoffMs?: number[];
}

function systemInstruction(source: LanguageCode, target: LanguageCode): string {
  return [
    `You are a real-time translator for live voice comms in a competitive video game (e.g. Valorant).`,
    `Translate the user's message from ${langName(source)} to ${langName(target)}.`,
    `Rules:`,
    `- Output ONLY the translation, nothing else. No quotes, no notes, no romanization.`,
    `- Keep it short and spoken-style, like a gamer talking mid-round.`,
    `- Preserve gaming jargon and map callouts naturally ("A site", "rush B", "one tapped", "clutch", "eco", "rotate").`,
    `- Use common ${langName(target)} gaming slang where it exists instead of literal translations.`,
    `- Keep proper nouns (agent names, gun names, map names) as-is.`,
    `- If the message is mostly a callout or fragment, translate it as a fragment. Never add punctuation-heavy prose.`,
  ].join("\n");
}

/** normalize for cache keys: gaming callouts repeat with trivial differences */
function cacheKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.!?,;:]+$/, "").trim();
}

/** small LRU with TTL - callouts repeat a lot, so this cuts most API calls */
class TranslationCache {
  private map = new Map<string, { value: string; at: number }>();
  constructor(
    private readonly max = 500,
    private readonly ttlMs = 30 * 60 * 1000,
  ) {}

  get(key: string): string | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // refresh LRU position
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: string): void {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, at: Date.now() });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createGeminiTranslator(opts: CreateTranslatorOpts): Translator {
  const { apiKey, model, source, target, timeoutMs = 6000 } = opts;
  const url = `${opts.baseUrl || API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const cache = new TranslationCache();

  async function attempt(text: string, signal: AbortSignal): Promise<string> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": apiKey,
      },
      signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction(source, target) }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          temperature: 0.15,
          maxOutputTokens: 120,
          // latency: no thinking budget for flash models
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(`gemini ${res.status}: ${detail.slice(0, 200)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
        const data: any = await res.json();
        const parts = data?.candidates?.[0]?.content?.parts;
        const out = Array.isArray(parts)
          ? parts.map((p: any) => p?.text ?? "").join("").trim()
          : "";
        if (!out) {
          // a 200 with no candidates is a safety block or a refusal, and
          // asking again word for word gets the same answer
          const empty = new Error("gemini: empty response") as Error & { permanent?: boolean };
          empty.permanent = true;
          throw empty;
        }
        opts.stats?.onUse({
          cached: false,
          tokensIn: Number(data?.usageMetadata?.promptTokenCount) || 0,
          tokensOut: Number(data?.usageMetadata?.candidatesTokenCount) || 0,
        });
        return out;
  }

  return {
    async translate(text: string): Promise<string> {
      const key = `${source}>${target}:${cacheKey(text)}`;
      const hit = cache.get(key);
      if (hit !== undefined) {
        opts.stats?.onUse({ cached: true, tokensIn: 0, tokensOut: 0 });
        return hit;
      }

      // retry with backoff on 429 (quota) / 5xx - short so latency stays low
      let lastErr: unknown;
      const backoff = opts.backoffMs ?? [0, 1200, 3000];
      for (let i = 0; i < backoff.length; i += 1) {
        if (backoff[i] > 0) await sleep(backoff[i]);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const out = await attempt(text, controller.signal);
          cache.set(key, out);
          return out;
        } catch (err) {
          lastErr = err;
          const e = err as Error & { status?: number; permanent?: boolean };
          // No status means the request never came back with one: a dropped
          // connection, DNS, a timeout abort, a body that would not parse.
          // Those are the most common failures on a live stream and every one
          // of them is worth another go. A 4xx is our fault and never is.
          const retryable =
            e.permanent !== true && (e.status === undefined || e.status === 429 || e.status >= 500);
          if (!retryable) break;
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  };
}

/** Translator used when GEMINI key is missing or mock mode is on. */
export function createMockTranslator(target: LanguageCode): Translator {
  return {
    async translate(text: string): Promise<string> {
      return `[${target}] ${text}`;
    },
  };
}
