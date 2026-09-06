/**
 * What the app shows after it updates itself.
 *
 * Written for the person streaming, not for the repo: they did not choose to
 * update - it happened on restart - so the panel has to justify the interruption
 * in a few seconds. Entries lead with what changed for them, and a release with
 * nothing user-visible says so plainly rather than inventing significance.
 *
 * Newest first. `version` must match the tag exactly, because that is what the
 * running app compares against.
 */

export type ChangeKind = "added" | "fixed" | "changed";

export interface ChangeLine {
  kind: ChangeKind;
  text: string;
}

export interface ChangelogEntry {
  version: string;
  /** YYYY-MM-DD */
  date: string;
  /** one line, shown large - the reason this release exists */
  headline: string;
  changes: ChangeLine[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.5.5",
    date: "2026-09-06",
    headline: "Settings you can actually find, and up to three audio sources",
    changes: [
      {
        kind: "added",
        text: "SETTINGS. Everything you can change is behind one button, bottom right, or Ctrl and comma. It used to say KEYS, sat among the cost figures, and half the things you would look for were somewhere else entirely. The relay and port fields almost nobody needs are tucked behind ADVANCED.",
      },
      {
        kind: "added",
        text: "Up to three audio sources instead of two. Each is transcribed on its own channel and carries its own name and colour on the captions, so you, your team and a coach are told apart at a glance. Name them and pick their colours under SETTINGS; choose the devices under 01 SOURCE.",
      },
      {
        kind: "added",
        text: "The caption view's own display settings - size, font, colours - are one click from SETTINGS, including for the OBS overlay, where that button otherwise only appears on hover.",
      },
      {
        kind: "fixed",
        text: "THIS LINK HAS ENDED no longer appears on your broadcast. On the default link mode every press of START rotated the link, which kicked your OBS source and painted that panel onto the stream, where it stayed until you refreshed it.",
      },
      {
        kind: "fixed",
        text: "A phone that drops its connection and comes back no longer kills the good one. The reconnect could close the healthy socket, leaving a live session showing THIS LINK HAS ENDED until the page was reloaded.",
      },
      {
        kind: "fixed",
        text: "If speech recognition stops working, the app says so and reconnects. A dropped connection used to leave it ON AIR with the clock running, producing nothing and still counting billed minutes for audio that went nowhere.",
      },
      {
        kind: "fixed",
        text: "Unplugging a microphone mid-session is noticed and named. It used to leave the session live and silent, with the microphone indicator still lit and that speaker's captions simply stopped.",
      },
      {
        kind: "fixed",
        text: "Pressing STOP while the app is still opening a device now actually stops. It could leave the microphone held open behind an idle screen until the next time you started.",
      },
      {
        kind: "fixed",
        text: "A device unplugged since last time no longer traps you. It is dropped, and the app says which slot it was, instead of failing every START with the single word OverconstrainedError.",
      },
      {
        kind: "fixed",
        text: "A local port that cannot be used is refused rather than accepted. Typing one another program already owns used to save it, break the app, and report success - and it stayed broken after a restart.",
      },
      {
        kind: "fixed",
        text: "Speech is transcribed more accurately. The audio was being reduced to 16 kHz with no filter in front of it, folding everything above 8 kHz back over your voice.",
      },
      {
        kind: "fixed",
        text: "Translation that stops working says so. One failure used to silence every later one for the rest of the session, leaving viewers looking at a placeholder with nothing to explain it.",
      },
      {
        kind: "fixed",
        text: "The tray and the Stream Deck hand out the phone link, not the transparent OBS overlay. On a fresh install they gave out the overlay, which on a phone is white text on whatever the browser's background happens to be.",
      },
      {
        kind: "fixed",
        text: "A model download that fails now says which half failed - the download or the archive. It blamed the network every time, including for archives that had arrived perfectly.",
      },
    ],
  },
  {
    version: "0.5.4",
    date: "2026-09-06",
    headline: "Captions appear as you speak, and the OBS overlay finally has its settings",
    changes: [
      {
        kind: "fixed",
        text: "Captions now appear on the OBS overlay while you are still speaking, instead of only when you finish a sentence. The overlay was building the in-progress line and never showing it, so it ran a whole sentence behind.",
      },
      {
        kind: "fixed",
        text: "The OBS overlay link is reachable. On the default settings the app only offered the phone link, so putting captions into a browser source meant using the wrong URL and getting an opaque page instead of a transparent overlay.",
      },
      {
        kind: "fixed",
        text: "The link mode you pick is kept. Choosing a fixed link so your OBS source keeps working could silently revert, and the next start then rotated the link and put THIS LINK HAS ENDED on your broadcast.",
      },
      {
        kind: "fixed",
        text: "No more warning about a Deepgram key when you are running speech on your own machine and do not need one.",
      },
      {
        kind: "added",
        text: "Profanity filter, on by default. Viewers see f*** while your own log keeps the words as heard, so you can still tell what the microphone got. It masks the text as it streams in, not just the finished line.",
      },
      {
        kind: "added",
        text: "The display settings are reachable in OBS. Hover the top of the browser source while Interact is open and the bar appears; it stays invisible in the broadcast. Add &bar=0 to the URL to drop the amber marker beside the caption.",
      },
      { kind: "fixed", text: "COPY LINK works. It had never worked - the copy was being refused and the failure said nothing useful." },
      { kind: "fixed", text: "The latency badge shows the real number. It read 0ms for every caption after the first one in a session." },
      { kind: "fixed", text: "Pasting a new API key sticks. Re-running setup could hand back the key you had just replaced, so it looked like the app had ignored you." },
      { kind: "fixed", text: "No more red connection error on every START SESSION. Nothing was wrong; the relay was talking to the speech engine a moment too early." },
    ],
  },
  {
    version: "0.5.3",
    date: "2026-09-05",
    headline: "Nothing you can see - build and release plumbing only",
    changes: [
      { kind: "changed", text: "The Linux relay server is now tested on Linux before it is published. Same app as 0.5.2." },
    ],
  },
  {
    version: "0.5.2",
    date: "2026-09-05",
    headline: "Relay hardening - 36 fixes, and the first real test suite",
    changes: [
      { kind: "fixed", text: "A single malformed request could shut the public relay down. So could a four-byte message. Both are closed." },
      { kind: "fixed", text: "The Stream Deck key did nothing at all - the action was never registered." },
      { kind: "fixed", text: "A long translated line could be published half-finished and then remembered that way, so every repeat of the callout came back cut off." },
      { kind: "fixed", text: "Captions could restart their numbering mid-session and overwrite rows already on a viewer's screen." },
      { kind: "fixed", text: "The local settings API handed out your API keys and viewer link to anything that asked." },
      { kind: "fixed", text: "Every abandoned installer download leaked a file handle on the server." },
    ],
  },
  {
    version: "0.5.1",
    date: "2026-09-05",
    headline: "A way back to the cloud, and the other speaker gets their own colour",
    changes: [
      { kind: "added", text: "Switch back to cloud speech after trying a local model, without redoing setup." },
      { kind: "fixed", text: "Speaker roles were the wrong way round with two audio sources." },
    ],
  },
  {
    version: "0.5.0",
    date: "2026-09-05",
    headline: "Local speech models you can run without an API key",
    changes: [
      { kind: "added", text: "Download a speech model and transcribe on this PC. No key, no per-minute cost, and it keeps working offline." },
      { kind: "added", text: "A model list that recommends a tier based on the machine it is running on." },
    ],
  },
  {
    version: "0.4.0",
    date: "2026-09-05",
    headline: "Two audio sources at once, tagged YOU and CHAT",
    changes: [
      { kind: "added", text: "Capture your microphone and voice chat together. Each is transcribed separately and captions carry a speaker tag." },
      { kind: "added", text: "Setup can be re-run at any time from KEYS or the tray." },
    ],
  },
];

/** numeric compare of x.y.z; anything unparseable sorts lowest */
function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v
      .replace(/^v/, "")
      .split(/[.-]/)
      .map((p) => Number.parseInt(p, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Entries to show on this launch: everything newer than what was last seen, up
 * to and including what is running now.
 *
 * `seen` undefined means a fresh install rather than an update - there is no
 * "what's new" for someone who has never run it, so nothing is returned and the
 * caller just records the current version.
 *
 * Entries newer than `current` are held back, so a changelog written ahead of a
 * release does not announce itself early.
 */
export function changesSince(seen: string | undefined, current: string): ChangelogEntry[] {
  if (!seen || !current) return [];
  if (compareVersions(seen, current) >= 0) return [];
  return CHANGELOG.filter(
    (e) => compareVersions(e.version, seen) > 0 && compareVersions(e.version, current) <= 0,
  );
}
