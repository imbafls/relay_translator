import {
  AppConfig,
  ServerToPublisher,
  PublisherToServer,
} from "@callout-relay/shared";

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
  private hello: { stt: string; translation: string; languages: AppConfig["languages"] } = {
    stt: "deepgram-nova-3",
    translation: "gemini-2.5-flash",
    languages: { source: "en", target: "vi" },
  };

  state: "idle" | "connecting" | "connected" | "disconnected" | "error" = "idle";

  constructor(
    private readonly url: string,
    private readonly hooks: {
      onState?: (state: RelayPublisherClient["state"], detail?: string) => void;
      onReady?: () => void;
      onError?: (message: string) => void;
      /** live subtitles echoed back by the relay (source + translation) */
      onSubtitle?: (seg: { id: number; source: string; target?: string }) => void;
    } = {},
  ) {}

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(hello: { stt: string; translation: string; languages: AppConfig["languages"] }): void {
    this.stopped = false;
    this.hello = hello;
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
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
      } else if (msg.type === "subtitle") {
        this.hooks.onSubtitle?.({ id: msg.id, source: msg.source, target: msg.target });
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

  /** chunk must be s16le mono 16 kHz */
  sendAudio(chunk: ArrayBufferLike): void {
    if (this.connected) this.ws!.send(chunk);
  }

  updateHello(hello: RelayPublisherClient["hello"]): void {
    this.hello = hello;
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
