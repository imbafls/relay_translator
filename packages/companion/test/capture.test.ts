import { afterEach, describe, expect, it } from "vitest";
import { BrowserAudioCapture, SOURCE_DEFAULT_MIC, SOURCE_SYSTEM_LOOPBACK } from "../src/capture";

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
