import WebSocket, { RawData } from "ws";
export const SAMPLE_RATE = 16000;

export interface SttEvents {
  onOpen?: () => void;
  /** channel = capture channel (0 when mono) */
  onPartial?: (text: string, channel: number) => void;
  /** audioEndSec = position of the final word in the audio stream (seconds) */
  onFinal?: (text: string, meta: { audioEndSec?: number; channel: number }) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
}

export interface SttStream {
  /**
   * s16le 16 kHz, mono or interleaved by channel count (see SttConfig.channels).
   * Returns whether the chunk actually went to the engine: a stream that has
   * closed under us drops it, and the caller must not bill for audio nobody
   * transcribed.
   */
  sendAudio(chunk: Buffer): boolean;
  close(): void;
}

export interface SttConfig {
  apiKey?: string;
  model: string;
  language: string;
  /** 1 (default) or 2 interleaved channels, each transcribed on its own */
  channels?: number;
}

/**
 * Map config model id -> Deepgram request params.
 * "deepgram-nova-3" -> model=nova-3, "deepgram-nova-3-multi" -> language=multi, etc.
 * Two channels turn on `multichannel`, which transcribes each channel
 * independently (and bills each one) - the way voice chat and mic stay apart.
 */
function dgParams(model: string, language: string, channels: number): URLSearchParams {
  const id = model.startsWith("deepgram-") ? model.slice("deepgram-".length) : model;
  const isMulti = id.endsWith("-multi");
  const name = isMulti ? id.slice(0, -"-multi".length) : id;
  const params = new URLSearchParams({
    model: name,
    punctuate: "true",
    smart_format: "true",
    interim_results: "true",
    endpointing: "300",
    utterance_end_ms: "1000",
    encoding: "linear16",
    sample_rate: String(SAMPLE_RATE),
    channels: String(channels),
  });
  if (channels > 1) params.set("multichannel", "true");
  params.set("language", isMulti ? "multi" : language || "en");
  return params;
}

/**
 * Where a final sits on the audio clock, in seconds from the start of the
 * stream. This is what the latency badge is measured against.
 *
 * Deepgram's word timings are ALREADY absolute offsets on that clock - the
 * same one `start` is on - so the old `start + last.end` roughly doubled the
 * position. session.ts subtracts this from the true wall elapsed, which made
 * the badge collapse to `trueLatency - start * 1000`: honest only while the
 * stream was younger than the latency itself, then clamped to 0 forever. A
 * real session log showed "stt 0ms" on ~120 consecutive captions with one
 * reading of 962ms, on the first final a second in.
 *
 * Exported because it is the whole defect, and a test that re-implemented this
 * arithmetic instead of calling it would pass against the bug.
 */
export function finalAudioEndSec(msg: {
  start?: unknown;
  channel?: { start?: unknown; alternatives?: { words?: { end?: unknown }[] }[] };
}): number | undefined {
  const words = msg.channel?.alternatives?.[0]?.words || [];
  const last = words[words.length - 1];
  if (typeof last?.end === "number") return last.end;
  // a final with no word timings still knows where its segment began
  if (typeof msg.start === "number") return msg.start;
  if (typeof msg.channel?.start === "number") return msg.channel.start;
  return undefined;
}

export function createDeepgramStream(cfg: SttConfig, events: SttEvents): SttStream {
  const channels = cfg.channels && cfg.channels > 1 ? cfg.channels : 1;
  const params = dgParams(cfg.model, cfg.language, channels);
  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  const ws = new WebSocket(url, {
    headers: { Authorization: `Token ${cfg.apiKey || ""}` },
    handshakeTimeout: 8000,
  });
  let closedByUs = false;

  ws.on("open", () => events.onOpen?.());
  ws.on("message", (data: RawData) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type !== "Results") return;
      const alt = msg.channel?.alternatives?.[0];
      const text: string = (alt?.transcript || "").trim();
      if (!text) return;
      const channel = Array.isArray(msg.channel_index) ? Number(msg.channel_index[0]) || 0 : 0;
      if (msg.is_final) {
        events.onFinal?.(text, { audioEndSec: finalAudioEndSec(msg), channel });
      } else {
        events.onPartial?.(text, channel);
      }
    } catch {
      // ignore malformed frames
    }
  });
  ws.on("error", (err: Error) => {
    // symmetric with the close guard below: a socket we closed on purpose
    // aborts its own handshake, and ws reports that abort as an error. That is
    // our teardown, not Deepgram failing, and it must not reach the app.
    if (closedByUs) return;
    events.onError?.(err.message);
  });
  ws.on("close", () => {
    if (!closedByUs) events.onClose?.();
  });

  return {
    sendAudio(chunk: Buffer): boolean {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(chunk, { binary: true });
      return true;
    },
    close() {
      closedByUs = true;
      try {
        ws.close();
      } catch {
        /* noop */
      }
    },
  };
}

const MOCK_LINES = [
  "Rush B, don't stop",
  "One enemy on A site, watching the angle",
  "Enemy down mid, rotate now",
  "Clutch time, two left",
  "Save it, they have ops",
  "I'm pushed up close on heaven",
];

/**
 * Mock STT for dev/smoke tests: emits canned finals paced by audio volume
 * so the whole pipeline runs without a Deepgram key. With two channels the
 * lines alternate between them.
 *
 * `lines` overrides what it says. The default set is clean gameplay callouts,
 * which is right for the smoke run but means a test cannot exercise anything
 * that depends on WHAT was said - the caption filter could be unwired entirely
 * and a fixed-line mock would never notice.
 */
export function createMockSttStream(
  events: SttEvents,
  channels = 1,
  lines: readonly string[] = MOCK_LINES,
): SttStream {
  let bytesSeen = 0;
  const bytesPerLine = SAMPLE_RATE * 2 * channels * 2; // 2 s of audio
  let nextAt = bytesPerLine;
  let line = 0;
  let opened = false;

  setImmediate(() => {
    opened = true;
    events.onOpen?.();
  });

  return {
    sendAudio(chunk: Buffer): boolean {
      if (!opened) return false;
      bytesSeen += chunk.length;
      if (bytesSeen >= nextAt) {
        const text = lines[line % lines.length];
        const channel = channels > 1 ? line % channels : 0;
        line += 1;
        events.onPartial?.(text, channel);
        // the real engines always report where the final sits on the audio
        // clock; the mock has to as well or it hides every timing bug
        events.onFinal?.(text, { audioEndSec: bytesSeen / (SAMPLE_RATE * 2 * channels), channel });
        nextAt = bytesSeen + bytesPerLine;
      }
      return true;
    },
    close() {
      opened = false;
    },
  };
}
