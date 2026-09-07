# Using Callout Relay

Callout Relay listens to a microphone, or to the sound coming out of your PC,
turns what it hears into text, and puts that text on a web page. You send
someone the address of that page. They open it on a phone and read what is
being said, about a second behind. They install nothing, and there is no
account and no sign-in on their side.

This guide is for the person running the app on Windows. If you are setting it
up for somebody else — a friend or a relative who is deaf or hard of hearing,
or who is not in the room — the only thing they ever need is the link at the
end of part two.

---

## Part one — first run

The app opens on a setup screen with three markers along the top: `1 SPEECH`,
`2 TRANSLATION`, `3 READY`. You can return to it later from `SETTINGS` →
`RUN SETUP AGAIN`, or from the tray menu's **Run setup again**.

### Step 1 of 3 — speech

The one decision that matters. Choose `Cloud · Deepgram` or `Local · this PC`.

- **Cloud** uses a service called Deepgram. It is the fastest and the most
  accurate, and it needs an account and a key. A new Deepgram account comes
  with free credit and does not ask for a card. After that credit is used it
  costs about $0.0043 a minute, so roughly 26 cents for an hour of talking.
  Your audio is sent to Deepgram to be transcribed.
- **Local** runs a speech model on your own PC. It costs nothing, needs no
  internet once the model is downloaded, and no audio leaves the machine. It
  uses your processor, so captions arrive a little later, and on a slower PC
  noticeably later. If you are unsure, start here — nothing is lost by trying
  it, and you can move to Cloud later without redoing anything else.

**Cloud.** Paste your Deepgram key into the box. The app checks it as you type:
the label beside `DEEPGRAM API KEY` moves from `WAITING` to `CHECKING…` to
`VALID`, often with the free credit you have left. `KEY REJECTED` means the key
is wrong, `COULD NOT REACH DEEPGRAM` means the app could not get online, and
`CONTINUE →` stays greyed out until the key is accepted.

**Local.** The right-hand side becomes a list of models grouped into `LIGHT`,
`MEDIUM` and `HEAVY`. The app reads your processor and memory and marks the
tier it suggests. Take that suggestion. On a modest PC it will be `LIGHT`, and
inside that tier **Moonshine Tiny**, 108 MB, is the one to pick — it waits for
you to finish a phrase, then writes the whole phrase out. **Zipformer 20M**,
44 MB, writes words as you say them, which feels quicker but misses names and
slang more often. On a six-core machine with 8 GB or more the app suggests
`MEDIUM`, where **Moonshine Base** is the safe choice.

Press the download button on the row you want — it carries the size, for
example `DOWNLOAD 108 MB`. A progress bar runs in the row and `CONTINUE →`
unlocks when the row reads `READY`. Models that work phrase by phrase also
fetch a 1 MB voice detector alongside.

### Step 2 of 3 — translation, optional

To have captions appear in a second language, paste a Google Gemini key here.
The app links to the page that issues one, and the free allowance covers a
normal evening. Otherwise press `SKIP · ENGLISH ONLY` — captions will be in the
language being spoken and nothing more, and the key can be added later.

### Step 3 of 3 — what to listen to

- `AUDIO SOURCE`. `Default microphone` is your own voice.
  `System audio (game + comms)` is everything your PC is playing — a game, a
  call, a video, other people in a voice chat.
- `SECOND SOURCE · OPTIONAL`. See **More than one voice** below.
- `SHOW CAPTIONS ON`. Choose `Phone`.

Press `OPEN CONSOLE`. Setup is finished.

---

## Part two — getting the link onto someone's phone

Read this before you send anything. Out of the box, the app serves the captions
from your own PC. That reaches a phone on the same wifi and nothing else — a
phone on mobile data, or in another house, cannot open it. This is how a fresh
install behaves, and it is not a fault. The app says so in two places:
`04 OUTPUT` reads `RELAY NOT SET · LAN ONLY`, and under `SETTINGS` the heading
`WHO CAN OPEN IT` reads `THIS NETWORK ONLY`.

To get a link that opens anywhere:

1. Press `SETTINGS` at the bottom right, or hold Ctrl and press comma.
2. Find `WHO CAN OPEN IT` in the left-hand column.
3. Press `GET AN ADDRESS THAT WORKS ANYWHERE →`.

It takes a moment. The note beside the button reads `ASKING FOR A ROOM...` and
then `READY`, the heading changes to `ANYONE WITH THE LINK`, and the button
disappears — there is nothing left to press, and asking for a second address
would break a link you may already have sent. Nothing to type, no account, no
card. What you have claimed is a private address on a server that passes
captions along; it transcribes nothing, translates nothing and keeps no copy.

Then:

4. Press `✕ BACK TO STAGE`.
5. Press `START SESSION`. The badge at the top right changes from `STANDBY` to
   `ON AIR`.
6. In the footer beside `LINK`, check that `PHONE` is selected rather than
   `OBS`.
7. Press `COPY` and send the link the way you would send anything else — a
   message, an email, a chat.

The link shown on screen has its middle replaced by dots. That is deliberate;
see **The link is the password**. `COPY` copies the real one. By default a new
link is made every time you press `START SESSION`, so yesterday's link will not
work today. To keep one link alive instead, go to `SETTINGS` → `VIEWER LINK`
and choose `Fixed`.

---

## What the person reading sees

They open the link. That is the whole of their side. They get a dark page with
the captions filling it, a badge at the top reading `ON AIR` while you are
talking and `OFF AIR` when you stop, and a clock.

At the top right of that page is a button marked `AA`. It opens a panel of
display settings that belong to their device alone: **Size** as a slider from
small to very large, **Font** (including Verdana, which many people find
easiest to read), **Alignment**, **Lines kept** for how much history stays on
screen, **Colors** for text, accent and background, **Timestamps**,
**Text shadow**, and four one-press themes — `Dark`, `Light`, `OBS black` and
`OBS clear`. With translation on there are also **Show original** and
**Show translation**, so they can hide either.

`RESET` puts it all back. The footer reads `SAVED ON THIS DEVICE`, which is
literal: their choices change nothing on your screen or anyone else's.

If their page shows `THIS LINK HAS ENDED`, the session was stopped or a new link
was made. `TRY AGAIN` re-checks; if it says the same thing again, they need the
current link from you.

---

## Translation

Off until you turn it on, and it needs a Gemini key. Without one, `03 TRANSLATE`
in the strip along the bottom is greyed out and reads `Needs a Gemini key`.
Add the key under `SETTINGS` → `GEMINI API KEY` and press `SAVE`, then press the
`ON` / `OFF` toggle in `03 TRANSLATE` and pick the two languages either side of
the arrow.

With it on, your screen splits into two columns — the language being spoken on
the left, headed `SOURCE`, and the translation on the right. The reader's page
shows the original in dim text with the translation large underneath. The
original appears first and the translation lands a moment later on the same
line. Turning translation on or off, or changing either language, restarts the
session on its own; the viewer link is not affected.

---

## More than one voice

A single source carries no name tag, because there is nothing to tell it apart
from. Two or three do. In `01 SOURCE` there is a `+` row under the first picker;
fill it and a third appears. Two common arrangements:

- **You and the room.** `Default microphone` first,
  `System audio (game + comms)` second. Your own voice is tagged `YOU` and
  everything else `CHAT`.
- **Two people in one room.** Two microphones. The first is called `YOU` and
  the second `CHAT`, which is probably not what you want, so rename them.

To rename: `SETTINGS` → `SPEAKER NAMES`. One row per source, showing which
device it holds, a name box of up to twelve characters, and a colour square.
That colour is what the tag is painted in on the reader's page, so with three
voices it is what tells them apart at a glance. A blank box keeps the default;
the third source has none worth guessing and is called `CH3` until you name it.
Names and colours cannot be changed while a session is running — the panel says
so and greys the boxes out, so stop, change, and start again.

Each source is transcribed separately, so on Cloud two sources cost twice as
much per minute as one.

---

## When something goes wrong

**They cannot open the link.** Look at `04 OUTPUT`. If it reads `LAN ONLY`, the
link only works on your own wifi and that is the entire problem — go back to
part two and claim an address. If it reads `RELAY OK` or `UPLINK OK`, make sure
they have the current link: press `COPY` again and resend. If they are on your
wifi and it still fails, Windows Firewall is most likely blocking the app.

**Only one person can watch at a time.** On your own network the app allows one
viewer, and a second device opening the same link disconnects the first, which
then shows `THIS LINK HAS ENDED`. Claiming an address, as in part two, removes
the limit: after that any number of people can read along at once.

**The OBS overlay goes blank after a restart.** `SETTINGS` → `VIEWER LINK`
starts on `New each session`, which kills the old link every time you press
`START SESSION` — including the one your browser source is holding. Choose
`Fixed` and the overlay survives restarts. It shows nothing rather than putting
an error message on your broadcast, which is why it goes blank silently.

**There is no system audio.** `System audio (game + comms)` captures whatever
your PC sends to its *default* output device. If the voices you want are going
somewhere else — a second headset, a virtual cable — nothing is picked up.
Change the default output in Windows sound settings, or route the call to it,
then press `RESCAN` in `01 SOURCE` so the app sees the change.

**A device is unplugged mid-session.** `LOG` names it and its tag in
`01 SOURCE` is struck through. The other sources carry on; stop and start to
pick a replacement.

**A local model will not start.** `02 TRANSCRIBE` reads `NOT DOWNLOADED` until
every file is on disk, or `DOWNLOAD FAILED` if a download broke. Retry it under
`SETTINGS` → `LOCAL SPEECH MODELS`.

---

## The link is the password

The link is the only thing protecting the transcript. There is no password, no
expiry, and no check on who opens it. Anyone holding it can read everything
said while a session is running — and can keep reading on later days too, if
you have set the link to `Fixed`. So:

- Send it the way you would send a password: to one person, privately.
- Keep it off screen in a stream, a screenshot or a shared call. The app masks
  it in the footer for that reason — you click it to read it, and it hides
  itself again after twenty seconds.
- If it gets out, or you want to end someone's access, press `NEW` in the
  footer. That makes a fresh link and disconnects everyone on the old one
  immediately. Send the new link to whoever should still have it.

Where things go. Your keys are stored on this PC and are sent only to Deepgram
and to Google, and only if you are using those services. On **Local** speech no
audio leaves your PC at all; on **Cloud** speech audio goes to Deepgram to be
transcribed, and with translation on the finished text goes to Google. The
address you claim in part two receives finished captions only: it does no
transcription, holds no keys, and keeps no copy once it has passed a line on.
`HIDE SWEARING`, under `SETTINGS` → `WHAT VIEWERS SEE`, masks common swear words
in what viewers are sent — English only, and a courtesy rather than a guarantee.

---

## Day to day

- `START SESSION` and `STOP` are the same button.
- Closing the window does not quit the app. It keeps running in the system
  tray, and capture carries on. The tray menu offers **Start session**,
  **Stop session**, **Rotate viewer link**, **Run setup again** and **Quit**.
- `LOG` in the footer is a running record of the session, with the delay on
  each line. `Esc` returns to the captions.
- Changing a setting mid-session — a language, a model, a microphone — restarts
  the session by itself. The viewer link is not affected.
- The app updates itself. `SETTINGS` → `UPDATES` shows the version you are on,
  a `CHECK` button and a `CHECK AUTOMATICALLY` switch. When an update is ready
  an amber chip appears in the footer; pressing it restarts into the new
  version. A running session is never interrupted.
