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

/**
 * Whether a finished line actually said anything.
 *
 * A recogniser final with no words is a control message, not a caption: it
 * exists so a viewer can retire the interim row it has open, and never becomes
 * a row of its own. Every consumer already treats it that way - the viewer page
 * returns before building a row, and the desktop's own stage, translator and
 * transcript writer each check the same thing. A quiet channel emits one every
 * couple of seconds, so on this hop the difference is entirely how much silence
 * costs.
 */
export function hasWords(msg: Record<string, unknown>): boolean {
  const worded = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
  return worded(msg.source) || worded(msg.target);
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

/**
 * The record as it stands, for comparing against after a handler has written to
 * it - so a message that changed nothing costs no storage write.
 *
 * The desktop app re-sends its hello on every uplink reconnect, every embedded
 * relay restart and every settings change while it merely sits in the tray, and
 * a flapping speech pipeline sends `status live:false` and `live:true` back to
 * back. None of those has to change anything, and each write is a Durable Object
 * storage operation somebody pays for.
 *
 * `JSON.stringify` rather than a field-by-field compare, for two reasons. The
 * record is a dozen small values, so it is cheaper than the write it is avoiding.
 * And it gets the case that needs care right for free: an absent brand on a later
 * hello is how a streamer CLEARS one, `room.brandName = undefined` is omitted by
 * stringify, and a brand that went from a string to absent therefore reads as the
 * change it is.
 *
 * It cannot help a hello that carries no `since`, because the room then invents
 * one from its own clock and every such hello differs by construction. That is a
 * property of the fallback above, not of this check.
 */
function snapshot(room: RoomState): string {
  return JSON.stringify(room);
}

/** what a room is, between messages */
interface RoomState {
  publisherSecret: string;
  viewerSecret: string;
  /** the hello the uplink last sent - replayed to every viewer that joins */
  languages: { source: string; target: string };
  translates: boolean;
  live: boolean;
  /**
   * Whether the publisher SAID it is live - a status, or a 0.8+ hello with a
   * `live` field - rather than an older app's hello implying it. Only a
   * declared stream keeps the liveness alarm running: an app from before 0.8
   * says hello with no `live` at every boot, which reads as live, and sitting
   * in the tray all day it would otherwise cost a billed alarm every minute.
   */
  liveDeclared?: boolean;
  /** what the publisher calls this stream; replayed to every viewer that joins */
  brandName?: string;
  /** `#rrggbb`, sanitised on the way in */
  brandColor?: string;
  /** epoch ms the current session started, for the viewer's clock */
  since?: number;
  /**
   * Which numbering domain the segment ids belong to, forwarded from the
   * streamer's own relay so a viewer can tell one stream from the next.
   *
   * No `?? Date.now()` fallback, unlike `since` above, and that is the whole
   * point of it: an epoch this Worker invented would correspond to no id space
   * at all, and an uplink reconnect that happened to omit the field would read
   * as a restart and wipe a live transcript. Absent stays absent.
   */
  epoch?: number;
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
/**
 * Let go of a socket that stopped beating - a viewer, or the publisher's
 * uplink. Deliberately NOT 4401 or 4410: the viewer page treats those two as
 * facts about the link and shows THIS LINK HAS ENDED, and the uplink stops on
 * 4401 and 4409. This is a network condition either end should simply
 * reconnect from - and an uplink that was only slow is back within seconds.
 */
const CLOSE_SILENT = 4408;

/** `WebSocket.readyState` for a socket that can still send and be sent to */
const READY_OPEN = 1;

/**
 * How long a viewer may go silent before its socket is treated as gone.
 *
 * Three of the viewer's 20 s rounds, so a reader on a slow connection is never
 * dropped for being slow - and it is deliberately longer than the viewer's own
 * patience. The page gives up after two unanswered rounds and reconnects, so
 * in every case where both ends are running, the READER acts first and this
 * never fires. What it is for is the case the page cannot cover: a phone that
 * went away without saying so and is never coming back.
 */
const VIEWER_SILENT_MS = 70_000;

/**
 * The same, for the publisher. Its uplink beats on the same 20 s round with
 * the same frame, and has since before 0.8.1, so three missed rounds plus a
 * margin is the same judgement: a slow network is never taken for a dead one.
 */
const UPLINK_SILENT_MS = 70_000;

/**
 * How often a live room looks in on its publisher when nothing else wakes it.
 *
 * A publisher that vanished without a close - a power cut, a crash, a router
 * reboot - leaves nothing that would wake this object: its viewers' beats are
 * answered by the runtime and its own have stopped. An alarm is the only timer
 * a hibernating object has. It runs only while the publisher has declared a
 * session live (`liveDeclared`), which is while captions are waking the room
 * anyway, and adds about 60 billed requests and 60 row writes an hour to the
 * ~1,600 requests a live room was measured at (README, "Still open", the cost
 * entry): a viewer learns the stream ended within about two minutes instead of
 * never.
 */
const LIVENESS_CHECK_MS = 60_000;

/**
 * The heartbeat, answered by the runtime rather than by this object.
 *
 * Viewers ask whether the relay is still there, because a socket whose peer
 * vanished without a FIN stays OPEN on a phone indefinitely. Answering that in
 * `webSocketMessage` would work and would bill a request per beat per viewer -
 * about 180 an hour each - and would end the property this design was measured
 * on: an idle room costs nothing. `setWebSocketAutoResponse` hands the runtime
 * the whole exchange, so a beat wakes nothing and costs nothing.
 *
 * The match is on the EXACT bytes, so these two literals are a contract with
 * `packages/viewer/public/app.js`, which is served with no build step and can
 * therefore import nothing. `viewerPing.test.ts` is what holds them together.
 */
const PING_FRAME = '{"type":"ping"}';
const PONG_FRAME = '{"type":"pong"}';

export class Room {
  constructor(
    private readonly ctx: DurableObjectState,
    // the runtime passes the bindings positionally; this room reaches for
    // nothing in them, and holding a field nobody reads only invites one
    _env: unknown,
  ) {
    // in the constructor, not at accept time: it is set per object, it outlives
    // eviction along with the sockets, and a room woken by a viewer's first
    // beat must already have it
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME));
  }

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
   * The one alarm a room has, doing two jobs that never overlap.
   *
   * On a room nobody has used, it is the reap alarm set at claim: it fires a
   * month later on a room that may have been touched since - which is exactly
   * the case it has to get right. On a room somebody is streaming from, it is
   * the minute-by-minute look in on the publisher (`LIVENESS_CHECK_MS`). A room
   * being streamed from is a used one, and `markUsed` deletes the reap alarm on
   * first use, so the two never contend for the slot.
   *
   * The whole tick runs under `blockConcurrencyWhile` because a Durable Object
   * can run its alarm concurrently with a request: without it, a publisher
   * connecting during this handler can write `usedAt` between the decision and
   * the delete, and lose it.
   */
  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const reap = await reapTick(this.io(), Date.now());
      if (reap === "reaped" || reap === "gone") return;
      const room = await this.load();
      if (!room) return;
      await this.dropSilentPublisher(room);
      if (room.live && room.liveDeclared === true) await this.ctx.storage.setAlarm(Date.now() + LIVENESS_CHECK_MS);
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
      await this.dropSilentPublisher(room);
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
      } else {
        // before the greeting, which is built from `room.live`: a phone
        // opening the link must not be told a vanished publisher is on air
        await this.dropSilentPublisher(room);
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
        epoch: room.epoch,
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
    // `ViewerToServer` is `ping | sync`, and this answered only the ping - a
    // sync fell past the gate and was discarded in silence, while the comment
    // on that line said viewers may send one. The self-hosted relay answers
    // both. Kept BEFORE the load so anything else off a viewer socket still
    // costs nothing: this object is billed per operation, which is the whole
    // reason it hibernates.
    if (!isUplink && msg.type !== "sync") return;

    const room = await this.load();
    if (!room) return;

    // a viewer asks for this to pick up state it missed across a blip, so the
    // answer is the same greeting a late joiner gets
    if (msg.type === "sync") {
      await this.dropSilentPublisher(room);
      send(ws, {
        type: "hello",
        languages: room.languages,
        live: room.live,
        translates: room.translates,
        since: room.since,
        epoch: room.epoch,
        brandName: room.brandName,
        brandColor: room.brandColor,
      });
      return;
    }

    if (!isUplink) return; // past here is the uplink's alone

    if (msg.type === "hello") {
      const was = snapshot(room);
      const langs = msg.languages as RoomState["languages"] | undefined;
      if (langs && typeof langs.source === "string" && typeof langs.target === "string") {
        room.languages = { source: langs.source, target: langs.target };
      }
      room.translates = msg.translates !== false;
      room.since = typeof msg.since === "number" ? msg.since : Date.now();
      if (typeof msg.epoch === "number") room.epoch = msg.epoch;
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
      // an older app's hello leaves this as it was: it says nothing either way
      if (typeof msg.live === "boolean") room.liveDeclared = msg.live;
      // Unconditional, not `if (msg.brandName)`: an absent brand on a later
      // hello is how a streamer clears one they set earlier, and that has to
      // work the same as setting it.
      room.brandName = safeBrandName(msg.brandName);
      room.brandColor = safeColor(msg.brandColor);
      if (snapshot(room) !== was) await this.save(room);
      if (msg.live === true) await this.armLivenessCheck();
      this.broadcast(TAG_VIEWER, {
        type: "hello",
        languages: room.languages,
        live: room.live,
        translates: room.translates,
        since: room.since,
        epoch: room.epoch,
        brandName: room.brandName,
        brandColor: room.brandColor,
      });
      return;
    }

    if (msg.type === "status") {
      const was = snapshot(room);
      room.live = msg.live === true;
      room.liveDeclared = room.live;
      if (typeof msg.since === "number") room.since = msg.since;
      if (typeof msg.epoch === "number") room.epoch = msg.epoch;
      if (snapshot(room) !== was) await this.save(room);
      if (room.live) await this.armLivenessCheck();
      this.broadcast(TAG_VIEWER, {
        type: "status",
        live: room.live,
        message: msg.message,
        since: room.since,
        epoch: room.epoch,
      });
      return;
    }

    if (msg.type === "subtitle") {
      const id = Number(msg.id);
      if (!Number.isFinite(id)) return;
      // Only a line with words ever becomes a row on a viewer's screen, so only
      // a line with words is worth recording as the furthest this room has got.
      // A quiet channel emits a wordless final every couple of seconds and the
      // uplink forwards every one, so this used to put() on each tick of
      // silence: one measured 94-minute session carried 3,105 of them against
      // 657 real lines, five writes in six buying nothing. Keeping the running
      // maximum in memory instead is not open to us - `room` is re-read from
      // storage at the top of this handler, and a hibernating Durable Object is
      // evicted between messages, so an instance field would not survive either.
      //
      // What this does NOT do - and the comment here used to say it did - is
      // stop a reconnecting uplink's restarted numbering overwriting captions
      // already on screen. The broadcast below sits outside this branch, so a
      // rewound id is relayed either way, and nothing anywhere reads
      // `lastSegId`. The rewind is real: the viewer keys its rows by id and
      // never clears them on a restart. The fix for it is a session epoch on
      // the hello, which needs no per-subtitle state here at all.
      if (hasWords(msg) && id > room.lastSegId) {
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
      // A publisher that was REPLACED is not a stream ending. One uplink per
      // room, so a second one closes the first and takes over - which is what
      // happens on every network blip, every embedded-relay restart and every
      // settings change while the app sits in the tray. Without this, the
      // replaced socket's close marks the room not live and tells everybody
      // watching "stream ended" while the publisher that replaced it is
      // connected and streaming.
      //
      // `packages/relay/src/server.ts` reached the same rule for the same
      // event and says it where it accepts a new uplink: the replaced one's
      // "own close handler no longer matches `uplink === ws` to clear it".
      // Here the equivalent question is whether any uplink is still attached,
      // because this object identifies them by tag rather than by identity.
      //
      // Attached means OPEN. `getWebSockets` keeps handing back a socket the
      // takeover already closed for as long as its peer has not answered - it
      // sits in CLOSING, and a peer that stopped answering is what a network
      // blip leaves behind. Counting that socket would make the real
      // publisher's close, whenever it comes, end nothing.
      if (this.sockets(TAG_UPLINK).some((s) => s !== ws && s.readyState === READY_OPEN)) return;

      const room = await this.load();
      if (room && room.live) {
        room.live = false;
        room.liveDeclared = false;
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

  /**
   * The viewers actually there, letting go of any that are not.
   *
   * `apps/hosted-relay/README.md` records one viewer reported with nothing
   * watching, never explained. A socket whose phone vanished without a FIN
   * accounts for it exactly: this object ran no timer for viewers, so nothing
   * here ever closed it, and the count it inflated could never come down.
   *
   * Reading the auto-response timestamp costs nothing and needs no alarm - it
   * happens on a wake-up that was going to happen anyway, because the count is
   * only ever recomputed when a viewer arrives or leaves.
   */
  private liveViewers(): { live: WebSocket[]; dropped: number } {
    const now = Date.now();
    const live: WebSocket[] = [];
    let dropped = 0;
    for (const ws of this.sockets(TAG_VIEWER)) {
      // A socket this object already closed is neither a reader nor a new
      // drop. The runtime keeps handing it back in CLOSING until its peer
      // answers, and the peer this sweep exists for - a phone gone without a
      // FIN - never does, so without this every caption closed it again,
      // counted it again and told the app again.
      if (ws.readyState !== READY_OPEN) continue;
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      // null is "has never beaten", which is a viewer page served before the
      // heartbeat shipped - not evidence of anything. Reaping on it would
      // close a healthy reader, who would reconnect into a room that closes
      // them again. Silence only counts against a socket that has spoken.
      if (!last || now - last.getTime() < VIEWER_SILENT_MS) {
        live.push(ws);
        continue;
      }
      try {
        ws.close(CLOSE_SILENT, "no heartbeat");
      } catch {
        /* already gone, which is the outcome either way */
      }
      dropped += 1;
    }
    return { live, dropped };
  }

  private viewerCount(): number {
    return this.liveViewers().live.length;
  }

  /**
   * End a stream whose publisher is no longer there.
   *
   * The uplink of a PC that lost power or dropped off the network never sends
   * a close, so `webSocketClose` never runs - and the only other things that
   * set a room not-live are that same uplink's own messages. The room stayed
   * ON AIR: viewers watching kept a running clock over nothing, and everyone
   * who opened the link later was greeted with `live: true`.
   *
   * The same judgement `liveViewers()` makes of a reader: an OPEN uplink that
   * beat within `UPLINK_SILENT_MS`, or has never beaten yet - one that has just
   * connected, whose first ping is in flight - is a publisher. A silent one is
   * closed with the code the client reconnects from, so if it was only slow it
   * is back within seconds with a hello that says live again. With none left,
   * the stream is over, and viewers are told exactly what a clean close tells
   * them. Changes `room` in place, and saves it.
   */
  private async dropSilentPublisher(room: RoomState): Promise<void> {
    if (!room.live) return;
    const now = Date.now();
    let present = false;
    for (const ws of this.sockets(TAG_UPLINK)) {
      // closed by a takeover and waiting in CLOSING for a peer that may never
      // answer: whatever it is, it is not publishing
      if (ws.readyState !== READY_OPEN) continue;
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      if (!last || now - last.getTime() < UPLINK_SILENT_MS) {
        present = true;
        continue;
      }
      try {
        ws.close(CLOSE_SILENT, "no heartbeat");
      } catch {
        /* already gone, which is the outcome either way */
      }
    }
    if (present) return;
    room.live = false;
    room.liveDeclared = false;
    await this.save(room);
    this.broadcast(TAG_VIEWER, { type: "status", live: false, message: "stream ended" });
  }

  /**
   * Make sure a live room is looked in on. Leaves an earlier alarm alone:
   * pushing it back on every hello and status would mean a publisher that
   * kept reconnecting was never checked at all.
   */
  private async armLivenessCheck(): Promise<void> {
    const due = Date.now() + LIVENESS_CHECK_MS;
    const at = await this.ctx.storage.getAlarm();
    if (at !== null && at <= due) return;
    await this.ctx.storage.setAlarm(due);
  }

  private broadcast(tag: string, msg: unknown): void {
    if (tag !== TAG_VIEWER) {
      for (const ws of this.sockets(tag)) send(ws, msg);
      return;
    }
    // The sweep belongs here as well as in `viewerCount()`, because the count
    // is only recomputed when a viewer arrives or leaves: a room with one held
    // socket and nobody else joining reported it for the whole stream, which is
    // precisely when the streamer is looking at the readout. Captions are
    // already happening and this object is already awake to fan them out, so
    // this costs a timestamp read per viewer and no wake-up at all.
    const { live, dropped } = this.liveViewers();
    for (const ws of live) send(ws, msg);
    // Only when it actually changed. A dense stream is a caption every 2.5 s,
    // and re-announcing an unchanged number on each one would be a message per
    // caption to the uplink that says nothing.
    if (dropped > 0) this.broadcastViewerCount();
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
