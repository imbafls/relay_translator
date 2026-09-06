/**
 * One room = one Durable Object = one streamer.
 *
 * This is the single-tenant relay's live half, made per-tenant. The old server
 * held `let publisher`, one viewer map and one `currentLanguages` in module
 * scope (packages/relay/src/server.ts:207-212), which is exactly why a second
 * streamer evicted the first. Here those are instance state of an object that
 * exists once per room, so isolation is structural rather than enforced.
 *
 * It does NO speech recognition and NO translation. The uplink carries finished
 * captions; the desktop app did that work locally on the user's own keys. That
 * is what makes hosting this nearly free and why it holds no API keys.
 *
 * HIBERNATION IS THE WHOLE DESIGN, not an optimisation. Cloudflare bills a
 * Durable Object for wall-clock duration while it holds an accepted WebSocket,
 * so a room that stayed resident through a four-hour stream would be billed for
 * four hours of compute to forward a few hundred short strings. With
 * hibernation the object is evicted between messages and billed only when it
 * runs.
 *
 * The consequence, and the thing that is easy to get wrong: EVICTION IS NORMAL
 * AND MID-STREAM. Every deploy evicts every room too. So nothing that a viewer
 * depends on may live in an instance field - `languages`, `translates`, `since`
 * and `live` are read from storage on every wake. A field would survive local
 * testing perfectly and blank every live overlay the first time the service was
 * redeployed.
 */

import { formatToken, newSecret, secretsMatch } from "./tokens";

/** what a room is, between messages */
interface RoomState {
  publisherSecret: string;
  viewerSecret: string;
  /** the hello the uplink last sent - replayed to every viewer that joins */
  languages: { source: string; target: string };
  translates: boolean;
  live: boolean;
  /** epoch ms the current session started, for the viewer's clock */
  since?: number;
  /** last caption id seen, so a reconnecting uplink cannot rewind viewers */
  lastSegId: number;
  createdAt: number;
}

const TAG_UPLINK = "uplink";
const TAG_VIEWER = "viewer";

/** close codes the desktop client already understands (uplinkClient.ts) */
const CLOSE_UNAUTHORISED = 4401;
const CLOSE_REPLACED = 4409;

export class Room {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: unknown,
  ) {}

  // ---------------------------------------------------------------- lifecycle

  private async load(): Promise<RoomState | undefined> {
    return this.ctx.storage.get<RoomState>("room");
  }

  private async save(next: RoomState): Promise<void> {
    await this.ctx.storage.put("room", next);
  }

  /** create the room on first claim; idempotent for a repeated claim */
  private async ensure(): Promise<RoomState> {
    const existing = await this.load();
    if (existing) return existing;
    const fresh: RoomState = {
      publisherSecret: newSecret(),
      viewerSecret: newSecret(),
      languages: { source: "en", target: "vi" },
      translates: false,
      live: false,
      lastSegId: 0,
      createdAt: Date.now(),
    };
    await this.save(fresh);
    return fresh;
  }

  // ------------------------------------------------------------------ fetch

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const op = url.searchParams.get("op") || "";
    const rid = url.searchParams.get("rid") || "";
    const secret = url.searchParams.get("secret") || "";

    if (op === "claim") {
      const room = await this.ensure();
      return json({
        publisherToken: formatToken("publisher", rid, room.publisherSecret),
        viewerToken: formatToken("viewer", rid, room.viewerSecret),
      });
    }

    const room = await this.load();
    if (!room) return json({ error: "no such room" }, 404);

    if (op === "health") {
      // the same payload the single-tenant relay returns; docs/OPEN-WORK.md
      // diagnoses production with exactly these three fields
      return json({ ok: true, live: room.live, viewers: this.viewerCount() });
    }

    if (op === "viewer-token" || op === "rotate-viewer-token") {
      if (!secretsMatch(secret, room.publisherSecret)) return json({ error: "forbidden" }, 403);
      if (op === "rotate-viewer-token") {
        room.viewerSecret = newSecret();
        await this.save(room);
        // every link handed out before this moment is now dead, which is the
        // point of rotation - a derived token could not do that
        this.closeAll(TAG_VIEWER, 4410, "link rotated");
      }
      return json({ viewerToken: formatToken("viewer", rid, room.viewerSecret) });
    }

    if (op === "uplink" || op === "viewer") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const wanted = op === "uplink" ? room.publisherSecret : room.viewerSecret;
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      // Reject AFTER upgrading. uplinkClient.ts treats an HTTP failure as a
      // transport error and retries forever, but reads a close code and stops -
      // so a bad credential has to arrive as 4401 on an open socket.
      if (!secretsMatch(secret, wanted)) {
        server.accept();
        server.close(CLOSE_UNAUTHORISED, "bad token");
        return new Response(null, { status: 101, webSocket: client });
      }

      if (op === "uplink") {
        // one publisher per room; the newcomer wins, as the old relay did
        this.closeAll(TAG_UPLINK, CLOSE_REPLACED, "replaced by new publisher");
      }

      this.ctx.acceptWebSocket(server, [op === "uplink" ? TAG_UPLINK : TAG_VIEWER]);

      if (op === "uplink") {
        send(server, { type: "ready" });
      } else {
        // a viewer joining mid-stream needs the state it missed
        send(server, {
          type: "hello",
          languages: room.languages,
          live: room.live,
          translates: room.translates,
          since: room.since,
        });
        this.broadcastViewerCount();
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: "not found" }, 404);
  }

  // -------------------------------------------------------- socket handlers

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") return; // this service carries no audio
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    // a non-object frame killed the old relay; the guard is cheap and load-bearing
    if (!msg || typeof msg !== "object") return;

    const isUplink = this.ctx.getTags(ws).includes(TAG_UPLINK);
    if (msg.type === "ping") {
      send(ws, { type: "pong" });
      return;
    }
    if (!isUplink) return; // viewers may only ping and sync

    const room = await this.load();
    if (!room) return;

    if (msg.type === "hello") {
      const langs = msg.languages as RoomState["languages"] | undefined;
      if (langs && typeof langs.source === "string" && typeof langs.target === "string") {
        room.languages = { source: langs.source, target: langs.target };
      }
      room.translates = msg.translates !== false;
      room.since = typeof msg.since === "number" ? msg.since : Date.now();
      room.live = true;
      await this.save(room);
      this.broadcast(TAG_VIEWER, {
        type: "hello",
        languages: room.languages,
        live: true,
        translates: room.translates,
        since: room.since,
      });
      return;
    }

    if (msg.type === "status") {
      room.live = msg.live === true;
      if (typeof msg.since === "number") room.since = msg.since;
      await this.save(room);
      this.broadcast(TAG_VIEWER, { type: "status", live: room.live, message: msg.message, since: room.since });
      return;
    }

    if (msg.type === "subtitle") {
      const id = Number(msg.id);
      if (!Number.isFinite(id)) return;
      // a reconnecting uplink restarts its numbering; viewers key their rows by
      // id, so letting it rewind would overwrite captions already on screen
      if (id > room.lastSegId) {
        room.lastSegId = id;
        await this.save(room);
      }
      this.broadcast(TAG_VIEWER, {
        type: "subtitle",
        id,
        source: msg.source,
        target: msg.target,
        final: msg.final !== false,
        latency: msg.latency,
        channel: msg.channel,
        speaker: msg.speaker,
      });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (this.ctx.getTags(ws).includes(TAG_UPLINK)) {
      const room = await this.load();
      if (room && room.live) {
        room.live = false;
        await this.save(room);
        this.broadcast(TAG_VIEWER, { type: "status", live: false, message: "stream ended" });
      }
    } else {
      this.broadcastViewerCount();
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  // ------------------------------------------------------------------ helpers

  private sockets(tag: string): WebSocket[] {
    return this.ctx.getWebSockets(tag);
  }

  private viewerCount(): number {
    return this.sockets(TAG_VIEWER).length;
  }

  private broadcast(tag: string, msg: unknown): void {
    for (const ws of this.sockets(tag)) send(ws, msg);
  }

  private broadcastViewerCount(): void {
    this.broadcast(TAG_UPLINK, { type: "viewers", count: this.viewerCount() });
  }

  private closeAll(tag: string, code: number, reason: string): void {
    for (const ws of this.sockets(tag)) {
      try {
        ws.close(code, reason);
      } catch {
        /* already gone */
      }
    }
  }
}

function send(ws: WebSocket, msg: unknown): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* closed under us */
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
