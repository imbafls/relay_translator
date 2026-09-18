import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Room } from "../src/room";

/**
 * The viewer's heartbeat, across the two sides that have to agree on it byte
 * for byte.
 *
 * A viewer on a phone asks the relay whether it is still there, because a
 * socket whose peer vanished without a FIN stays OPEN on that side
 * indefinitely. Answering it in `webSocketMessage` would be correct and would
 * wake this object once per beat per viewer - roughly 180 requests an hour
 * each, billed, and enough to end the property the hosted design was measured
 * on: an idle room costs nothing. `setWebSocketAutoResponse` hands the whole
 * exchange to the runtime, which answers without waking anything.
 *
 * The runtime matches on the EXACT bytes. `packages/viewer/public/app.js` is
 * served as-is with no build step, so it can import nothing and the frame is a
 * literal at both ends - the same shape as the close codes in
 * `closeCodes.test.ts` and the viewer messages in `4bc5966`, both of which
 * were found to disagree. A single space added to either literal would not
 * fail a typecheck, would not fail a viewer test, and would silently return
 * every beat to billing this object.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const viewerJs = fs.readFileSync(path.join(root, "packages", "viewer", "public", "app.js"), "utf8");

interface Pair {
  request: string;
  response: string;
}

/** construct the real Room against a fake state handle and catch what it set */
function autoResponse(): Pair {
  const set: Pair[] = [];
  class FakePair {
    constructor(
      readonly request: string,
      readonly response: string,
    ) {}
  }
  const g = globalThis as unknown as { WebSocketRequestResponsePair?: unknown };
  const had = g.WebSocketRequestResponsePair;
  g.WebSocketRequestResponsePair = FakePair;
  try {
    const ctx = {
      storage: {},
      setWebSocketAutoResponse: (pair: Pair) => set.push(pair),
    };
    new Room(ctx as unknown as ConstructorParameters<typeof Room>[0], {});
  } finally {
    g.WebSocketRequestResponsePair = had;
  }
  expect(
    set,
    "the room set no auto-response, so every viewer heartbeat wakes this object and is billed - an idle " +
      "room with one reader parked on it stops being free",
  ).toHaveLength(1);
  return set[0] as Pair;
}

describe("a viewer's heartbeat on the hosted relay", () => {
  it("is answered by the runtime, on exactly the bytes the viewer sends", () => {
    const pair = autoResponse();

    expect(
      viewerJs,
      "the viewer page no longer builds a ping frame, so nothing sends the message this answers",
    ).toMatch(/JSON\.stringify\(\{\s*type:\s*"ping"\s*\}\)/);

    expect(
      pair.request,
      "the auto-response no longer matches what the viewer sends. The runtime compares the exact bytes, so " +
        "this does not fail loudly: the page keeps beating, this object wakes for every beat again, and the " +
        "only visible symptom is the bill.",
    ).toBe(JSON.stringify({ type: "ping" }));
  });

  it("answers with the message the viewer actually acts on", () => {
    const pair = autoResponse();

    expect(
      () => JSON.parse(pair.response),
      "the auto-response body is not JSON, so the viewer drops it in its parse guard and counts the round unanswered",
    ).not.toThrow();
    expect((JSON.parse(pair.response) as { type?: string }).type).toBe("pong");

    expect(
      viewerJs,
      "the viewer has no pong branch any more, so every answered round still counts as unanswered and it " +
        "drops a relay that is working",
    ).toMatch(/case "pong":/);
  });
});

/**
 * The failure mode this arrangement has, and why a deploy cannot see it.
 *
 * If the auto-response pair ever stops matching what viewers send, the beat
 * falls through to `webSocketMessage`, which answers a ping too. So the viewer
 * still gets its pong, every test here still passes, `verify-deploy.cjs` still
 * passes, and the only thing that changes is that every beat from every viewer
 * wakes this object and is billed - roughly 180 requests an hour each.
 *
 * A silent regression whose only symptom is money is exactly the shape this
 * repo keeps finding, so the README carries the diagnostic: the frame to
 * compare against and the script that measures it. This holds that note to the
 * code, the way `reap.test.ts` holds the reaping note to `reap.ts` - a
 * diagnostic that quietly disagrees with the thing it diagnoses is worse than
 * none.
 */
describe("the README's note on what a heartbeat costs", () => {
  const readme = fs.readFileSync(path.join(root, "apps", "hosted-relay", "README.md"), "utf8");

  it("quotes the frame this room actually auto-answers", () => {
    const pair = autoResponse();
    expect(
      readme.includes(pair.request),
      `the README does not quote the frame the room auto-answers (${pair.request}), so a reader checking the ` +
        "billing has nothing to compare against",
    ).toBe(true);
  });

  it("names the script that would show it, and that script is there", () => {
    expect(readme, "the README describes no way to tell whether beats are being billed").toMatch(
      /measure-cost\.cjs/,
    );
    expect(
      fs.existsSync(path.join(root, "apps", "hosted-relay", "scripts", "measure-cost.cjs")),
      "the README points at a measuring script that does not exist",
    ).toBe(true);
  });

  it("says a client cannot tell the difference, because that is the whole trap", () => {
    const flat = readme.replace(/\s+/g, " ").toLowerCase();
    expect(
      /pong either way|answers it too|still gets its pong|still answered/.test(flat),
      "the README does not say that a viewer receives a pong whether or not the auto-response matched. Without " +
        "that, the obvious check - open a viewer, send a ping, see a pong - reads as proof and is not.",
    ).toBe(true);
  });
});

/**
 * The bytes agree. The schedule was nobody's job.
 *
 * Two numbers decide between them whether a viewer that is fine gets thrown
 * off, and they sit in files that cannot import each other - `PING_MS` and
 * `PING_MISSES` in the viewer page, `VIEWER_SILENT_MS` in this Worker. The
 * same shape as the three sizes in `feedbackSizes.test.ts`: numbers in
 * different packages that have to stay in an order, with nothing connecting
 * them.
 *
 * The order, and the reason it is that way round: **the relay must not decide
 * a viewer is gone before the viewer itself would have.** The page gives up
 * after `PING_MISSES` unanswered beats and reconnects on its own, which is a
 * blink. If the relay reaps first, a reader on a slow link is closed while
 * they still believe they are connected, and told `4408 no heartbeat` - which
 * is not what happened, because they were beating.
 *
 * So the reap window has to clear the viewer's own give-up point with a whole
 * beat to spare. Raise the interval to save a phone's battery and this is the
 * check that says the far end has to move too.
 */
describe("the timing the two sides have to agree on", () => {
  const room = fs.readFileSync(path.join(root, "apps", "hosted-relay", "src", "room.ts"), "utf8");

  /** a `const NAME = <number>;` with `_` separators allowed, as written */
  function num(src: string, name: string): number | undefined {
    const m = new RegExp(`const ${name} = (\\d[\\d_]*)`).exec(src);
    return m ? Number(m[1].replace(/_/g, "")) : undefined;
  }

  const pingMs = num(viewerJs, "PING_MS");
  const misses = num(viewerJs, "PING_MISSES");
  const silentMs = num(room, "VIEWER_SILENT_MS");

  it("still has all three numbers to compare", () => {
    // a rename is a question rather than a failure: somebody has to say what
    // the new name is, because the check below cannot ask
    expect(pingMs, "PING_MS is not declared in the viewer page any more").toBeDefined();
    expect(misses, "PING_MISSES is not declared in the viewer page any more").toBeDefined();
    expect(silentMs, "VIEWER_SILENT_MS is not declared in room.ts any more").toBeDefined();
  });

  it("gives up on a viewer only after the viewer would have given up on it", () => {
    const viewerGivesUp = pingMs! * misses!;
    expect(
      silentMs,
      `the viewer beats every ${pingMs}ms and stops after ${misses} unanswered (${viewerGivesUp}ms), and this ` +
        `relay reaps at ${silentMs}ms. Reaping first closes a reader who is beating fine on a slow link and ` +
        "tells them there was no heartbeat",
    ).toBeGreaterThanOrEqual(viewerGivesUp + pingMs!);
  });
});

/**
 * The publisher's heartbeat, which the room now reads too.
 *
 * `dropSilentPublisher` ends a stream whose uplink has stopped beating, and it
 * knows a beat only by the runtime's auto-response timestamp - so the uplink's
 * ping has to be byte for byte the frame the room hands the runtime. If they
 * drift, the timestamp stays null, a null is "has not beaten yet", and the
 * check quietly never fires: a vanished publisher is ON AIR for good again,
 * with every test of the room itself still green.
 *
 * And the same order as for viewers: the room must not decide the publisher is
 * gone before the uplink itself would have given up and reconnected.
 */
describe("the publisher's heartbeat on the hosted relay", () => {
  const uplinkTs = fs.readFileSync(path.join(root, "packages", "companion", "src", "uplinkClient.ts"), "utf8");
  const roomTs = fs.readFileSync(path.join(root, "apps", "hosted-relay", "src", "room.ts"), "utf8");

  it("is the exact frame the runtime auto-answers", () => {
    const pair = autoResponse();
    expect(uplinkTs, "the uplink no longer sends { type: \"ping\" } as its heartbeat").toMatch(/this\.send\(\{ type: "ping" \}\)/);
    expect(uplinkTs, "the uplink no longer sends a message as plain JSON.stringify of it").toMatch(
      /this\.ws!\.send\(JSON\.stringify\(msg\)\)/,
    );
    expect(pair.request).toBe(JSON.stringify({ type: "ping" }));
  });

  it("is given up on only after the uplink would have given up itself", () => {
    const period = Number(/this\.hooks\.pingMs \?\? (\d[\d_]*)/.exec(uplinkTs)?.[1]?.replace(/_/g, ""));
    const misses = Number(/this\.unanswered >= (\d+)/.exec(uplinkTs)?.[1]);
    const silent = Number(/const UPLINK_SILENT_MS = (\d[\d_]*)/.exec(roomTs)?.[1]?.replace(/_/g, ""));
    expect(period, "the uplink's default ping period is not where this looks for it").toBeGreaterThan(0);
    expect(misses, "the uplink's give-up count is not where this looks for it").toBeGreaterThan(0);
    expect(silent, "UPLINK_SILENT_MS is not declared in room.ts any more").toBeGreaterThan(0);
    expect(
      silent,
      `the uplink beats every ${period}ms and gives up after ${misses} unanswered, and this room drops it at ` +
        `${silent}ms - a publisher on a slow link would be ended while it still believes it is connected`,
    ).toBeGreaterThanOrEqual(period * misses + period);
  });
});
