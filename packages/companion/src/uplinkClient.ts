import { Languages, UplinkToServer } from "@callout-relay/shared";
import { getWebSocketImpl } from "./wsImpl";

/**
 * Subtitle uplink: pushes FINISHED subtitles from the local relay to a remote
 * relay for internet fan-out. The remote side does no STT/translation.
 * Auto-reconnects with backoff; messages sent while offline are dropped.
 */
export class UplinkClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private hello: { languages: Languages; translates: boolean } = {
    languages: { source: "en", target: "vi" },
    translates: true,
  };

  state: "idle" | "connecting" | "connected" | "disconnected" | "error" = "idle";

  constructor(
    private readonly url: string,
    private readonly hooks: {
      onState?: (state: UplinkClient["state"], detail?: string) => void;
    } = {},
  ) {}

  get connected(): boolean {
    const ws = this.ws as (WebSocket & { OPEN?: number }) | null;
    if (!ws) return false;
    const openConst = (getWebSocketImpl() as unknown as { OPEN: number }).OPEN ?? 1;
    return ws.readyState === openConst;
  }

  connect(hello: { languages: Languages; translates: boolean }): void {
    this.stopped = false;
    this.hello = hello;
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
    this.setState("connecting");
    const WS = getWebSocketImpl();
    let ws: WebSocket;
    try {
      ws = new WS(this.url) as unknown as WebSocket;
    } catch (err) {
      this.scheduleRetry(String((err as Error).message || err));
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.send({ type: "hello", languages: this.hello.languages, translates: this.hello.translates });
      this.setState("connected");
      this.startPing();
    };

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "error") this.setState("error", msg.message);
      } catch {
        /* noop */
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
      if (ev.code === 4401) {
        this.setState("error", "uplink token rejected");
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
    const delay = Math.min(15000, 1000 * 2 ** Math.min(this.attempt, 4));
    this.attempt += 1;
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), 20000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private setState(state: UplinkClient["state"], detail?: string): void {
    this.state = state;
    this.hooks.onState?.(state, detail);
  }

  private send(msg: UplinkToServer): void {
    if (this.connected) this.ws!.send(JSON.stringify(msg));
  }

  sendHello(hello: { languages: Languages; translates: boolean }): void {
    this.hello = hello;
    this.send({ type: "hello", ...hello });
  }

  sendSubtitle(msg: Extract<UplinkToServer, { type: "subtitle" }>): void {
    this.send(msg);
  }

  sendStatus(live: boolean, message?: string): void {
    this.send({ type: "status", live, message });
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
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
