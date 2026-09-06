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
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  /** hibernation: the runtime holds the socket while the object is evicted */
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  getTags(ws: WebSocket): string[];
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
