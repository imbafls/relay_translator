import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, MAX_CAPTURE_CHANNELS, resolveSourceIds, speakerTags } from "../src/index";
import type { AppConfig } from "../src/index";

/**
 * The app stored exactly two audio sources, in two named fields. Three needs a
 * list, and the two fields cannot simply be deleted: they are what the Stream
 * Deck property inspector writes through the control API, and what every
 * config.json already on disk contains.
 *
 * So `sources` is the truth and the pair is the legacy interface, folded in
 * when it is the only thing present. This pins which one wins, because getting
 * that backwards silently reverts a user's third source every time the Stream
 * Deck touches anything.
 */
const cfg = (over: Partial<AppConfig>): AppConfig => ({ ...DEFAULT_CONFIG, ...over }) as AppConfig;

describe("which audio sources a config names", () => {
  it("reads the pair when that is all there is, which is every config on disk today", () => {
    expect(resolveSourceIds(cfg({ audioSource: "mic-a", audioSource2: "loopback" }))).toEqual(["mic-a", "loopback"]);
  });

  it("treats an empty second field as one source, not two", () => {
    expect(resolveSourceIds(cfg({ audioSource: "mic-a", audioSource2: "" }))).toEqual(["mic-a"]);
  });

  it("prefers the list once there is one", () => {
    const c = cfg({ sources: ["a", "b", "c"], audioSource: "stale", audioSource2: "also-stale" });
    expect(resolveSourceIds(c)).toEqual(["a", "b", "c"]);
  });

  it("keeps slot order, because the speaker tag follows the slot", () => {
    expect(resolveSourceIds(cfg({ sources: ["system-loopback", "default-mic"] }))).toEqual([
      "system-loopback",
      "default-mic",
    ]);
  });

  it("collapses a device chosen twice rather than transcribing one voice on two channels", () => {
    expect(resolveSourceIds(cfg({ sources: ["a", "a", "b"] }))).toEqual(["a", "b"]);
  });

  it("drops blanks instead of opening a channel for nothing", () => {
    expect(resolveSourceIds(cfg({ sources: ["a", "", "b"] }))).toEqual(["a", "b"]);
  });

  it("stops at the cap the worklet and the relay agree on", () => {
    expect(resolveSourceIds(cfg({ sources: ["a", "b", "c", "d"] }))).toHaveLength(MAX_CAPTURE_CHANNELS);
  });

  it("falls back to the default microphone rather than starting with nothing", () => {
    expect(resolveSourceIds(cfg({ sources: [], audioSource: "" }))).toEqual(["default-mic"]);
  });

  it("ignores a list that is not a list, which is what a hand-edited config gives", () => {
    const c = cfg({ audioSource: "mic-a" });
    (c as unknown as Record<string, unknown>).sources = "mic-b";
    expect(resolveSourceIds(c)).toEqual(["mic-a"]);
  });

  it("ignores non-string entries rather than opening a channel named [object Object]", () => {
    const c = cfg({ audioSource: "mic-a" });
    (c as unknown as Record<string, unknown>).sources = ["good", 7, null, { id: "x" }];
    expect(resolveSourceIds(c)).toEqual(["good"]);
  });
});

describe("what each source is called on a caption", () => {
  /**
   * The rule lived in the renderer, where nothing could reach it, and it was
   * structurally binary: it compared kinds[0] against kinds[1] and returned the
   * two-element literal ["YOU", "CHAT"]. With three sources it handed back a
   * two-long array for a three-channel session, so the relay fell through to
   * "CH3" for the third and the streamer had no way to change that.
   *
   * The role follows the SLOT, not the device kind: a chat mix off a virtual
   * audio device (Wave Link, VoiceMeeter, VB-Cable) enumerates as a microphone
   * exactly like a headset does, so the kind cannot tell "me" from "the
   * others". A system source is the exception - it is always the other voices,
   * whichever slot it sits in.
   */
  it("says nothing when there is only one source, because there is nobody to tell apart", () => {
    expect(speakerTags(["mic"])).toEqual([]);
  });

  it("keeps the two-source rule exactly as it was", () => {
    expect(speakerTags(["mic", "system"])).toEqual(["YOU", "CHAT"]);
    expect(speakerTags(["system", "mic"])).toEqual(["CHAT", "YOU"]);
    expect(speakerTags(["mic", "mic"])).toEqual(["YOU", "CHAT"]);
  });

  it("gives the third slot a tag of its own instead of leaving it unnamed", () => {
    const tags = speakerTags(["mic", "system", "mic"]);
    expect(tags).toHaveLength(3);
    expect(new Set(tags).size, `two sources would share a tag: ${tags.join("/")}`).toBe(3);
  });

  it("uses the name the user gave a slot", () => {
    expect(speakerTags(["mic", "system", "mic"], ["OMER", "GAME", "COACH"])).toEqual(["OMER", "GAME", "COACH"]);
  });

  it("fills only the slots left blank, so naming one does not erase the rest", () => {
    expect(speakerTags(["mic", "system"], ["", "GAME"])).toEqual(["YOU", "GAME"]);
    expect(speakerTags(["mic", "system"], [undefined, "GAME"])).toEqual(["YOU", "GAME"]);
  });

  it("trims a name, so a stray space is not a different speaker", () => {
    expect(speakerTags(["mic", "mic"], ["  OMER  ", ""])).toEqual(["OMER", "CHAT"]);
  });

  it("cuts a name to what the relay will accept, rather than having it cut later", () => {
    // server.ts slices channelLabels to 12 characters; doing it here means the
    // app shows the same string the viewer will
    const [tag] = speakerTags(["mic", "mic"], ["A-REALLY-LONG-NAME", ""]);
    expect(tag).toHaveLength(12);
  });

  it("ignores a label list that is not a list of strings", () => {
    expect(speakerTags(["mic", "system"], [7 as unknown as string, null as unknown as string])).toEqual(["YOU", "CHAT"]);
  });
});
