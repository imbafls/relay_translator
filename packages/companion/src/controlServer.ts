import * as http from "http";
import {
  CONTROL_CLIENT_HEADER,
  CONTROL_PORT,
  ControlStatus,
} from "@callout-relay/shared";

export interface ControlHandlers {
  getStatus(): ControlStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  patchConfig(patch: Record<string, unknown>): Promise<ControlStatus>;
  rotateLink(): Promise<void>;
}

export interface ControlHandle {
  port: number;
  close(): Promise<void>;
  /** push a fresh status to all SSE subscribers */
  broadcast(status: ControlStatus): void;
}

function allowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // node clients / same-origin
  if (origin === "null") return true; // file:// property inspector
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) return true;
  if (origin.startsWith("file://")) return true;
  if (origin.startsWith("chrome-extension://")) return true;
  if (origin.startsWith("streamdeck://")) return true;
  return false;
}

/** AppConfig fields that are credentials rather than settings */
const SECRET_FIELDS = ["deepgramApiKey", "geminiApiKey", "publisherToken", "viewerToken"] as const;
const REDACTED = "***";

/**
 * Status carries the whole AppConfig, secrets included, and the origin check
 * has to allow `null` for the Stream Deck property inspector - which is the
 * same Origin a sandboxed iframe on any website sends. That combination would
 * hand any page that embeds one the Deepgram and Gemini keys.
 *
 * Nothing downstream needs the values: the property inspector asks whether a
 * key is set and the desktop UI reads its config over IPC, not from here. So
 * presence is all that leaves, and a redacted field stays truthy.
 */
/**
 * A viewer link is `<origin>/watch/<viewerToken>`, so the token is in the URL
 * whether or not the field it came from was masked. Redacting `viewerToken` and
 * leaving `relay.viewerUrl` alone hands out the same power in a different
 * shape - anyone holding the link watches the stream.
 */
function maskLink(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.replace(/\/watch\/[^/?#]+/, `/watch/${REDACTED}`);
}

function redact(status: ControlStatus): ControlStatus {
  const config = { ...status.config };
  for (const field of SECRET_FIELDS) {
    if (config[field]) config[field] = REDACTED;
  }
  const relay = {
    ...status.relay,
    viewerUrl: maskLink(status.relay.viewerUrl),
    localViewerUrl: maskLink(status.relay.localViewerUrl),
    remoteViewerUrl: maskLink(status.relay.remoteViewerUrl),
  };
  return { ...status, config, relay };
}

/**
 * Localhost-only control API for the companion process.
 * Consumed by the standalone UI (via IPC) and the Stream Deck plugin.
 * Live updates via SSE at GET /events.
 */
export function startControlServer(
  handlers: ControlHandlers,
  opts: { port?: number } = {},
): Promise<ControlHandle> {
  const subscribers = new Set<http.ServerResponse>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const origin = req.headers.origin;
    const cors = allowedOrigin(origin) ? origin || "*" : "null-deny";

    if (cors === "null-deny") {
      res.writeHead(403);
      res.end("forbidden origin");
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", cors);
    res.setHeader("Access-Control-Allow-Headers", `${CONTROL_CLIENT_HEADER}, Content-Type`);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const guardPost = (): boolean => {
      if (req.headers[CONTROL_CLIENT_HEADER]) return true;
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `missing ${CONTROL_CLIENT_HEADER} header` }));
      return false;
    };

    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    try {
      switch (`${req.method} ${url.pathname}`) {
        case `GET /status`: {
          json(200, redact(handlers.getStatus()));
          return;
        }
        case `GET /link`: {
          // STILL OPEN. This route exists to hand out the viewer link, so it
          // returns the unredacted status on purpose - and nothing here is a
          // secret: `allowedOrigin` admits `Origin: null`, which is what a
          // sandboxed iframe on any web page sends, and there is no credential
          // to check. Masking the link in /status (above) closes the broad read;
          // this one needs the control API to have a real per-launch token that
          // the Stream Deck property inspector can present. Until then, a page
          // you visit can ask for your viewer link.
          const status = handlers.getStatus();
          json(200, { viewerUrl: status.relay.viewerUrl || null });
          return;
        }
        case `GET /events`: {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write(`data: ${JSON.stringify({ type: "status", status: redact(handlers.getStatus()) })}\n\n`);
          subscribers.add(res);
          const ka = setInterval(() => res.write(":ka\n\n"), 15000);
          req.on("close", () => {
            clearInterval(ka);
            subscribers.delete(res);
          });
          return;
        }
        case `POST /start`: {
          if (!guardPost()) return;
          await handlers.start();
          json(200, redact(handlers.getStatus()));
          return;
        }
        case `POST /stop`: {
          if (!guardPost()) return;
          await handlers.stop();
          json(200, redact(handlers.getStatus()));
          return;
        }
        case `POST /config`: {
          if (!guardPost()) return;
          const body = await readJson(req);
          const status = await handlers.patchConfig(body || {});
          json(200, redact(status));
          return;
        }
        case `POST /link/rotate`: {
          if (!guardPost()) return;
          await handlers.rotateLink();
          const status = handlers.getStatus();
          json(200, { viewerUrl: status.relay.viewerUrl || null });
          return;
        }
        default: {
          json(404, { error: "not found" });
          return;
        }
      }
    } catch (err) {
      json(500, { error: String((err as Error).message || err) });
    }
  });

  function broadcast(status: ControlStatus): void {
    const payload = `data: ${JSON.stringify({ type: "status", status: redact(status) })}\n\n`;
    for (const res of subscribers) {
      try {
        res.write(payload);
      } catch {
        subscribers.delete(res);
      }
    }
  }

  const port = opts.port ?? Number(process.env.CONTROL_PORT || CONTROL_PORT);

  const handle: ControlHandle & { broadcast(status: ControlStatus): void } = {
    port,
    broadcast,
    close() {
      for (const res of subscribers) res.end();
      subscribers.clear();
      return new Promise<void>((r) => server.close(() => r())) as Promise<void>;
    },
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // bind loopback only - this API has no auth by design
    server.listen(port, "127.0.0.1", () => {
      // port 0 means "any free one", and then the requested port is not the
      // bound one; report what callers can actually connect to
      const bound = server.address();
      if (bound && typeof bound === "object") handle.port = bound.port;
      resolve(handle);
    });
  });
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 256 * 1024) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        resolve(text ? JSON.parse(text) : null);
      } catch (err) {
        reject(err as Error);
      }
    });
    req.on("error", reject);
  });
}
