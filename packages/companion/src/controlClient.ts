import {
  CONTROL_CLIENT_HEADER,
  CONTROL_PORT,
  ControlStatus,
} from "@callout-relay/shared";

/**
 * Client for the companion control API. Used by the Stream Deck plugin
 * (Node main process) and the property inspector (browser). Works with
 * global fetch + manual SSE parsing, so no dependencies.
 */
export class ControlClient {
  constructor(
    readonly baseUrl: string = `http://127.0.0.1:${CONTROL_PORT}`,
    private readonly clientName = "streamdeck",
  ) {}

  private headers(): Record<string, string> {
    return { [CONTROL_CLIENT_HEADER]: this.clientName, "Content-Type": "application/json" };
  }

  async status(): Promise<ControlStatus> {
    const res = await fetch(`${this.baseUrl}/status`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    return (await res.json()) as ControlStatus;
  }

  async link(): Promise<{ viewerUrl: string | null }> {
    const res = await fetch(`${this.baseUrl}/link`);
    if (!res.ok) throw new Error(`link ${res.status}`);
    return (await res.json()) as { viewerUrl: string | null };
  }

  async start(): Promise<ControlStatus> {
    const res = await fetch(`${this.baseUrl}/start`, { method: "POST", headers: this.headers() });
    if (!res.ok) throw new Error(`start ${res.status}: ${await res.text()}`);
    return (await res.json()) as ControlStatus;
  }

  async stop(): Promise<ControlStatus> {
    const res = await fetch(`${this.baseUrl}/stop`, { method: "POST", headers: this.headers() });
    if (!res.ok) throw new Error(`stop ${res.status}: ${await res.text()}`);
    return (await res.json()) as ControlStatus;
  }

  async patchConfig(patch: Record<string, unknown>): Promise<ControlStatus> {
    const res = await fetch(`${this.baseUrl}/config`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`config ${res.status}: ${await res.text()}`);
    return (await res.json()) as ControlStatus;
  }

  async rotateLink(): Promise<{ viewerUrl: string | null }> {
    const res = await fetch(`${this.baseUrl}/link/rotate`, {
      method: "POST",
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`rotate ${res.status}: ${await res.text()}`);
    return (await res.json()) as { viewerUrl: string | null };
  }

  /**
   * Subscribe to status events (SSE). Returns an unsubscribe fn.
   * Reconnects automatically while not unsubscribed.
   */
  onStatus(cb: (status: ControlStatus) => void): () => void {
    let stopped = false;
    let controller: AbortController | null = null;

    const loop = async (): Promise<void> => {
      while (!stopped) {
        controller = new AbortController();
        try {
          const res = await fetch(`${this.baseUrl}/events`, { signal: controller.signal });
          if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const line = frame.split("\n").find((l) => l.startsWith("data: "));
              if (!line) continue;
              try {
                const evt = JSON.parse(line.slice(6));
                if (evt.type === "status") cb(evt.status as ControlStatus);
              } catch {
                /* ignore malformed frame */
              }
            }
          }
        } catch {
          // server went away - retry after a beat
        }
        if (!stopped) await new Promise((r) => setTimeout(r, 3000));
      }
    };
    loop();

    return () => {
      stopped = true;
      controller?.abort();
    };
  }
}
