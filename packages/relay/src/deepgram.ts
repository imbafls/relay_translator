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
  /** s16le 16 kHz, mono or interleaved stereo (see SttConfig.channels) */
  sendAudio(chunk: Buffer): void;
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
        const words = alt.words || [];
        const last = words[words.length - 1];
        const base = typeof msg.start === "number" ? msg.start : msg.channel?.start;
        const audioEndSec =
          typeof base === "number" && typeof last?.end === "number" ? base + last.end : undefined;
        events.onFinal?.(text, { audioEndSec, channel });
      } else {
        events.onPartial?.(text, channel);
      }
    } catch {
      // ignore malformed frames
    }
  });
  ws.on("error", (err: Error) => {
    events.onError?.(err.message);
  });
  ws.on("close", () => {
    if (!closedByUs) events.onClose?.();
  });

  return {
    sendAudio(chunk: Buffer) {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
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
    sendAudio(chunk: Buffer) {
      if (!opened) return;
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
    },
    close() {
      opened = false;
    },
  };
}
