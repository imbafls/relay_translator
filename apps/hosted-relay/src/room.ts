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
import { markUsed, nextReapCheck, reapTick } from "./reap";
import type { ReapableRoom, RoomIo } from "./reap";

/**
 * What this relay is willing to pass on from a publisher.
 *
 * Local copies of shared's `safeSpeakerColor` and `MAX_SPEAKER_TAG`, because
 * this Worker takes no dependencies on purpose - a regex and a number are a
 * smaller price than the first import into a bundle that has none. Exported so
 * they can be tested directly, the way `reap.ts` exports its decision.
 *
 * They exist because the sanitiser was half deployed: the embedded relay
 * checked the colour and capped the tag, and this one - the hop that every
 * internet viewer goes through and no developer tests against - did neither.
 */
export const MAX_SPEAKER_TAG = 12;

/** a six-digit hex colour, or nothing. Never escaped, never guessed at. */
export function safeColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(v) ? v : undefined;
}

/**
 * A speaker tag, capped. The name is drawn on every caption a viewer sees, so
 * an uncapped one is a publisher deciding how much of somebody's screen to take.
 */
export function safeSpeaker(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.slice(0, MAX_SPEAKER_TAG);
}

/** the longest brand name this relay will pass on; mirrors shared's MAX_BRAND_NAME */
export const MAX_BRAND_NAME = 24;

/**
 * What a stream calls itself. A local copy for the same reason as the two
 * above: this Worker carries no dependencies, and a number and a trim are
 * cheaper than the first import into a bundle that has none.
 */
export function safeBrandName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().slice(0, MAX_BRAND_NAME);
  return v.length > 0 ? v : undefined;
}

/** what a room is, between messages */
interface RoomState {
  publisherSecret: string;
  viewerSecret: string;
  /** the hello the uplink last sent - replayed to every viewer that joins */
  languages: { source: string; target: string };
  translates: boolean;
  live: boolean;
  /** what the publisher calls this stream; replayed to every viewer that joins */
  brandName?: string;
  /** `#rrggbb`, sanitised on the way in */
  brandColor?: string;
  /** epoch ms the current session started, for the viewer's clock */
  since?: number;
  /** last caption id seen, so a reconnecting uplink cannot rewind viewers */
  lastSegId: number;
  createdAt: number;
  /**
   * epoch ms somebody first proved they were using this room, by ANY
   * authenticated route - publishing, viewing, or managing the link. Absent
   * means nobody ever has, which is what makes a room safe to remove. See
   * `reap.ts` for why "a publisher connected" was the wrong definition.
   */
  usedAt?: number;
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
    // nothing has been published here yet, so it is a candidate for removal.
    // Set when the room is created rather than on a sweep: there is no sweep,
    // and nothing else ever visits a room nobody uses.
    const at = nextReapCheck(fresh);
    if (at !== undefined) await this.ctx.storage.setAlarm(at);
    return fresh;
  }

  /** everything `reap.ts` needs, so the mechanism can be run against a fake */
  private io(): RoomIo {
    return {
      load: () => this.load() as Promise<ReapableRoom | undefined>,
      save: (room) => this.save(room as RoomState),
      deleteAll: () => this.ctx.storage.deleteAll(),
      setAlarm: (at) => this.ctx.storage.setAlarm(at),
      deleteAlarm: () => this.ctx.storage.deleteAlarm(),
      openSockets: () => this.ctx.getWebSockets().length,
    };
  }

  /** somebody proved they are using this room; stop the clock. Cheap after the first. */
  private async touch(): Promise<void> {
    await markUsed(this.io(), Date.now());
  }

  /**
   * The alarm set at claim. Fires once, a month later, on a room that may have
   * been touched since - which is exactly the case it has to get right.
   *
   * The whole tick runs under `blockConcurrencyWhile` because a Durable Object
   * can run its alarm concurrently with a request: without it, a publisher
   * connecting during this handler can write `usedAt` between the decision and
   * the delete, and lose it.
   */
  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await reapTick(this.io(), Date.now());
    });
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
    if (!room) {
      // A socket for a room that does not exist has to refuse the way a bad
      // credential does. uplinkClient stops on a close code but treats an HTTP
      // failure as a transport error and retries forever, so answering 404 here
      // would put a user whose room had gone into a permanent reconnect loop.
      if (op === "uplink" || op === "viewer") return closedSocket(CLOSE_UNAUTHORISED, "no such room");
      return json({ error: "no such room" }, 404);
    }

    if (op === "health") {
      // the same payload the single-tenant relay returns; docs/OPEN-WORK.md
      // diagnoses production with exactly these three fields
      return json({ ok: true, live: room.live, viewers: this.viewerCount() });
    }

    if (op === "viewer-token" || op === "rotate-viewer-token") {
      // the owner is managing a link they intend to use
      await this.touch();
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
        return closedSocket(CLOSE_UNAUTHORISED, "bad token");
      }

      // A viewer counts as much as a publisher. The viewer branch above checks
      // the viewer secret and nothing else, so a link works from the moment the
      // room is claimed - somebody reading it is exactly the person whose link
      // must not be deleted.
      await this.touch();

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
          brandName: room.brandName,
          brandColor: room.brandColor,
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
      // A hello is the liveness signal - `startUplink()` connects at app boot,
      // not at session start, so this used to be unconditional `true` and the
      // room was re-marked live on every reconnect, every embedded-relay
      // restart, and every settings change while the app merely sat in the
      // tray. `!== false`, not `=== true`, for the same reason `translates`
      // eleven lines up is `!== false`: an OLDER app's hello carries no `live`
      // field at all, and that has to keep reading as live - the way every
      // hello did before this field existed - rather than going dark for
      // every user who has not auto-updated yet the day this Worker deploys.
      room.live = msg.live !== false;
      // Unconditional, not `if (msg.brandName)`: an absent brand on a later
      // hello is how a streamer clears one they set earlier, and that has to
      // work the same as setting it.
      room.brandName = safeBrandName(msg.brandName);
      room.brandColor = safeColor(msg.brandColor);
      await this.save(room);
      this.broadcast(TAG_VIEWER, {
        type: "hello",
        languages: room.languages,
        live: room.live,
        translates: room.translates,
        since: room.since,
        brandName: room.brandName,
        brandColor: room.brandColor,
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
        speaker: safeSpeaker(msg.speaker),
        // The whole SpeakerTag, or none of it. Dropping `color` here was
        // invisible: the literal is typed `& SpeakerTag`, an absent optional
        // field compiles, and LAN viewers - the ones anyone tests with - go
        // nowhere near this hop, so colours worked everywhere they were looked at.
        //
        // Sanitised here rather than trusted. safeColor is a local copy of
        // shared's safeSpeakerColor because this Worker deliberately carries no
        // dependencies; the viewer sets it with style.setProperty and would
        // ignore junk anyway, but the two relays should agree about what they
        // pass on rather than one of them checking.
        color: safeColor(msg.color),
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

/**
 * Refuse a socket the way the desktop client can act on: upgrade, then close
 * with a code. An HTTP status is retried forever; a close code stops it.
 */
function closedSocket(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
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
