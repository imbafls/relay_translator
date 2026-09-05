/**
 * WebSocket implementation resolver: browsers / Node >= 22 expose a global
 * WebSocket; Electron main (Node 20) does not - fall back to the `ws` package.
 */
export function getWebSocketImpl(): typeof WebSocket {
  if (typeof WebSocket !== "undefined") return WebSocket;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Ws = require("ws");
  return (Ws?.WebSocket || Ws) as unknown as typeof WebSocket;
}
