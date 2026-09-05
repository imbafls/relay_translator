# Relay - UI redesign spec ("caption console")

Source of truth for visuals: `Relay Redesign.dc.html`, turns **3** (console, viewer, OBS, Stream Deck) and **4** (onboarding). Turn 2 is superseded; turn 1 is the old UI recreated for comparison. Screen ids (3a, 4c…) below match the badges in that file.

Applies to: `apps/standalone/renderer` (desktop), `packages/viewer/public` (phone/OBS), `apps/streamdeck/com.callout-relay.sdPlugin/pi` (property inspector).

## Concept
Relay is a broadcast caption encoder, not a settings form. The live text is the hero; every control lives in one **signal-chain strip** (01 SOURCE → 02 TRANSCRIBE → 03 TRANSLATE → 04 OUTPUT). No cards, no rounded panels - one ruled grid on warm black. Amber appears only when something is live or needs attention.

## Tokens
```css
--bg:      #131313;               /* warm black, every surface */
--ink:     #efeae0;               /* primary text, primary buttons */
--ink-2:   #b8b3a8;               /* original-language line when translation is emphasized */
--dim:     #8a877f;               /* secondary text, labels (5.6:1 on bg) */
--mute:    #3a3834;               /* disabled/ghost text, inactive meter bars - never for readable copy */
--rule:    rgba(239,234,224,.14); /* structural rules */
--rule-2:  rgba(239,234,224,.08); /* inner rules */
--amber:   #e0a43a;               /* ON AIR, live cursor, warnings (NOT SET / LAN ONLY / KEY NEEDED) */
--radius:  0;                     /* square everything; window corners 4px max */
```
Disabled chain blocks get a hatch overlay: `repeating-linear-gradient(135deg, transparent 0 6px, rgba(239,234,224,.025) 6px 7px)`.

## Type
- **Archivo** (variable `wdth,wght@62..125,400..800`). UI text 13px/1.4. Headlines 30px/1.15 wt 500.
- **Labels**: Archivo `font-stretch:75%`, 10.5px, wt 600, uppercase, `letter-spacing:.16em`, color `--dim`. Chain numbers (01–04) in `--ink`.
- **Wordmark**: "RELAY" Archivo 75% width, 15px, wt 800, `.14em`.
- **Martian Mono** 400–600 for all readouts: clocks, timestamps, latency, costs, links, keys, meta lines (10.5–12px, uppercase for meta).
- Caption text: desktop stage 18px (22px when single column), phone 18px history / 21px latest (20/24 when single column), OBS 34px original / 46px translation.

Both families are self-hosted from `packages/viewer/public/fonts` (the desktop build copies them into `dist/renderer/fonts`, and the relay embeds them as SEA assets), so nothing loads from a CDN at runtime.

## Layout - desktop window (980×800, min 720)
Top → bottom, all full-width, separated by `--rule`:
1. **Top bar 40px**: wordmark left · session clock `HH:MM:SS` centered (dim when idle, ink when live) · status right (`○ STANDBY` dim / `● ON AIR` amber, dot pulses 1.6s).
2. **Stage** (flex 1): two columns `ENGLISH · SOURCE | TIẾNG VIỆT · TRANSLATION` with 10px header row. Lines bottom-aligned, 18px gap, newest last. Left col has a 62px mono timestamp gutter (`MM:SS`); right col a 40px latency column. Older lines fade to `--dim`; newest interim line shows amber timestamp + blinking 2px amber cursor. Idle: centered ghost waveform (mute bars), "Nothing on air", and the mono chain summary `Source → STT → MT → output`.
3. **Chain strip**: 4 equal columns, 14/20/16px padding. Each: label row (number + name, optional right-aligned toggle), 16px wt-500 value (select with chevron), 10.5px mono meta line. While live: source shows a 12-seg level meter; others show live counts (`4.2 MIN · $0.018`, `38 LINES · 11 CACHED · $0.002`, `UPLINK OK · 38 MS`); the strip is read-only (dim) except OUTPUT.
4. **Footer 64px**: `● START SESSION` 220px ink-filled block (becomes outlined `■ STOP` when live) · LINK row (mono URL + `COPY OPEN NEW`) · readouts (`STT · TRN · EST`) · `KEYS` opens the keys view.

**Keys view (3c)** replaces the stage (chain strip and footer stay): two columns, underline-style mono inputs, `VALID` / `NOT SET` status per field, `SAVE` ink block bottom-right. Header row has `✕ BACK TO STAGE`.

**Translation off (3i, 4e)**: stage collapses to one `ENGLISH · CAPTIONS` column at 22px; 03 block hatched, toggle OFF, language pair struck through, meta `BYPASSED · $0.000`. If off because no Gemini key: value "Needs a Gemini key", meta `ADD KEY` underlined (opens keys view).

## Onboarding (first run, turn 4) - shown until setup completes; re-runnable
Same window frame; top-bar center shows stepper `1 SPEECH · 2 TRANSLATION · 3 READY` (current ink, done dim with ✓, upcoming mute). Left pane 48px padding: step label, 30px headline, dim body, underline input, `→` help rows with an underlined "Get a free key at …" link (opens browser). Right pane previews the stage the user will get. Chain strip persists with `—` placeholders and `STEP n` meta; the current block gets a 2px ink top rule.
- **4a/4b** Speech engine. A `Cloud · Deepgram | Local · this PC` segment at the top of the step. Cloud: Deepgram key (required). Validate on paste (test request); show `VALID · $X CREDIT` or an amber error. Local: a mono hardware line (`YOUR PC · 16 THREADS · 32 GB RAM · <CPU> → HEAVY RECOMMENDED`), a `Light | Medium | Heavy` segment with a one-line blurb, then the tier's models as ruled rows (2px ink left rule on the selected one): 15px name, mono tag `PHRASE · EN · 102 MB`, `SPEED ●●●●○ ACCURACY ●●●○○` dots, dim note, and a state line (`DOWNLOAD · 102 MB` link, 90px progress bar + `%` + `CANCEL`, `READY ✓`). CONTINUE is mute/disabled until the key is valid or the chosen model is ready.
- **4c** Gemini key (optional). Right pane: English column + hatched "TIẾNG VIỆT · WITH KEY" preview. Buttons `CONTINUE →` | `SKIP · ENGLISH ONLY` share one outlined block; Skip is always enabled.
- **4d** Source picker, optional `ALSO LISTEN TO` second source, output picker, `OPEN CONSOLE`. If step 2 skipped, 03 shows `No key · ADD GEMINI KEY`.
Relay URL/token are **not** in onboarding - they live in the keys view; the console shows `RELAY NOT SET · LAN ONLY` in amber until set.
**Re-run**: `KEYS → RUN SETUP AGAIN →` and the tray entry reopen onboarding pre-filled; the step label row then carries `✕ BACK TO CONSOLE` on the right (also `Esc`). Only OPEN CONSOLE marks setup complete.

## Chain strip additions (0.4)
- **01 SOURCE** stacks one 13px `--ink-2` select row per extra source under the primary, each with a mono `✕`; the meta row gains `+ ADD` (hidden while live or when every device is used). Meta reads `MIC + SYSTEM · 2 SOURCES`.
- **02 TRANSCRIBE** carries a `CLOUD | LOCAL` mini-segment right-aligned in its label row. Local meta: `EN · STREAMING · READY`, `EN · PHRASE · 121 MB · DOWNLOAD` (underlined ink link), `DOWNLOADING 43% · CANCEL`, `UNPACKING…`, or amber `ENGINE UNAVAILABLE`. Live meta: `4.2 MIN · LOCAL · $0.000`. The model select groups local models by tier.
- **Keys view** gains a `LOCAL MODELS` field (folder input, `OPEN FOLDER`, mono summary of models on disk) and `RUN SETUP AGAIN →` in the footer links.

## Phone viewer (390 wide, safe-area top 56px)
- **Live (3d)**: header row = `● ON AIR` amber, `EN → VI`, mono clock, `AA` (opens display). Lines bottom-aligned, each row = 44px mono timestamp gutter + text, separated by `--rule-2`. Original above translation, same size; in history both dim, in the latest line original `--ink-2` and translation ink wt 600 at 21px with a 1px ink rule beneath. Interim line: amber timestamp + blinking cursor. Translation off (3j): single 20/24px line per row.
- **Display (3e)**: full page, `← BACK / DISPLAY` header, live preview row on top, 4-way theme bar (Dark/Light/OBS black/OBS clear), then 54px list rows: Size (line slider, square 22px thumb), Show original, Show translation, Timestamps, Text shadow (square toggles), Font ›, Alignment ›, Lines kept ›, Colors (3 square swatches). Footer `RESET · SAVED ON THIS DEVICE`. Persist in localStorage; "Timestamps" defaults on.
- **Ended (3f)**: `○ OFF AIR · ENDED HH:MM`; headline 28px; two-cell footer `TRY AGAIN` (ink) | `N LINES SAVED`.

## OBS overlay (`?obs=1`, 3g)
Transparent, bottom-left, 120px inset, 8px amber bar left of text, text-shadow `0 2px 6px rgba(0,0,0,.7)` (intrinsic to the overlay, not a user setting). Original 34px `--ink-2`, translation 46px wt 600; both scale with the viewer's size setting. Honors the other viewer display settings.

## Stream Deck property inspector (320 wide, 3h)
Header `● ON AIR · KEY = STOP`; LINK row (mono, underline, `COPY NEW`); 2×2 grid of chain blocks (01 SOURCE, 02 TRANSCRIBE, 03 TRANSLATE w/ ON, 04 MODEL) each a small select; mono footnote about System audio.

## Components (build once, reuse)
- `ChainBlock` {index, label, value, meta, state: default|active|live|disabled(hatched), trailing toggle?}
- `Label` (condensed uppercase), `Readout` (mono), `UnderlineInput`, `SquareToggle`, `SegmentedBar` (bordered cells, active = ink fill), `InkButton` / `OutlineButton`, `CaptionRow` {time, original, translation, latency, state: history|latest|interim}, `StatusDot` {standby|onair}.

## Rules
- Only `--amber` is chromatic; never add green/red. Stop is ink-outlined, not red.
- No border-radius, shadows, gradients (except the hatch), or emoji/icons beyond chevrons, ●/○/■ and the `→`.
- Mute (`#3a3834`) is for disabled/ghost only - never for text the user must read.
- Interactive hit targets ≥ 44px on phone.
- Copy figures (credit, prices, free-tier claims) in the mocks are placeholders - verify before shipping.
