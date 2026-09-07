# Streamer branding on the viewer page - design

Date: 2026-09-07. Scope settled with the user; the two findings that shaped it
came from reading the code first and are recorded under Assumptions.

## Goals

1. **A link looks like the person who sent it.** Someone opening
   `textrelay.cc/watch/<token>` sees whose captions these are before reading a
   word - a name and an accent colour the streamer chose.
2. **It costs the reader nothing.** Size, font, theme, lines kept and timestamps
   stay the reader's, on their device, exactly as the app already promises. A
   brand cannot make captions less legible.
3. **It survives a late join.** Somebody opening the link twenty minutes in sees
   the same branding as somebody who was there at the start.

Non-goals, each decided rather than deferred:

- **No avatar or logo.** See Assumptions - it is a subsystem, not a field.
- **No branding on the OBS overlay.** The overlay is composited into a scene the
  streamer already controls and already brands; a second name burned into the
  captions is duplication, and the overlay was just tuned for minimalism.
- **No per-viewer or per-caption identity.** Speaker tags already do that.
- **No mid-session change.** The brand rides the `hello` frame, which is sent
  once per session; changing it applies to the next one, exactly as speaker
  names do today.

## Assumptions

**A. An image is a new subsystem, so v1 carries none.** Three independent facts:
`readViewerAsset()` (`relay/src/server.ts`) resolves only from three
baked-in locations and rejects anything outside `/^[A-Za-z0-9._\-/]+$/`; the
Worker serves only `env.ASSETS`, a build-time bundle; there is no upload
endpoint, no writable asset route, no R2 or KV binding anywhere. A remote URL
instead would hand a third-party host every viewer's IP and User-Agent, which
contradicts `home.html`'s "No account, no telemetry" and `DESIGN.md:31`'s
commitment that nothing loads from a CDN at runtime. An image logo is an upload
path, a store, a serving route and a CSP - on a server whose last two crash bugs
were unauthenticated HTTP routes.

**B. A new display field does not automatically travel.** Fixed in `629adfb`
before this work: `color` was dropped at two of the three forwarding hops, so
per-speaker colour worked on the LAN and did nothing over the internet, silently,
because the literals are typed `& SpeakerTag` and an absent optional field
compiles. Branding inherits the same shape and needs the same discipline.

**C. `--accent` is already the reader's.** `themeMatches()` in `viewer/public/app.js` compares it to light the theme chip, and RESET reverts it. A brand painted
into `--accent` is erased by the next theme tap. The brand needs its own
property.

**D. The publisher hello is frozen for the session.** `relayClient.connect()`
sends it once, on `onopen`. This is why speaker-name
inputs disable while live and `#captionsLock` explains it on screen.

**E. The viewer page has no CSP and neither relay sets one.** Out of scope here,
but it means the brand name must be treated as untrusted at the DOM boundary
rather than relying on a policy that does not exist.

## Architecture

The brand is two strings on the `hello` frame. `hello` is the only message a
late joiner is guaranteed to receive, and the only one the hosted relay
persists, so it is the only correct carrier.

### Shared types (`packages/shared/src/index.ts`)

```ts
/** what a viewer is told this stream is called. Publisher-chosen, untrusted. */
export interface Brand {
  /** display name, capped; absent means an unbranded stream */
  brandName?: string;
  /** #rrggbb, or absent */
  brandColor?: string;
}

export const MAX_BRAND_NAME = 24;
```

`AppConfig` gains `brandName?: string` and `brandColor?: string`, following the
`sourceLabels` / `sourceColors` precedent (`sourceLabels` at `:37`). `Brand` is intersected
into three hello variants: `PublisherToServer.hello`, `UplinkToServer.hello`,
`ServerToViewer.hello`.

`safeBrandName(value)` joins `safeSpeakerColor`: trims, rejects non-strings,
caps at `MAX_BRAND_NAME`, and returns undefined for an empty result.

### Relay (`packages/relay`)

- `publisherHello()` (`server.ts:145`) sanitises both fields, beside the
  existing `channelLabels` cap and `channelColors` check.
- Module state beside `currentLanguages` / `currentTranslates` (`server.ts:224`)
  holds the current brand.
- **All three hand-built viewer hellos** carry it: `server.ts:664-669` (publisher
  hello re-broadcast), `:689-702` (viewer connect), `:711-721` (`sync`).
- The fourth, the uplink-to-viewer rebuild, carries it too.

### Companion (`packages/companion`)

`RelayPublisherClient.open()` and `UplinkClient.open()` / `sendHello()` add the
two fields. Both rebuild their hello field-by-field out of `this.hello` rather
than spreading it, so a field added to the type alone reaches nothing - checked
by reading, and it is the same shape as finding B. Neither carries a comment
saying so; both should, once this lands.

### Hosted relay (`apps/hosted-relay`)

- `interface RoomState` gains `brandName?` and `brandColor?`.
- The uplink hello handler stores them through the local
  `safeSpeaker`-style sanitisers already added in `2bfcbc7`; a local
  `safeBrandName` joins them. The Worker takes no dependencies, deliberately.
- The viewer-connect hello replays them.

**What this changes about storage.** The room record already persists
`languages`, `translates`, `live` and `since`. It will now also hold a name the
streamer chose to publish. That is the streamer's own public label, not viewer
data, and nothing about a viewer is stored - so `home.html`'s privacy paragraph
stays true as written. Worth stating because it is the kind of claim that rots.

### Viewer (`packages/viewer/public`)

- A brand strip in the existing HUD bar (`<header class="hud">` in `index.html`), with ids
  `brandBar` and `brandName`. Every id referenced from `app.js` must exist in
  the markup or `scripts/check-renderer-ids.mjs` fails the gate.
- The hello handler (`app.js:576-586`) sets `brandName.textContent` - never
  `innerHTML` - and sets the colour with
  `root.style.setProperty("--brand", colour)`. `viewer.test.ts:182-201` already
  pins that colours go through `setProperty` "so a value smuggling more CSS
  cannot bring it along", and `:215-224` pins that caption text is not rendered
  as markup. The brand joins both.
- `--brand` is a **new** custom property. It is not `--accent` (Assumption C)
  and it is not used for caption text.
- `body.obs .brand-bar { display: none }`. The overlay shows captions and
  nothing else, and the idle fade only fades `.row.obs-live` - a brand element
  outside that row would sit at full opacity on the broadcast through every
  quiet stretch, which is the bug the fade exists to prevent.
- Absent brand renders nothing: no empty bar, no reserved space.

### Desktop app (`apps/standalone`)

Two fields in the settings panel, inside the `data-group="viewers"` group -
`renderer.test.ts` fails if a subject is split across groups, and this belongs
with what viewers see. They sit beside SPEAKER NAMES, which is the closest
existing feature and already has the name-plus-colour shape.

Both disable while live with the same `#captionsLock` treatment speaker names
use, because of Assumption D. `ConfigStore.merge` skips `undefined` and `null`
(`companion/src/config.ts:132`), so clearing a brand sends `""` explicitly, the
way `saveSettings` already does at `app.ts:1534-1536`.

## Testing

Every guard below is to be watched failing before the code that satisfies it,
per the repo's convention.

1. **It reaches a late joiner.** `uplink.test.ts`, real relay and real sockets:
   an uplink announces a brand, a viewer connects *afterwards*, the hello it
   receives carries the name and colour. This is the case the whole design is
   shaped around.
2. **It survives every hop.** Extend `speakerTag.test.ts` - which already fails
   any subtitle hop that omits a tag field - to cover the hello hops the same
   way. Finding B is the reason this exists.
3. **The name is untrusted.** `viewer.test.ts`: a brand of
   `<img src=x onerror=alert(1)>` appears as text and creates no element; a
   colour of `#fff; background: url(...)` sets no property.
4. **Both relays sanitise.** `sanitise.test.ts` gains `safeBrandName`: capped at
   24, non-strings dropped, empty becomes absent.
5. **The overlay is unbranded.** `viewer.test.ts` under `?obs=1`: the brand bar
   is not displayed, whatever the hello said.
6. **The reader keeps their settings.** `viewer.test.ts`: with a brand applied,
   `--accent` is still whatever the reader's theme set, and changing theme does
   not disturb `--brand`.
7. **Settings placement.** `renderer.test.ts`: the brand fields resolve to
   `data-group="viewers"`, and `check-renderer-ids.mjs` covers the new ids.

## Release

Ships in 0.6 with a changelog entry written for the streamer, per
`changelog.ts`'s own rule about not inventing significance: what changes for
them is that a link they hand out says who it is from. The viewer half reaches
hosted viewers on the next Worker deploy; the desktop half reaches people on the
next release, and both are needed for the feature to do anything - so the
changelog entry belongs to the app release, not the deploy.
