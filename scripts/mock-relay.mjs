/**
 * Dev helper: run the relay with mock STT + mock translation in a throwaway
 * data dir, so the console / viewer UI can be exercised without API keys.
 *   node scripts/mock-relay.mjs            -> ws://127.0.0.1:8790
 *   RELAY_PORT=9000 node scripts/mock-relay.mjs
 * Tokens: <tmp>/callout-relay-mock/relay-state.json (printed on start).
 */
import * as os from "node:os";
import * as path from "node:path";

process.env.RELAY_PORT ||= "8790";
process.env.RELAY_MOCK_STT = "1";
process.env.RELAY_MOCK_GEMINI = "1";
process.env.CALLOUT_RELAY_DATA ||= path.join(os.tmpdir(), "callout-relay-mock");
console.log(`[mock-relay] data dir ${process.env.CALLOUT_RELAY_DATA}`);

await import("../packages/relay/dist/cli.js");
