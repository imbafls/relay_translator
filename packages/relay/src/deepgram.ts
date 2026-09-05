import WebSocket, { RawData } from "ws";
export const SAMPLE_RATE = 16000;

export interface SttEvents {
  onOpen?: () => void;
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
}

export interface SttStream {
  sendAudio(chunk: Buffer): void;
  close(): void;
}

export interface SttConfig {
  apiKey?: string;
  model: string;
  language: string;
}

/**
 * Map config model id -> Deepgram request params.
 * "deepgram-nova-3" -> model=nova-3, "deepgram-nova-3-multi" -> language=multi, etc.
 */
function dgParams(model: string, language: string): URLSearchParams {
  const id = model.startsWith("deepgram-") ? model.slice("deepgram-".length) : model;
  const [name, variant] = id.split("-");
  const isMulti = variant === "multi";
  const params = new URLSearchParams({
    model: name,
    punctuate: "true",
    smart_format: "true",
    interim_results: "true",
    endpointing: "300",
    utterance_end_ms: "1000",
    encoding: "linear16",
    sample_rate: String(SAMPLE_RATE),
    channels: "1",
  });
  params.set("language", isMulti ? "multi" : language || "en");
  return params;
}

export function createDeepgramStream(cfg: SttConfig, events: SttEvents): SttStream {
  const params = dgParams(cfg.model, cfg.language);
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
      if (msg.is_final) events.onFinal?.(text);
      else events.onPartial?.(text);
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
 * so the whole pipeline runs without a Deepgram key.
 */
export function createMockSttStream(events: SttEvents): SttStream {
  let bytesSeen = 0;
  let nextAt = SAMPLE_RATE * 2; // 2s of audio before first line
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
        const text = MOCK_LINES[line % MOCK_LINES.length];
        line += 1;
        events.onPartial?.(text);
        events.onFinal?.(text);
        nextAt = bytesSeen + SAMPLE_RATE * 2;
      }
    },
    close() {
      opened = false;
    },
  };
}
