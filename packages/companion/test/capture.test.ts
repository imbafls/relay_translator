import { afterEach, describe, expect, it } from "vitest";
import {
  anyTrackLive,
  BrowserAudioCapture,
  captureSources,
  rmsLevel,
  SOURCE_DEFAULT_MIC,
  SOURCE_SYSTEM_LOOPBACK,
  watchSourceTracks,
} from "../src/capture";
import { clampChannels, MAX_CAPTURE_CHANNELS } from "@callout-relay/shared";

/**
 * listDevices is what fills both source pickers, and picking the wrong thing in
 * the second one is the single most confusing failure this app has - two
 * channels that transcribe the same voice, with nothing to say why. The mapping
 * itself is plain logic over one browser call, so only that call is stood in
 * for here.
 */

type FakeDevice = { kind: string; deviceId: string; label: string };

// Node ships its own `navigator`, and it is getter-only, so it has to be
// redefined rather than assigned
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
}

function enumerate(devices: FakeDevice[] | Error): void {
  setNavigator({
    mediaDevices: {
      enumerateDevices: async () => {
        if (devices instanceof Error) throw devices;
        return devices;
      },
    },
  });
}

afterEach(() => {
  if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
  else delete (globalThis as { navigator?: unknown }).navigator;
});

const mic = (deviceId: string, label = ""): FakeDevice => ({ kind: "audioinput", deviceId, label });

describe("the source list", () => {
  it("always offers the two built-in sources first", async () => {
    enumerate([]);
    const list = await new BrowserAudioCapture().listDevices();
    expect(list.map((d) => d.id)).toEqual([SOURCE_DEFAULT_MIC, SOURCE_SYSTEM_LOOPBACK]);
    expect(list[1].kind).toBe("system");
  });

  it("still offers them when the browser refuses to enumerate", async () => {
    // permission not granted yet: an empty picker would look broken
    enumerate(new Error("NotAllowedError"));
    const list = await new BrowserAudioCapture().listDevices();
    expect(list.map((d) => d.id)).toEqual([SOURCE_DEFAULT_MIC, SOURCE_SYSTEM_LOOPBACK]);
  });

  it("lists real microphones after them", async () => {
    enumerate([mic("hw-1", "Wave Link Microphone FX"), mic("hw-2", "Wave Link Voice chat")]);
    const list = await new BrowserAudioCapture().listDevices();
    expect(list.map((d) => d.label)).toEqual([
      "Default microphone",
      "System audio (game + comms)",
      "Wave Link Microphone FX",
      "Wave Link Voice chat",
    ]);
  });

  it("ignores anything that is not an audio input", async () => {
    enumerate([
      { kind: "videoinput", deviceId: "cam", label: "Webcam" },
      { kind: "audiooutput", deviceId: "spk", label: "Speakers" },
      mic("hw-1", "Microphone FX"),
    ]);
    const list = await new BrowserAudioCapture().listDevices();
    expect(list.map((d) => d.id)).toEqual([SOURCE_DEFAULT_MIC, SOURCE_SYSTEM_LOOPBACK, "hw-1"]);
  });

  it("names a microphone the browser will not name", async () => {
    // labels are empty until permission is granted
    enumerate([mic("hw-1"), mic("hw-2")]);
    const list = await new BrowserAudioCapture().listDevices();
    expect(list.slice(2).map((d) => d.label)).toEqual(["Microphone 1", "Microphone 2"]);
  });

  it("drops an entry with no device id", async () => {
    enumerate([mic("", "Nameless"), mic("hw-1", "Real")]);
    const list = await new BrowserAudioCapture().listDevices();
    expect(list.map((d) => d.id)).toEqual([SOURCE_DEFAULT_MIC, SOURCE_SYSTEM_LOOPBACK, "hw-1"]);
  });
});

describe("the pseudo-devices Windows adds", () => {
  it("does not repeat the default microphone", async () => {
    // "default" is already offered as the first entry
    enumerate([mic("default", "Default - Microphone FX"), mic("hw-1", "Microphone FX")]);
    const list = await new BrowserAudioCapture().listDevices();
    expect(list.map((d) => d.id)).toEqual([SOURCE_DEFAULT_MIC, SOURCE_SYSTEM_LOOPBACK, "hw-1"]);
  });

  it("does not offer the communications device as a separate source", async () => {
    // Windows exposes "communications" alongside "default": a second alias for
    // a device already in the list. Two entries that are the same input is the
    // exact shape of the confusion the second source picker already causes.
    enumerate([
      mic("communications", "Communications - Microphone FX"),
      mic("hw-1", "Microphone FX"),
    ]);
    const list = await new BrowserAudioCapture().listDevices();
    expect(list.map((d) => d.id)).toEqual([SOURCE_DEFAULT_MIC, SOURCE_SYSTEM_LOOPBACK, "hw-1"]);
  });
});

describe("how many sources a capture opens", () => {
  /**
   * The rule used to live inline in start(), as
   * `.filter(unique).slice(0, 2)`, where nothing could reach it: start() wants
   * an AudioContext, an AudioWorklet and a real getUserMedia, and standing all
   * three up would have meant testing a reimplementation. It is a pure
   * function now, and this is the shipped one.
   */
  it("takes a bare string as a single source", () => {
    expect(captureSources("default-mic")).toEqual(["default-mic"]);
  });

  it("collapses the same device picked twice, which would transcribe one voice on two channels", () => {
    expect(captureSources(["default-mic", "default-mic"])).toEqual(["default-mic"]);
  });

  it("drops empty slots rather than opening a channel for nothing", () => {
    expect(captureSources(["default-mic", "", "system-loopback"])).toEqual(["default-mic", "system-loopback"]);
  });

  it("opens three, which two used to cap", () => {
    expect(captureSources(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("stops at the cap the worklet and the relay agree on", () => {
    expect(captureSources(["a", "b", "c", "d", "e"])).toHaveLength(MAX_CAPTURE_CHANNELS);
  });

  it("keeps the order picked, because the speaker tag follows the slot", () => {
    expect(captureSources(["system-loopback", "default-mic"])).toEqual(["system-loopback", "default-mic"]);
  });
});

describe("the level meter's view of an interleaved frame", () => {
  /**
   * The meter walked the frame with a stride of 3, and the comment said "odd
   * stride so interleaved stereo frames feed both channels into the meter".
   * That reasoning holds only while the stride and the channel count share no
   * factor. At three channels a stride of three lands on channel 0 every time:
   * the meter moves, looks entirely plausible, and two of the three sources
   * are invisible in it. Nothing crashes and nothing is logged - the streamer
   * just cannot see that comms are dead.
   */
  const interleave = (lanes: number[][]): Int16Array => {
    const frames = lanes[0].length;
    const out = new Int16Array(frames * lanes.length);
    for (let i = 0; i < frames; i++) for (let c = 0; c < lanes.length; c++) out[i * lanes.length + c] = lanes[c][i];
    return out;
  };
  const silence = (n: number): number[] => new Array(n).fill(0);
  const loud = (n: number): number[] => new Array(n).fill(16000);

  it("sees a lone third source that a stride of three walked straight past", () => {
    const frame = interleave([silence(300), silence(300), loud(300)]);
    expect(rmsLevel(frame)).toBeGreaterThan(0.1);
  });

  it("sees a lone second source", () => {
    expect(rmsLevel(interleave([silence(300), loud(300)]))).toBeGreaterThan(0.1);
  });

  it("still reads silence as silence", () => {
    expect(rmsLevel(interleave([silence(300), silence(300), silence(300)]))).toBe(0);
  });

  it("reads a mono frame the same way", () => {
    expect(rmsLevel(interleave([loud(300)]))).toBeGreaterThan(0.1);
  });

  it("is not fooled into reporting full scale by one loud lane", () => {
    // three lanes, one loud: the meter is the frame's RMS, not the loudest lane
    const mixed = rmsLevel(interleave([silence(300), silence(300), loud(300)]));
    const all = rmsLevel(interleave([loud(300), loud(300), loud(300)]));
    expect(mixed).toBeLessThan(all);
  });
});

describe("the count the session announces against the count capture opens", () => {
  /**
   * These are two different rules in two different packages, and they have to
   * agree exactly: the relay re-cuts each interleaved frame by the number in
   * the publisher hello. They did not agree - the renderer announced
   * `sources.length === 2 ? 2 : 1`, so three sources were declared as one while
   * capture opened three lanes. A frame read on the wrong stride still decodes
   * to fluent speech, from the wrong people.
   *
   * This pins the contract those two sides now share. It does not reach the
   * call site itself, which needs an AudioContext and a live relay - that was
   * caught in a browser, by a session refusing to start.
   */
  it("agrees for every source count the app can produce", () => {
    const ids = ["a", "b", "c", "d", "e"];
    for (let n = 1; n <= ids.length; n++) {
      const opened = captureSources(ids.slice(0, n)).length;
      expect(clampChannels(opened), `${n} sources opened ${opened} lanes, announced as something else`).toBe(opened);
    }
  });
});

describe("a capture device that goes away mid-session", () => {
  /**
   * Audit finding 21. No `ended` listener existed anywhere in this package, and
   * `capturing` reported a boolean flag rather than any track's state. Unplug a
   * USB headset mid-game and the track ends, the merger input feeds digital
   * silence, the app stays LIVE with the clock running, full-rate interleaved
   * PCM keeps flowing so Deepgram keeps billing at the full channel rate, and
   * that speaker's captions simply stop. The other channel keeps the level bar
   * moving, so nothing on screen even hints at it.
   */
  type FakeTrack = {
    readyState: string;
    listeners: (() => void)[];
    addEventListener(type: string, fn: () => void): void;
    stop(): void;
  };
  const track = (readyState = "live"): FakeTrack => ({
    readyState,
    listeners: [],
    addEventListener(type, fn) {
      if (type === "ended") this.listeners.push(fn);
    },
    stop() {
      this.readyState = "ended";
    },
  });
  const streamOf = (t: FakeTrack): MediaStream =>
    ({ getAudioTracks: () => [t] }) as unknown as MediaStream;
  const end = (t: FakeTrack): void => {
    t.readyState = "ended";
    for (const fn of t.listeners) fn();
  };

  it("reports which slot was lost", () => {
    const a = track();
    const b = track();
    const lost: { index: number; live: number }[] = [];
    watchSourceTracks([streamOf(a), streamOf(b)], (info) => lost.push(info));

    end(b);
    expect(lost).toEqual([{ index: 1, live: 1 }]);
  });

  it("says nothing while every device is still there", () => {
    const a = track();
    const lost: unknown[] = [];
    watchSourceTracks([streamOf(a)], (i) => lost.push(i));
    expect(lost).toEqual([]);
  });

  it("says how many are left, so the caller can tell 'one gone' from 'all gone'", () => {
    const a = track();
    const b = track();
    const c = track();
    const lost: { index: number; live: number }[] = [];
    watchSourceTracks([streamOf(a), streamOf(b), streamOf(c)], (info) => lost.push(info));

    end(b);
    end(a);
    end(c);
    expect(lost.map((l) => l.live)).toEqual([2, 1, 0]);
  });

  it("reports a device that had already gone before anyone looked", () => {
    // a track can end between getUserMedia resolving and the graph being wired;
    // "ended" has already fired by then and will never fire again
    const gone = track("ended");
    const lost: { index: number }[] = [];
    watchSourceTracks([streamOf(gone)], (info) => lost.push(info));
    expect(lost.map((l) => l.index), "a device that was already gone went unnoticed").toEqual([0]);
  });

  it("knows whether anything is still being captured", () => {
    const a = track();
    const b = track();
    expect(anyTrackLive([streamOf(a), streamOf(b)])).toBe(true);
    end(a);
    expect(anyTrackLive([streamOf(a), streamOf(b)]), "one live track is still capturing").toBe(true);
    end(b);
    expect(anyTrackLive([streamOf(a), streamOf(b)]), "every device gone, still reported as capturing").toBe(false);
  });

  it("treats no streams at all as not capturing", () => {
    expect(anyTrackLive([])).toBe(false);
  });

  /**
   * The getter, not the helper underneath it. Reaching it the honest way needs
   * an AudioContext and an AudioWorklet, so the state start() would have left
   * behind is set directly - white-box, but it runs the shipped getter rather
   * than a rewrite of it, and the whole defect was that this returned a flag.
   */
  it("stops calling itself capturing once every device has gone", () => {
    const a = track();
    const b = track();
    const cap = new BrowserAudioCapture();
    const priv = cap as unknown as { active: boolean; streams: MediaStream[] };
    priv.active = true;
    priv.streams = [streamOf(a), streamOf(b)];

    expect(cap.capturing).toBe(true);
    end(a);
    expect(cap.capturing, "one device left is still capturing").toBe(true);
    end(b);
    expect(cap.capturing, "the app stayed LIVE with every device unplugged").toBe(false);
  });
});
