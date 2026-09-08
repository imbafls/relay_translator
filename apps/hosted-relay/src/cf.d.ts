/**
 * The slice of the Workers runtime this service actually uses.
 *
 * Declared here rather than pulled from @cloudflare/workers-types on purpose:
 * adding a dependency changes the lockfile, and CI installs with
 * --frozen-lockfile. Nothing here is invented - each of these is used by
 * src/room.ts or src/index.ts, and `npx wrangler deploy` type-checks against
 * the real definitions at publish time.
 */

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** removes every key, which for this object means the room stops existing */
  deleteAll(): Promise<void>;
  /** one alarm per object; setting again replaces the pending one */
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  /** hibernation: the runtime holds the socket while the object is evicted */
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  getTags(ws: WebSocket): string[];
  /** defers delivery of every other event until the callback settles */
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

interface WebSocket {
  accept(): void;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

interface ResponseInit {
  webSocket?: WebSocket;
}

/**
 * The Workers rate-limiting binding (GA since 2025-09). Configured in
 * wrangler.toml under [[ratelimits]]; `limit()` counts one hit against `key`
 * and answers whether it is still under the configured ceiling.
 */
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * The slice of the R2 binding this Worker uses: writing a feedback record and
 * (optionally) an attached log, nothing else. There is no `get`/`list` here
 * because nothing this Worker serves ever reads a report back out - that
 * happens with a script running under its own Cloudflare API token, outside
 * the Worker. Declared locally for the same reason as the rest of this file:
 * no dependency on @cloudflare/workers-types, and `npx wrangler deploy`
 * type-checks the real shape at publish time regardless of what is declared
 * here.
 */
interface R2Bucket {
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}
