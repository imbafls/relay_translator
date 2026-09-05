import { Languages, ServerToUplink, UplinkToServer } from "@callout-relay/shared";
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
  private hello: { languages: Languages; translates: boolean; since?: number } = {
    languages: { source: "en", target: "vi" },
    translates: true,
  };
  private pingSentAt = 0;

  state: "idle" | "connecting" | "connected" | "disconnected" | "error" = "idle";
  /** last ping round-trip to the remote relay (ms), undefined until measured */
  rttMs: number | undefined;
  /** viewers attached to the remote relay (reported by it) */
  remoteViewers = 0;

  constructor(
    private readonly url: string,
    private readonly hooks: {
      onState?: (state: UplinkClient["state"], detail?: string) => void;
      /** remote viewer count / RTT changed */
      onStats?: (stats: { remoteViewers: number; rttMs?: number }) => void;
    } = {},
  ) {}

  get connected(): boolean {
    const ws = this.ws as (WebSocket & { OPEN?: number }) | null;
    if (!ws) return false;
    const openConst = (getWebSocketImpl() as unknown as { OPEN: number }).OPEN ?? 1;
    return ws.readyState === openConst;
  }

  connect(hello: { languages: Languages; translates: boolean; since?: number }): void {
    this.stopped = false;
    this.hello = hello;
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
    // A retry may already be armed and the previous socket may still be live.
    // Leaving either alone opens a second connection to the relay that nothing
    // owns: its onclose bails out because `this.ws` has moved on, so it is
    // never retried and never closed, and it holds until the relay drops it.
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const previous = this.ws;
    // cleared first, so the old socket's onclose sees it is no longer current
    this.ws = null;
    if (previous) {
      try {
        previous.close(1000, "reconnecting");
      } catch {
        /* already gone */
      }
    }
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
      this.send({
        type: "hello",
        languages: this.hello.languages,
        translates: this.hello.translates,
        since: this.hello.since,
      });
      this.setState("connected");
      this.startPing();
    };

    ws.onmessage = (ev: MessageEvent) => {
      let msg: ServerToUplink;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "error") this.setState("error", msg.message);
      else if (msg.type === "pong") {
        if (this.pingSentAt) this.rttMs = Math.max(0, Date.now() - this.pingSentAt);
        this.hooks.onStats?.({ remoteViewers: this.remoteViewers, rttMs: this.rttMs });
      } else if (msg.type === "viewers") {
        this.remoteViewers = Number(msg.count) || 0;
        this.hooks.onStats?.({ remoteViewers: this.remoteViewers, rttMs: this.rttMs });
      }
    };

    ws.onclose = (ev: CloseEvent) => {
      this.stopPing();
      if (this.ws !== ws) return;
      this.ws = null;
      this.remoteViewers = 0;
      this.rttMs = undefined;
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
    // never leave two armed at once
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private startPing(): void {
    this.stopPing();
    const ping = (): void => {
      this.pingSentAt = Date.now();
      this.send({ type: "ping" });
    };
    ping();
    this.pingTimer = setInterval(ping, 20000);
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

  sendHello(hello: { languages: Languages; translates: boolean; since?: number }): void {
    this.hello = hello;
    this.send({ type: "hello", ...hello });
  }

  sendSubtitle(msg: Extract<UplinkToServer, { type: "subtitle" }>): void {
    this.send(msg);
  }

  sendStatus(live: boolean, message?: string, since?: number): void {
    this.send({ type: "status", live, message, since });
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
