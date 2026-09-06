import {
  ServerToPublisher,
  PublisherToServer,
  SpeakerTag,
} from "@callout-relay/shared";

/** the publisher "hello" (everything the relay needs to build a session) */
export type PublisherHello = Omit<Extract<PublisherToServer, { type: "hello" }>, "type">;

/**
 * Publisher-side relay client. Uses the native WebSocket global so it runs
 * in the Electron renderer and in Node >= 21 unchanged.
 *
 * Auto-reconnects with backoff; audio sent while disconnected is dropped
 * (lost comms can't be translated late anyway).
 */
export class RelayPublisherClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private hello: PublisherHello = {
    stt: "deepgram-nova-3",
    translation: "gemini-3.1-flash-lite",
    languages: { source: "en", target: "vi" },
    translationEnabled: true,
    latencyVisible: true,
    profanityFilter: true,
  };

  state: "idle" | "connecting" | "connected" | "disconnected" | "error" = "idle";

  constructor(
    private readonly url: string,
    private readonly hooks: {
      onState?: (state: RelayPublisherClient["state"], detail?: string) => void;
      onReady?: () => void;
      onError?: (message: string) => void;
      /** live subtitles echoed back by the relay (source + translation + latency + speaker tag) */
      onSubtitle?: (seg: { id: number; source: string; target?: string; latency?: { stt?: number; translate?: number } } & SpeakerTag) => void;
      /** interim (not yet final) transcript for the upcoming segment */
      onPartial?: (seg: { id: number; source: string } & SpeakerTag) => void;
    } = {},
  ) {}

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(hello: PublisherHello): void {
    this.stopped = false;
    this.hello = hello;
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
    // same reasoning as UplinkClient.open: an armed retry or a still-live
    // socket would leave a second connection nothing owns, since its onclose
    // bails out once `this.ws` has moved on
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const previous = this.ws;
    this.ws = null;
    if (previous) {
      try {
        previous.close(1000, "reconnecting");
      } catch {
        /* already gone */
      }
    }
    this.setState("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.scheduleRetry(String((err as Error).message || err));
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.send({
        type: "hello",
        stt: this.hello.stt,
        translation: this.hello.translation,
        languages: this.hello.languages,
        translationEnabled: this.hello.translationEnabled,
        latencyVisible: this.hello.latencyVisible,
        profanityFilter: this.hello.profanityFilter,
        channels: this.hello.channels,
        channelLabels: this.hello.channelLabels,
        channelColors: this.hello.channelColors,
      });
    };

    ws.onmessage = (ev: MessageEvent) => {
      let msg: ServerToPublisher;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "ready") {
        this.attempt = 0;
        this.setState("connected");
        this.hooks.onReady?.();
        this.startPing();
      } else if (msg.type === "partial") {
        this.hooks.onPartial?.({ id: msg.id, source: msg.source, channel: msg.channel, speaker: msg.speaker, color: msg.color });
      } else if (msg.type === "subtitle") {
        this.hooks.onSubtitle?.({
          id: msg.id,
          source: msg.source,
          target: msg.target,
          latency: msg.latency,
          channel: msg.channel,
          speaker: msg.speaker,
          // rebuilt field by field, so anything new on SpeakerTag has to be
          // named here too - the type alone will not carry it
          color: msg.color,
        });
      } else if (msg.type === "error") {
        this.hooks.onError?.(msg.message);
      }
    };

    ws.onclose = (ev: CloseEvent) => {
      this.stopPing();
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) {
        this.setState("idle");
        return;
      }
      // 4409 = kicked off by a replacement; don't fight it
      if (ev.code === 4409) {
        this.setState("error", "replaced by another session");
        this.hooks.onError?.("replaced by another publisher session");
        return;
      }
      if (ev.code === 4401) {
        this.setState("error", "bad relay token");
        this.hooks.onError?.("relay rejected the publisher token");
        return;
      }
      this.scheduleRetry(`closed (${ev.code})`);
    };

    ws.onerror = () => {
      if (this.ws === ws) this.setState("disconnected");
    };
  }

  private scheduleRetry(detail: string): void {
    this.setState("disconnected", detail);
    const delay = Math.min(10000, 1000 * 2 ** Math.min(this.attempt, 3));
    this.attempt += 1;
    // never leave two armed at once
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), 15000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private setState(state: RelayPublisherClient["state"], detail?: string): void {
    this.state = state;
    this.hooks.onState?.(state, detail);
  }

  send(msg: PublisherToServer): void {
    if (this.connected) this.ws!.send(JSON.stringify(msg));
  }

  /** chunk = s16le 16 kHz, mono or interleaved stereo (whatever the hello's `channels` said) */
  sendAudio(chunk: ArrayBufferLike): void {
    if (this.connected) this.ws!.send(chunk);
  }

  updateHello(hello: RelayPublisherClient["hello"]): void {
    this.hello = { ...this.hello, ...hello };
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    this.stopPing();
    if (ws) {
      try {
        ws.close(1000, "client stop");
      } catch {
        /* noop */
      }
    }
    this.setState("idle");
  }
}
