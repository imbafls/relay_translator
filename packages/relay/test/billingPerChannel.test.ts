import { describe, expect, it } from "vitest";
import { PublisherSession } from "../src/session";
import type { SttEvents } from "../src/deepgram";

/**
 * What adding a capture source actually costs.
 *
 * `session.ts` bills `seconds * channels` to the cloud counter and nothing to
 * it for a local model, with the comment "Deepgram bills every channel". The
 * app shows that spend only once a session is running - `docs/OPEN-WORK.md`
 * carries the open item to say it beforehand, and an item nobody can trust is
 * not worth picking up. This pins the number that item rests on.
 *
 * The unit that matters is wall-clock, not bytes. Capturing three sources for
 * a minute produces three times the audio, which is precisely why it costs
 * three times as much; a test holding BYTES constant would measure the divide
 * and the multiply cancelling and would pin nothing at all.
 */

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

/** bytes for `seconds` of wall-clock capture from `channels` interleaved sources */
function captured(seconds: number, channels: number): Buffer {
  return Buffer.alloc(SAMPLE_RATE * BYTES_PER_SAMPLE * channels * seconds, 1);
}

async function billFor(stt: string, channels: number): Promise<{ seconds: number; localSeconds: number }> {
  const stats = { seconds: 0, localSeconds: 0 };
  const session = new PublisherSession(
    {
      stt,
      translation: "gemini-3.1-flash-lite",
      languages: { source: "en", target: "vi" },
      translationEnabled: false,
      latencyVisible: true,
      profanityFilter: false,
      channels,
    },
    {
      // a stream that accepts everything: this measures what is billed, not
      // what survives a socket that is refusing chunks
      makeStt: (events: SttEvents) => {
        setImmediate(() => events.onOpen?.());
        return { sendAudio: () => true, close: () => {} };
      },
      toViewers: () => {},
      setLive: () => {},
      log: () => {},
      sttStats: stats,
    },
  );
  session.start();
  await new Promise((r) => setTimeout(r, 0));
  session.audio(captured(2, channels));
  session.stop();
  return stats;
}

describe("what a capture source costs", () => {
  it("bills a cloud model once per source, so three sources cost three times one", async () => {
    const one = await billFor("deepgram-nova-3", 1);
    const three = await billFor("deepgram-nova-3", 3);

    expect(one.seconds, "one source billed nothing, so this test is measuring nothing").toBeGreaterThan(0);
    expect(
      three.seconds / one.seconds,
      "three sources no longer cost three times one. docs/OPEN-WORK.md tells the reader that adding a " +
        "source multiplies the Deepgram bill and that the app only says so once the session is running. " +
        "If billing has stopped scaling per channel, fix that entry before someone acts on it.",
    ).toBeCloseTo(3, 5);
  });

  it("bills a local model nothing, which is the whole reason it is offered", async () => {
    const local = await billFor("local-zipformer-en-20m", 3);

    expect(local.localSeconds, "the local counter never moved, so this test is measuring nothing").toBeGreaterThan(0);
    expect(
      local.seconds,
      "a local model charged the cloud counter. On-device STT costs nothing and the running total in the " +
        "app would now claim otherwise.",
    ).toBe(0);
  });
});
