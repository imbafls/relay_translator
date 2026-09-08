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
    version: "0.7.0",
    date: "2026-09-08",
    headline: "Speech that keeps trying, and status that tells the truth",
    changes: [
      {
        kind: "fixed",
        text: "If your speech connection drops - a Wi-Fi blip, an outage, anything - the app now keeps trying to reconnect for as long as the session runs, instead of giving up for good. It used to burn through four attempts in about twelve seconds, which is roughly what an offline connection produces, and then stop trying at all - so anyone captioning through an outage longer than that had to notice and restart the session themselves. It now backs off to retrying every 30 seconds and keeps going until the connection comes back or you press STOP.",
      },
      {
        kind: "fixed",
        text: "If speech recognition is down, the app says so instead of still showing ON AIR. The top bar reads ON AIR · NO SPEECH, and the tray icon's tooltip reads live, no speech - so a dead speech pipeline is visible at a glance instead of looking identical to a working session.",
      },
      {
        kind: "fixed",
        text: "A phone or browser link now shows OFF AIR while the app is open but no session is running. It used to mark the room live on every uplink reconnect, every relay restart, and every settings change - even while the app just sat idle in the tray - so anyone holding the link could see ON AIR when nothing was actually being streamed. This depends on your own app being on 0.7.0: until you update, anyone holding your link still sees the old always-on-air behavior, the same way it worked before this fix.",
      },
      {
        kind: "fixed",
        text: "If there's been nothing but silence for an hour, the app stops sending audio to be transcribed - so a session left running overnight, or while you step away, doesn't keep racking up Deepgram minutes for dead air. The moment real audio comes through again it picks back up on its own; nothing needs restarting.",
      },
      {
        kind: "added",
        text: "SETTINGS now has SEND FEEDBACK: a box to describe a problem, an optional tick to attach your relay.log, and a preview that shows exactly what would be sent before you send it - keys, tokens, viewer links, LAN addresses and your Windows account name are stripped out of the log first. Nothing is sent until you press SEND; typing a message or ticking the log box does not send anything by itself.",
      },
    ],
  },
  {
    version: "0.6.0",
    date: "2026-09-08",
    headline: "A link you send now says whose it is",
    changes: [
      {
        kind: "added",
        text: "You can give your stream a name and a colour, under SETTINGS in WHAT VIEWERS SEE. Anyone opening your link sees it in the header, so a link forwarded to somebody who was not there when you sent it still says who it is from. Leave it blank and nothing shows.",
      },
      {
        kind: "changed",
        text: "Your name and colour do not change how captions are drawn. Size, font, theme and how many lines to keep still belong to the person reading, on their own device - somebody who needs bigger text keeps it.",
      },
      {
        kind: "fixed",
        text: "Speaker colours reach people watching over the internet. Two sources tagged with different colours arrived in the same colour on a phone, and only on a phone - on your own network it always worked, which is why it went unnoticed.",
      },
      {
        kind: "fixed",
        text: "A speaker's name tag reaching people watching over the internet had no length limit. The field you type one into has always stopped you at 12 characters, and your own network has enforced that same limit since the feature shipped - but the internet relay did not, so anything reaching it directly, rather than through the app, could send a longer tag and take up more of a viewer's screen than any caption is meant to. Both paths cap it at 12 characters now.",
      },
    ],
  },
  {
    version: "0.5.13",
    date: "2026-09-07",
    headline: "The download fix in 0.5.12 was corrupting the thing it downloaded",
    changes: [
      {
        kind: "fixed",
        text: "0.5.12 changed the way a model download is read so it could carry on after a dropped connection, and got it wrong: on a large model the data could be altered while it was still arriving. The model then failed with a message about the archive not unpacking, even though nothing was wrong with the file being downloaded. Downloads are correct again. If a model would not install on 0.5.12, it is worth trying once more on this version.",
      },
      {
        kind: "fixed",
        text: "This only ever affected 0.5.12. If you updated from 0.5.11 straight to this version you never had it. Nothing you already have is damaged either: the archive a model arrives in is checksummed as it unpacks, so altered data fails the unpack rather than being installed quietly. That is why the symptom was a model that would not install, and not a model that behaved oddly afterwards.",
      },
      {
        kind: "fixed",
        text: "The log no longer claims a download lost its connection when what really happened was a bad archive. Those are two different faults with two different answers, and the log was naming the wrong one directly above the line that named the right one.",
      },
    ],
  },
  {
    version: "0.5.12",
    date: "2026-09-07",
    headline: "A model download that loses its connection carries on where it stopped",
    changes: [
      {
        kind: "fixed",
        text: "A large speech model used to start again from the beginning every time the connection dropped, so on a line that hiccups even occasionally the big models never finished at all. A download now resumes from the point it reached. Whisper Turbo is 989 MB and Nemotron 651 MB, and neither has to arrive in one unbroken run any more.",
      },
      {
        kind: "fixed",
        text: "Installing a large model could also fail at the very last step, while antivirus was still scanning the files it had just written. The app used to give that under a second to clear and then delete everything it had downloaded. It now waits about half a minute, and if it does run out it tells you what to change. This is the most likely cause of a large model failing to install for you, though it has not been reproduced here.",
      },
      {
        kind: "fixed",
        text: "When a download does fail, the message says whether the connection broke or the archive was bad. It used to report a broken connection as a corrupt archive, which sent you looking in the wrong place.",
      },
      {
        kind: "added",
        text: "Captions in OBS now clear about ten seconds after you stop talking, so a quiet stretch no longer leaves your last sentence sitting on the stream. Anything you say brings them straight back. Open your overlay link and go to display settings to change it: Hide after sets the delay, and Never keeps it on screen the way it used to be.",
      },
    ],
  },
  {
    version: "0.5.11",
    date: "2026-09-07",
    headline: "A failed model download now tells you why",
    changes: [
      {
        kind: "fixed",
        text: "When a speech model fails to download, 02 TRANSCRIBE now shows the reason rather than the words DOWNLOAD FAILED. The app knew why the whole time and had nowhere to put it.",
      },
      {
        kind: "added",
        text: "The app keeps a log file, relay.log, next to your settings in the callout-relay folder. If something fails and you want help with it, that file is the thing to send. Nothing in it leaves your PC on its own.",
      },
      {
        kind: "changed",
        text: "The Stream Deck plugin has been removed. It is no longer part of this product, and the local port it used to listen on is closed - which also means a web page you happen to have open can no longer start or stop your session, change your settings, or replace your viewer link. Nothing else used that port.",
      },
      {
        kind: "fixed",
        text: "If the relay stops accepting your saved address, SETTINGS says ADDRESS NOT ACCEPTED and offers to get you a new one. It used to insist the link still worked and hide the only button that would have fixed it.",
      },
    ],
  },
  {
    version: "0.5.10",
    date: "2026-09-07",
    headline: "Relay has its own address: textrelay.cc",
    changes: [
      {
        kind: "changed",
        text: "The link you send people is now textrelay.cc, which says what it is when it arrives in somebody's messages. Press GET AN ADDRESS THAT WORKS ANYWHERE and that is where you get one.",
      },
      {
        kind: "added",
        text: "There is a page at textrelay.cc now, with the Windows download on it, so you can point someone at one address instead of explaining where to get the app.",
      },
      {
        kind: "fixed",
        text: "A link opened over plain http is sent to https before anything is served. The link is the only thing protecting what is being said, and over http it crossed the network in the clear. The app has always made https links; this covers one retyped or pasted without it.",
      },
      {
        kind: "changed",
        text: "If you already have an address, nothing changes and nothing needs doing. The old one keeps working, and links you have handed out keep working.",
      },
    ],
  },
  {
    version: "0.5.9",
    date: "2026-09-07",
    headline: "Warnings before the mistake, not after it",
    changes: [
      {
        kind: "added",
        text: "04 OUTPUT now tells you that a link on your own network holds ONE DEVICE AT A TIME, before someone finds out by being disconnected. It also stopped saying RELAY NOT SET, which meant nothing to anyone: it says THIS NETWORK ONLY, the same words as the panel that fixes it.",
      },
      {
        kind: "changed",
        text: "NEW asks before it replaces your link, if anybody is reading. It sits between COPY and OPEN and it disconnects everyone, and it used to do that on one press with no warning. Press it once and it reads SURE? for five seconds, and the log says how many people are on the link. With nobody reading it still goes on the first press, because there is nothing to lose.",
      },
      {
        kind: "fixed",
        text: "A key you unhid with SHOW does not stay unhidden. Nothing ever put those fields back, so a key revealed to check a paste was still in plain text an hour later when SETTINGS was opened for something else - on screen, in front of whoever was watching. Every key and token now hides itself again when you leave the panel, and after twenty seconds.",
      },
    ],
  },
  {
    version: "0.5.8",
    date: "2026-09-07",
    headline: "The phone page stops guessing why it lost the link",
    changes: [
      {
        kind: "fixed",
        text: "When a second phone opens the same link, the first one now says so - Someone else opened this link, and trying again takes it back. It used to say the session was stopped or a new link was made, which was not what happened, and sent the person reading off to ask you for a link they already had. On your own network only one device can read a link at a time, so this is the most common way it happens; getting an address under WHO CAN OPEN IT removes the limit as well as explaining it.",
      },
      {
        kind: "fixed",
        text: "Setup no longer tells you to set a relay URL under KEYS. There has been no panel called KEYS since 0.5.5, and pasting a relay address by hand has not been the way to reach a phone since 0.5.7 - it points at the one press that does it now. Three other places still saying KEYS were fixed with it.",
      },
      {
        kind: "changed",
        text: "There is a written guide, for setting this up rather than working on it - the first run, getting a link onto somebody else's phone, and what the person reading sees on their end. Linked from SETTINGS, next to the button that gets you an address.",
      },
      {
        kind: "fixed",
        text: "The hint under a second audio source said the first is tagged YOU and the second CHAT. System audio is tagged CHAT whichever slot it is in, so that was wrong whenever system audio came first.",
      },
    ],
  },
  {
    version: "0.5.7",
    date: "2026-09-07",
    headline: "One button for a link that works outside your network",
    changes: [
      {
        kind: "added",
        text: "SETTINGS now has WHO CAN OPEN IT. Until you press it, your link only opens on your own network - so a phone on mobile data, or anyone not in the house, cannot read your captions at all. One press gets you a private address and the link works anywhere. Nothing to type, no account, and whoever you send it to just opens it in a browser: no app, no install, nothing to sign into.",
      },
      {
        kind: "added",
        text: "That address is worth having even at home. The app's own relay only lets one device watch at a time - a second phone, or a phone and an OBS overlay, kick each other off. On the shared address as many people can read along as you like.",
      },
      {
        kind: "changed",
        text: "The viewer link is no longer written out in full at the bottom of the window. Anyone who can read that link can read your captions, and it sat on screen for the whole session, which is a problem if you share your screen or someone is standing behind you. Click it when you want to see it; COPY still copies the real one either way.",
      },
    ],
  },
  {
    version: "0.5.6",
    date: "2026-09-07",
    headline: "Captions that keep up, and links that tell the truth",
    changes: [
      {
        kind: "fixed",
        text: "A phone opening a link that has been replaced is now told so, instead of sitting on RECONNECTING for ever. A refused link and a dropped tunnel used to look identical to the page, so the one thing it could not say was the one thing that had happened.",
      },
      {
        kind: "fixed",
        text: "The timer on the phone counted from your clock, not the viewer's, so anyone whose phone was a few seconds out saw the wrong session length - and a phone running behind sat at 00:00:00 all night.",
      },
      {
        kind: "fixed",
        text: "A START that fails no longer spends your viewer link on the way. It used to rotate and save a new one before checking the relay was there, so three presses while the port was busy invalidated the link three times and kicked everyone watching, with only start failed on screen.",
      },
      {
        kind: "fixed",
        text: "Half-finished captions no longer stay on the phone for ever. A cough or a false start left a blinking line that nothing cleared, and reconnecting to a stream that was not live kept one under the OFF AIR badge.",
      },
      {
        kind: "fixed",
        text: "A phone that vanishes without hanging up - out of range, screen off, aeroplane mode - is now actually dropped. The heartbeat pinged, never checked for a reply, and went on counting a viewer who had gone.",
      },
      {
        kind: "fixed",
        text: "Two copies of the app on one publish token no longer displace each other about once a second for ever, losing every subtitle in between.",
      },
      {
        kind: "fixed",
        text: "The last thing said before you press STOP now reaches the phone when you are running a model on your own PC. The engine was given four seconds flat to finish, which is not enough for a heavy model, and whatever it produced after that was thrown away without a word.",
      },
      {
        kind: "fixed",
        text: "A local speech model too slow for the PC it is on now says so and drops audio, rather than falling further behind every minute for the rest of the session with nothing on screen to explain why the captions are minutes late.",
      },
      {
        kind: "fixed",
        text: "Could not start no longer prints on top of the transcript. The panel has a background now, so the reason it stopped is readable and what was said is still there behind it.",
      },
      {
        kind: "fixed",
        text: "Checking a key just after closing setup no longer repaints the live console as a setup placeholder, greying the signal chain and hiding the device pickers until something else happened to redraw it.",
      },
      {
        kind: "fixed",
        text: "Downloading two speech models at once no longer corrupts the voice-detection file they share, which could leave it quietly broken for every model that needed it.",
      },
      {
        kind: "fixed",
        text: "Changing the update feed takes effect on the next check rather than the next launch, and clearing it says plainly that the normal feed comes back on restart.",
      },
      {
        kind: "fixed",
        text: "Something already using the app's local control port no longer stops the app opening at all. It used to take the window, the tray icon and the updater with it, and leave a copy running that made every relaunch quit in silence.",
      },
      {
        kind: "changed",
        text: "The local control API no longer has a route that handed your viewer link to anything that asked. Nothing used it at all, so it is gone rather than guarded.",
      },
    ],
  },
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
        text: "The tray hands out the phone link, not the transparent OBS overlay. On a fresh install it gave out the overlay, which on a phone is white text on whatever the browser's background happens to be.",
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
