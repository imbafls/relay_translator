import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { WebSocketServer, WebSocket, RawData } from "ws";
import {
  DEFAULT_CONFIG,
  PublisherToServer,
  ServerToPublisher,
  ServerToViewer,
  UplinkToServer,
  UsageInfo,
} from "@callout-relay/shared";
import { loadState, generateToken, RelayState, saveState } from "./config";
import { PublisherSession, SessionConfig, GeminiStats, SttStats } from "./session";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

/**
 * Resolve a viewer static asset. Order:
 *  1. embedded SEA assets (standalone server exe)
 *  2. "<bundle dir>/viewer" (esbuild-bundled electron main, inside asar)
 *  3. the @callout-relay/viewer workspace package (dev / tsc build)
 */
function readViewerAsset(rel: string): Buffer | undefined {
  if (!/^[A-Za-z0-9._\-/]+$/.test(rel) || rel.includes("..")) return undefined;

  try {
    const sea = require("node:sea");
    if (typeof sea.isSea === "function" && sea.isSea()) {
      const asset = sea.getRawAsset(`viewer/${rel.replace(/\\/g, "/")}`);
      if (asset) return Buffer.from(asset);
    }
  } catch {
    // not running as SEA
  }

  try {
    const local = path.join(__dirname, "viewer", rel);
    if (fs.existsSync(local)) return fs.readFileSync(local);
  } catch {
    /* __dirname unavailable */
  }

  try {
    const pkgJson = require.resolve("@callout-relay/viewer/package.json");
    const file = path.join(path.dirname(pkgJson), "public", rel);
    if (fs.existsSync(file)) return fs.readFileSync(file);
  } catch {
    /* viewer package not installed */
  }

  return undefined;
}

export interface RelayOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  deepgramApiKey?: string;
  geminiApiKey?: string;
  publisherToken?: string;
  viewerToken?: string;
  mockStt?: boolean;
  mockGemini?: boolean;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface RelayHandle {
  port: number;
  state: RelayState;
  /** origin of the embedded relay, e.g. http://192.168.1.5:8787 */
  origin: string;
  viewerUrl(viewerToken: string, obs?: boolean): string;
  rotateViewerToken(): string;
  /** subscribe to everything fanned out to local viewers (for the uplink bridge) */
  onBroadcast(cb: (msg: ServerToViewer) => void): () => void;
  /** Deepgram balance + Gemini usage counters */
  getUsage(): Promise<UsageInfo>;
  close(): Promise<void>;
}

function lanAddress(): string {
  const ifaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const iface of list || []) {
      if (iface.family === "IPv4" && !iface.internal) candidates.push(iface.address);
    }
  }
  // prefer real LAN ranges, avoid APIPA/link-local (169.254.x.x)
  const score = (ip: string): number => {
    if (ip.startsWith("192.168.") || ip.startsWith("10.")) return 2;
    const m = ip.match(/^172\.(\d+)\./);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return 2;
    if (ip.startsWith("169.254.")) return 0;
    return 1;
  };
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0] || "127.0.0.1";
}

export function startRelay(opts: RelayOptions = {}): Promise<RelayHandle> {
  const log = opts.log || (() => {});
  const dataDir = opts.dataDir || ".";
  const state = loadState(dataDir, {
    publisherToken: opts.publisherToken,
    viewerToken: opts.viewerToken,
  });
  const mockStt = opts.mockStt ?? process.env.RELAY_MOCK_STT === "1";
  const mockGemini = opts.mockGemini ?? process.env.RELAY_MOCK_GEMINI === "1";
  const geminiStats: GeminiStats = { count: 0, cacheHits: 0, tokensIn: 0, tokensOut: 0 };
  const sttStats: SttStats = { seconds: 0 };

  let publisher: { ws: WebSocket; session: PublisherSession } | null = null;
  /** remote app mirroring finished subtitles via /ws/uplink */
  let uplink: WebSocket | null = null;
  /** single-connection-per-token: new viewer with the same token kicks the old */
  const viewers = new Map<string, WebSocket>();
  let currentLanguages = { ...DEFAULT_CONFIG.languages };
  let currentTranslates = DEFAULT_CONFIG.translationEnabled !== false;
  const broadcastListeners = new Set<(msg: ServerToViewer) => void>();

  const toViewers = (msg: ServerToViewer): void => {
    const payload = JSON.stringify(msg);
    for (const cb of broadcastListeners) {
      try {
        cb(msg);
      } catch {
        /* listener errors must not break fan-out */
      }
    }
    for (const ws of viewers.values()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  };

  const isLive = (): boolean => publisher !== null || uplink !== null;

  function buildSession(ws: WebSocket, cfg: SessionConfig): void {
    if (publisher) {
      try {
        publisher.session.stop();
      } catch {
        /* noop */
      }
    }
    currentLanguages = { ...cfg.languages };
    currentTranslates = cfg.translationEnabled !== false;
    const session = new PublisherSession(cfg, {
      deepgramApiKey: opts.deepgramApiKey,
      geminiApiKey: opts.geminiApiKey,
      mockStt,
      mockGemini,
      geminiStats,
      sttStats,
      toViewers,
      toPublisher: (msg) => {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
        } catch {
          /* noop */
        }
      },
      setLive: () => {},
      log,
    });
    session.start();
    if (publisher && publisher.ws === ws) publisher.session = session;
  }

  function dropPublisher(reason: string): void {
    if (!publisher) return;
    publisher.session.stop();
    try {
      publisher.ws.close(4409, reason);
    } catch {
      /* noop */
    }
    publisher = null;
    toViewers({ type: "status", live: false, message: reason });
  }

  function kickViewer(token: string, reason: string): void {
    const old = viewers.get(token);
    if (!old) return;
    try {
      old.send(JSON.stringify({ type: "kicked", reason } satisfies ServerToViewer));
      old.close(4409, reason);
    } catch {
      /* noop */
    }
    viewers.delete(token);
  }

  // -------------------------------------------------------------------------
  // HTTP: static viewer page + health + admin
  // -------------------------------------------------------------------------
  const isPublisherAuth = (req: http.IncomingMessage): boolean => {
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    return token === state.publisherToken;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, live: isLive(), viewers: viewers.size }));
      return;
    }

    if (url.pathname === "/admin/viewer-token" && req.method === "GET") {
      if (!isPublisherAuth(req)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ viewerToken: state.viewerToken }));
      return;
    }

    if (url.pathname === "/admin/rotate-viewer-token" && req.method === "POST") {
      if (!isPublisherAuth(req)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      const viewerToken = rotateViewerToken();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ viewerToken }));
      log("info", "viewer token rotated via admin API");
      return;
    }

    // viewer page + assets
    if (url.pathname === "/" || url.pathname === "/watch" || url.pathname === "/watch/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Callout Relay</title>` +
          `<body style="font-family:system-ui;background:#0b0e14;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0">` +
          `<div style="text-align:center"><h1>Callout Relay</h1><p>Relay is running. Open the share link from the app.</p>` +
          `<p style="opacity:.5">GET /health &middot; WS /ws/publisher &middot; WS /ws/viewer</p></div></body>`,
      );
      return;
    }

    const watchMatch = url.pathname.match(/^\/watch\/([A-Za-z0-9_-]+)$/);
    let rel = "";
    if (watchMatch) {
      rel = "index.html";
    } else if (url.pathname.startsWith("/watch/")) {
      rel = url.pathname.slice("/watch/".length);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }

    const asset = readViewerAsset(rel);
    if (!asset) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const type = MIME[path.extname(rel).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(asset);
  });

  // -------------------------------------------------------------------------
  // WebSocket endpoints
  // -------------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://localhost`);
    const token = url.searchParams.get("token") || "";

    if (url.pathname === "/ws/publisher") {
      if (token !== state.publisherToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => onPublisher(ws));
      return;
    }

    if (url.pathname === "/ws/uplink") {
      if (token !== state.publisherToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => onUplink(ws));
      return;
    }

    if (url.pathname === "/ws/viewer") {
      if (token !== state.viewerToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => onViewer(ws, token));
      return;
    }

    socket.destroy();
  });

  function sendPublisher(ws: WebSocket, msg: ServerToPublisher): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function onPublisher(ws: WebSocket): void {
    // single-connection kick: a new publisher replaces the old one
    if (publisher) {
      log("warn", "publisher replaced by new connection");
      dropPublisher("replaced by new publisher");
    }

    publisher = { ws, session: null as unknown as PublisherSession };
    buildSession(ws, {
      stt: DEFAULT_CONFIG.stt,
      translation: DEFAULT_CONFIG.translation,
      languages: { ...currentLanguages },
      translationEnabled: DEFAULT_CONFIG.translationEnabled !== false,
      latencyVisible: DEFAULT_CONFIG.showLatency !== false,
    });

    sendPublisher(ws, {
      type: "ready",
      sampleRate: publisher.session.sampleRate,
    });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!publisher || publisher.ws !== ws) return;

      if (isBinary) {
        publisher.session.audio(Buffer.from(data as Buffer));
        return;
      }

      let msg: PublisherToServer;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "ping") sendPublisher(ws, { type: "pong" });
      if (msg.type === "hello") {
        log(
          "info",
          `publisher session: stt=${msg.stt} translation=${msg.translation} ${msg.languages.source}->${msg.languages.target}${msg.translationEnabled === false ? " (translation off)" : ""}${msg.latencyVisible === false ? " (latency hidden)" : ""}`,
        );
        buildSession(ws, {
          stt: msg.stt,
          translation: msg.translation,
          languages: msg.languages,
          translationEnabled: msg.translationEnabled !== false,
          latencyVisible: msg.latencyVisible !== false,
        });
        toViewers({
          type: "hello",
          languages: msg.languages,
          live: true,
          translates: currentTranslates,
        });
      }
    });

    ws.on("close", () => {
      if (publisher && publisher.ws === ws) {
        log("info", "publisher disconnected");
        dropPublisher("publisher disconnected");
      }
    });
    ws.on("error", () => {
      if (publisher && publisher.ws === ws) dropPublisher("publisher error");
    });
  }

  function onViewer(ws: WebSocket, token: string): void {
    kickViewer(token, "another device opened this link");
    viewers.set(token, ws);

    ws.send(
      JSON.stringify({
        type: "hello",
        languages: currentLanguages,
        live: isLive(),
        translates: currentTranslates,
      } satisfies ServerToViewer),
    );

    ws.on("message", (data: RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
        if (msg.type === "sync") {
          ws.send(
            JSON.stringify({
              type: "hello",
              languages: currentLanguages,
              live: isLive(),
              translates: currentTranslates,
            } satisfies ServerToViewer),
          );
        }
      } catch {
        /* noop */
      }
    });

    ws.on("close", () => {
      if (viewers.get(token) === ws) viewers.delete(token);
    });
    ws.on("error", () => {
      if (viewers.get(token) === ws) viewers.delete(token);
    });
  }

  function onUplink(ws: WebSocket): void {
    // single uplink: a new one replaces the old
    if (uplink) {
      try {
        uplink.close(4409, "replaced by new uplink");
      } catch {
        /* noop */
      }
    }
    uplink = ws;
    log("info", "uplink connected (remote subtitle mirror)");

    ws.on("message", (data: RawData) => {
      if (uplink !== ws) return;
      let msg: UplinkToServer;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "ping") {
        sendPublisher(ws, { type: "pong" });
        return;
      }
      if (msg.type === "hello") {
        currentLanguages = { ...msg.languages };
        currentTranslates = msg.translates !== false;
        toViewers({
          type: "hello",
          languages: currentLanguages,
          live: true,
          translates: currentTranslates,
        });
        return;
      }
      if (msg.type === "subtitle") {
        toViewers({
          type: "subtitle",
          id: msg.id,
          source: msg.source,
          target: msg.target,
          final: msg.final,
          latency: msg.latency,
        });
        return;
      }
      if (msg.type === "status") {
        toViewers({ type: "status", live: msg.live, message: msg.message });
      }
    });

    ws.on("close", () => {
      if (uplink === ws) {
        log("info", "uplink disconnected");
        uplink = null;
        toViewers({ type: "status", live: false, message: "stream ended" });
      }
    });
    // "close" always follows "error" and owns the cleanup + "stream ended" broadcast
    ws.on("error", (err) => {
      if (uplink === ws) log("warn", `uplink socket error: ${String(err)}`);
    });
  }

  function rotateViewerToken(): string {
    state.viewerToken = generateToken();
    saveState(dataDir, state);
    // the old link dies with the old token
    for (const [token, ws] of [...viewers.entries()]) {
      if (token !== state.viewerToken) {
        kickViewer(token, "link was rotated");
      }
    }
    return state.viewerToken;
  }

  // heartbeat: drop dead sockets
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.ping();
      } catch {
        /* noop */
      }
    }
  }, 30000);

  const port = opts.port ?? Number(process.env.RELAY_PORT || 8787);
  const host = opts.host || "0.0.0.0";

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const actualPort = (server.address() as { port: number }).port;
      const origin = `http://${lanAddress()}:${actualPort}`;
      log(
        "info",
        `relay listening on ${host}:${actualPort} (lan: ${origin}, live: no)`,
      );
      resolve({
        port: actualPort,
        state,
        origin,
        viewerUrl(token: string, obs?: boolean) {
          const base = `${origin}/watch/${token}`;
          return obs ? `${base}?obs=1` : base;
        },
        rotateViewerToken,
        onBroadcast(cb: (msg: ServerToViewer) => void) {
          broadcastListeners.add(cb);
          return () => broadcastListeners.delete(cb);
        },
        async getUsage(): Promise<UsageInfo> {
          return {
            deepgram: {
              sttMinutes: Math.round((sttStats.seconds / 60) * 10) / 10,
              estCostUsd: Math.round((sttStats.seconds / 60) * 0.0043 * 100) / 100,
            },
            gemini: {
              count: geminiStats.count,
              cacheHits: geminiStats.cacheHits,
              tokensIn: geminiStats.tokensIn,
              tokensOut: geminiStats.tokensOut,
              // flash-lite-tier pricing estimate: ~$0.10/1M in, ~$0.40/1M out
              estCostUsd:
                Math.round(
                  ((geminiStats.tokensIn / 1e6) * 0.1 + (geminiStats.tokensOut / 1e6) * 0.4) * 1e4,
                ) / 1e4,
            },
          };
        },
        async close() {
          clearInterval(heartbeat);
          dropPublisher("relay shutting down");
          if (uplink) {
            try {
              uplink.close(1001, "relay shutting down");
            } catch {
              /* noop */
            }
            uplink = null;
          }
          for (const ws of viewers.values()) {
            try {
              ws.close(1001, "relay shutting down");
            } catch {
              /* noop */
            }
          }
          viewers.clear();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}
