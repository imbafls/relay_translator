# Streamer Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A streamer sets a name and an accent colour; anyone opening their phone/browser viewer link sees whose captions these are, without losing control of how the captions themselves are rendered.

**Architecture:** Two optional strings (`brandName`, `brandColor`) ride the `hello` frame — the only message a late-joining viewer is guaranteed to receive and the only one the hosted relay persists. Every place that builds a hello by hand must carry them - eight literals across
four files; `UplinkClient.sendHello` is the one that spreads and so cannot lose a
field. The viewer paints them into a header strip using a new `--brand` custom property, never `--accent`, and never into caption text.

**Tech Stack:** TypeScript throughout, Node ≥ 20, pnpm workspace. vitest for tests; happy-dom for renderer/viewer tests; real `startRelay` over real WebSockets for relay tests. Cloudflare Workers (Durable Objects) for the hosted relay.

**Spec:** `docs/superpowers/specs/2026-09-07-streamer-branding-design.md` — read it first; this plan argues from it.

## Global Constraints

- **No avatar, no image, no remote fetch.** v1 carries two strings only. Spec Assumption A.
- **No branding on the OBS overlay.** `?obs=1` shows captions and nothing else.
- **The reader keeps size, font, theme, lines and timestamps.** The brand never touches caption text rendering.
- **`MAX_BRAND_NAME = 24`.** Speaker tags stay at `MAX_SPEAKER_TAG = 12`; these are different limits and neither is reused for the other.
- **Brand colour is `#rrggbb` only** — validated, never escaped, never guessed at.
- **`apps/hosted-relay` takes no dependencies.** It may not import `@callout-relay/shared`; it keeps local copies with a comment saying why.
- **Every id referenced from `app.js`/`app.ts` must exist literally in its markup** or `node scripts/check-renderer-ids.mjs` fails the gate.
- **Watch every new test fail before writing the code that satisfies it.** A test that passes first time has probably not run.
- **Commit messages:** short imperative subject naming the effect, body explaining what the failure was and why the change is right, then `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. No conventional-commit prefixes.
- **Full gate before any release:** `pnpm -r build`, `pnpm -r typecheck`, `pnpm typecheck:test`, `pnpm test`, `node scripts/check-renderer-ids.mjs`, `pnpm smoke`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/index.ts` | `Brand`, `MAX_BRAND_NAME`, `safeBrandName()`, `AppConfig` fields, the three hello variants |
| `packages/shared/test/brand.test.ts` | **new** — `safeBrandName` unit tests |
| `packages/relay/src/server.ts` | sanitise on publisher hello; hold current brand; emit on all four hellos |
| `packages/relay/src/session.ts` | `SessionConfig` carries the brand through a session rebuild |
| `packages/relay/test/server.test.ts` | a publisher's brand reaches a viewer that connects later |
| `packages/companion/src/relayClient.ts` | publisher hello carries the brand |
| `packages/companion/src/uplinkClient.ts` | uplink hello carries the brand |
| `apps/standalone/src/main.ts` | pass config brand into `uplink.connect()` and the live `sendHello()` |
| `apps/hosted-relay/src/room.ts` | local `safeBrandName`; `RoomState` fields; store on uplink hello; replay on viewer hello |
| `apps/hosted-relay/test/sanitise.test.ts` | `safeBrandName` cases |
| `packages/shared/test/speakerTag.test.ts` | extended: hello hops must carry the brand |
| `packages/viewer/public/index.html` | `#brandBar`, `#brandName` in the HUD |
| `packages/viewer/public/app.js` | render the brand from hello |
| `packages/viewer/public/style.css` | `--brand`, brand bar, OBS suppression |
| `packages/viewer/test/viewer.test.ts` | render, markup safety, OBS suppression, reader's `--accent` untouched |
| `apps/standalone/renderer/index.html` | two fields in `data-group="viewers"` |
| `apps/standalone/renderer/app.ts` | read/write/live-lock the two fields |
| `apps/standalone/test/renderer.test.ts` | group placement and the live lock |
| `packages/shared/src/changelog.ts` | the 0.6.0 entry |

---

### Task 1: The shared contract

**Files:**
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/brand.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `interface Brand { brandName?: string; brandColor?: string }`, `const MAX_BRAND_NAME = 24`, `function safeBrandName(value: unknown): string | undefined`. `AppConfig.brandName?: string`, `AppConfig.brandColor?: string`. `Brand` intersected into the `hello` variants of `PublisherToServer`, `UplinkToServer`, `ServerToViewer`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/brand.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MAX_BRAND_NAME, safeBrandName } from "../src/index";

/**
 * A brand name is drawn on a public page, chosen by whoever holds the publish
 * token. It is capped rather than trusted, and a value that is not a string is
 * dropped rather than coerced - `String(x)` on an object would put "[object
 * Object]" on somebody's screen.
 */
describe("a brand name", () => {
  it("keeps an ordinary name as it was", () => {
    expect(safeBrandName("Omer's stream")).toBe("Omer's stream");
  });

  it("caps a long one at the documented limit", () => {
    expect(MAX_BRAND_NAME).toBe(24);
    expect(safeBrandName("x".repeat(500))).toHaveLength(24);
  });

  it("trims, because a padded name looks like a layout bug", () => {
    expect(safeBrandName("  Relay  ")).toBe("Relay");
  });

  it("treats blank as unbranded rather than as an empty label", () => {
    expect(safeBrandName("")).toBeUndefined();
    expect(safeBrandName("   ")).toBeUndefined();
  });

  it("drops anything that is not a string", () => {
    expect(safeBrandName(undefined)).toBeUndefined();
    expect(safeBrandName(null)).toBeUndefined();
    expect(safeBrandName(42)).toBeUndefined();
    expect(safeBrandName({ toString: () => "sneaky" })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/shared/test/brand.test.ts`
Expected: FAIL — `safeBrandName` is not exported from `../src/index`.

- [ ] **Step 3: Add the contract**

In `packages/shared/src/index.ts`, beside `MAX_SPEAKER_TAG` and `safeSpeakerColor`:

```ts
/** the longest brand name a viewer page will render */
export const MAX_BRAND_NAME = 24;

/**
 * What a stream calls itself, as shown to viewers.
 *
 * Separate from `MAX_SPEAKER_TAG`: a speaker tag is drawn on every caption and
 * has to stay short, while this appears once in the header and can afford a
 * real name. Reusing one number for both would tie two unrelated layouts
 * together.
 */
export function safeBrandName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().slice(0, MAX_BRAND_NAME);
  return v.length > 0 ? v : undefined;
}

/**
 * Publisher-chosen identity for a stream, shown in the viewer's header and
 * nowhere else. Untrusted: it arrives over a socket from whoever holds the
 * publish token.
 */
export interface Brand {
  brandName?: string;
  brandColor?: string;
}
```

Add to `AppConfig`, next to `sourceLabels`:

```ts
  /** what viewers are told this stream is called; blank means unbranded */
  brandName?: string;
  /** `#rrggbb` accent for the viewer's header only, never for caption text */
  brandColor?: string;
```

Intersect `Brand` into the three hello variants:

```ts
export type ServerToViewer =
  | ({ type: "hello"; languages: Languages; live: boolean; translates: boolean } & SessionElapsed & Brand)
  // ...unchanged
```

```ts
export type UplinkToServer =
  | ({ type: "hello"; languages: Languages; translates: boolean; since?: number } & Brand)
  // ...unchanged
```

For `PublisherToServer`, add the two fields to the existing inline `hello` object type:

```ts
      /** `#rrggbb` per channel, parallel to channelLabels */
      channelColors?: string[];
      /** what viewers are told this stream is called */
      brandName?: string;
      /** `#rrggbb` accent for the viewer header */
      brandColor?: string;
```

- [ ] **Step 4: Run the test and the typecheck**

Run: `npx vitest run packages/shared/test/brand.test.ts && pnpm --filter @callout-relay/shared build && pnpm -r typecheck`
Expected: 5 tests PASS, build and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/index.ts packages/shared/test/brand.test.ts
git commit -m "Give a stream a name and a colour of its own"
```

---

### Task 2: The embedded relay carries it

**Files:**
- Modify: `packages/relay/src/server.ts`, `packages/relay/src/session.ts`
- Test: `packages/relay/test/server.test.ts`

**Interfaces:**
- Consumes: `Brand`, `safeBrandName`, `safeSpeakerColor` from Task 1.
- Produces: `SessionConfig.brandName?: string`, `SessionConfig.brandColor?: string`. Every `ServerToViewer` hello the embedded relay emits carries the current brand.

- [ ] **Step 1: Write the failing test**

Append to `packages/relay/test/server.test.ts`:

```ts
describe("a stream that says what it is called", () => {
  /**
   * The brand rides the hello because that is the only frame a viewer joining
   * late is guaranteed to get. A viewer that connects AFTER the publisher is
   * the case that matters - it is the one a link handed out mid-stream hits.
   */
  const viewerUrl = (): string =>
    `ws://127.0.0.1:${handle.port}/ws/viewer?token=${handle.state.viewerToken}`;

  const announce = async (brand: Record<string, unknown>): Promise<WebSocket> => {
    const pub = await open(publisherUrl());
    pub.send(
      JSON.stringify({
        type: "hello",
        stt: "deepgram-nova-3",
        translation: "gemini-3.1-flash-lite",
        languages: { source: "en", target: "vi" },
        channels: 1,
        ...brand,
      }),
    );
    return pub;
  };

  it("tells a viewer who connects afterwards", async () => {
    const pub = await announce({ brandName: "Omer's stream", brandColor: "#e0a43a" });
    const viewer = await open(viewerUrl());
    const hello = await waitFor(viewer, "hello");

    expect(hello?.brandName).toBe("Omer's stream");
    expect(hello?.brandColor).toBe("#e0a43a");
    pub.close();
    viewer.close();
  });

  it("drops a colour that is not plainly #rrggbb, and caps a long name", async () => {
    const pub = await announce({
      brandName: "x".repeat(200),
      brandColor: "#fff; background: url(http://evil/)",
    });
    const viewer = await open(viewerUrl());
    const hello = await waitFor(viewer, "hello");

    expect(hello?.brandName).toHaveLength(24);
    expect(hello?.brandColor).toBeUndefined();
    pub.close();
    viewer.close();
  });
});
```

`handle`, `publisherUrl()`, `open()` and `waitFor()` are the helpers that file already
defines in its `beforeAll`; `waitFor` resolves the first frame of a given type, or
null on timeout.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/relay/test/server.test.ts -t "says what it is called"`
Expected: FAIL — `hello.brandName` is `undefined`.

- [ ] **Step 3: Sanitise on the publisher hello**

In `packages/relay/src/server.ts`, import `safeBrandName` alongside `MAX_SPEAKER_TAG`, then add to the object `publisherHello()` returns, after `channelColors`:

```ts
    // the brand is drawn on a public page and chosen by whoever holds the
    // publish token: capped, and a colour that is not plainly #rrggbb is
    // dropped rather than escaped - same rule as channelColors above
    brandName: safeBrandName(raw.brandName),
    brandColor: safeSpeakerColor(raw.brandColor),
```

Add the two optional fields to `SessionConfig` in `packages/relay/src/session.ts`:

```ts
  /** what viewers are told this stream is called; already sanitised */
  brandName?: string;
  /** `#rrggbb`, already sanitised by the hello parser */
  brandColor?: string;
```

- [ ] **Step 4: Hold it and emit it**

In `server.ts`, beside `currentLanguages` / `currentTranslates` (~`:224`):

```ts
  let currentBrand: Brand = {};
```

Set it where `currentTranslates` is set from a publisher config (~`:322`):

```ts
    currentBrand = { brandName: cfg.brandName, brandColor: cfg.brandColor };
```

Add `...currentBrand` to **all four** hand-built hellos — the publisher-hello re-broadcast (~`:666`), the viewer connect (~`:692`), the `sync` reply (~`:712`), and the uplink-to-viewer rebuild (~`:775`). For the uplink one, take the brand off the incoming message instead, since that stream's identity belongs to the far publisher:

```ts
        currentBrand = { brandName: msg.brandName, brandColor: msg.brandColor };
        toViewers({
          type: "hello",
          languages: currentLanguages,
          live: true,
          translates: currentTranslates,
          since: msg.since,
          ...currentBrand,
        });
```

**Spread, do not enumerate.** Finding B in the spec is the whole reason: an enumerated literal silently loses a field, and this file has four of them.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/relay && pnpm -r typecheck`
Expected: both new tests PASS, nothing else broken.

- [ ] **Step 6: Commit**

```bash
git add packages/relay/src/server.ts packages/relay/src/session.ts packages/relay/test/server.test.ts
git commit -m "Tell viewers what the stream they opened is called"
```

---

### Task 3: The companion clients forward it

**Files:**
- Modify: `packages/companion/src/relayClient.ts`, `packages/companion/src/uplinkClient.ts`, `apps/standalone/src/main.ts`
- Test: `packages/companion/test/uplinkClient.test.ts`

**Interfaces:**
- Consumes: the hello types from Task 1.
- Produces: `UplinkClient.sendHello({ languages, translates, since, brandName, brandColor })` — the object gains two optional fields; existing callers keep working.

- [ ] **Step 1: Write the failing test**

Append to `packages/companion/test/uplinkClient.test.ts`:

First, make the harness keep what the client sends. The accept handler currently
discards every frame — change `ws.on("message", () => {})` (~`:39`) to record:

```ts
    accepted.push(ws);
    ws.on("message", (data) => {
      try {
        frames.push(JSON.parse(String(data)));
      } catch {
        /* not our frame */
      }
    });
```

and declare `let frames: Record<string, unknown>[] = [];` beside `accepted`,
clearing it in the same `beforeEach` that does `accepted = []`.

```ts
describe("the hello an uplink sends", () => {
  /**
   * Both of these clients rebuild their hello field by field out of
   * `this.hello` rather than spreading it, so a field added to the type alone
   * reaches nothing. That is exactly how `color` went missing on the subtitle
   * path - see speakerTag.test.ts.
   */
  const BRANDED = { ...HELLO, brandName: "Omer's stream", brandColor: "#e0a43a" };

  it("carries the brand on the hello it opens with", async () => {
    const c = makeClient();
    c.connect(BRANDED);
    await until(() => frames.some((f) => f.type === "hello"), "the opening hello");

    const hello = frames.find((f) => f.type === "hello")!;
    expect(hello.brandName).toBe("Omer's stream");
    expect(hello.brandColor).toBe("#e0a43a");
  });

  it("carries it again when the brand changes mid-connection", async () => {
    const c = makeClient();
    c.connect(HELLO);
    await until(() => live().length === 1, "the connection");
    c.sendHello(BRANDED);
    await until(
      () => frames.filter((f) => f.type === "hello").length === 2,
      "a second hello",
    );

    const hello = frames.filter((f) => f.type === "hello")[1];
    expect(hello.brandName).toBe("Omer's stream");
  });
});
```

`makeClient()`, `until()`, `live()` and the `HELLO` constant are that file's own
helpers.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/companion/test/uplinkClient.test.ts -t "carries the brand"`
Expected: FAIL — `hello.brandName` is `undefined`.

- [ ] **Step 3: Add the fields to both clients**

`relayClient.ts`, in the `ws.onopen` hello (~`:86`), after `channelColors`:

```ts
        brandName: this.hello.brandName,
        brandColor: this.hello.brandColor,
```

`uplinkClient.ts`, in the `ws.onopen` hello (~`:82`), after `since`:

```ts
        brandName: this.hello.brandName,
        brandColor: this.hello.brandColor,
```

and widen `sendHello`'s parameter:

```ts
  sendHello(hello: {
    languages: Languages;
    translates: boolean;
    since?: number;
    brandName?: string;
    brandColor?: string;
  }): void {
```

- [ ] **Step 4: Pass the config through in the desktop app**

`apps/standalone/src/main.ts`, in `startUplink()`'s `uplink.connect({...})` (~`:218`) and in the live `uplink.sendHello({...})` (~`:450`), add to both:

```ts
    brandName: cfg.brandName,
    brandColor: cfg.brandColor,
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/companion && pnpm -r typecheck`
Expected: the new test PASSES, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/companion/src/relayClient.ts packages/companion/src/uplinkClient.ts apps/standalone/src/main.ts packages/companion/test/uplinkClient.test.ts
git commit -m "Send the brand up the wire, not just into the type"
```

---

### Task 4: The hosted relay stores and replays it

**Files:**
- Modify: `apps/hosted-relay/src/room.ts`
- Test: `apps/hosted-relay/test/sanitise.test.ts`

**Interfaces:**
- Consumes: nothing from other packages — this Worker takes no dependencies.
- Produces: `export const MAX_BRAND_NAME = 24`, `export function safeBrandName(value: unknown): string | undefined` (local copies), `RoomState.brandName?`, `RoomState.brandColor?`.

- [ ] **Step 1: Write the failing test**

Append to `apps/hosted-relay/test/sanitise.test.ts`:

```ts
describe("a brand name", () => {
  it("is capped at the same 24 the app uses", () => {
    expect(MAX_BRAND_NAME).toBe(24);
    expect(safeBrandName("x".repeat(500))).toHaveLength(24);
  });

  it("keeps an ordinary name and trims a padded one", () => {
    expect(safeBrandName("Omer's stream")).toBe("Omer's stream");
    expect(safeBrandName("  Relay  ")).toBe("Relay");
  });

  it("treats blank and non-strings as unbranded", () => {
    expect(safeBrandName("")).toBeUndefined();
    expect(safeBrandName("   ")).toBeUndefined();
    expect(safeBrandName(undefined)).toBeUndefined();
    // a number would reach `.trim` and throw inside the fan-out, and on a
    // Durable Object that means the hello reaches nobody
    expect(safeBrandName(42)).toBeUndefined();
  });
});
```

Extend the import at the top of the file:

```ts
import { MAX_BRAND_NAME, MAX_SPEAKER_TAG, safeBrandName, safeColor, safeSpeaker } from "../src/room";
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/hosted-relay/test/sanitise.test.ts`
Expected: FAIL — `safeBrandName` is not exported from `../src/room`.

- [ ] **Step 3: Add the local sanitiser**

In `apps/hosted-relay/src/room.ts`, beside `safeSpeaker` and `safeColor`:

```ts
/** the longest brand name this relay will pass on; mirrors shared's MAX_BRAND_NAME */
export const MAX_BRAND_NAME = 24;

/**
 * What a stream calls itself. A local copy for the same reason as the two
 * above: this Worker carries no dependencies, and a number and a trim are
 * cheaper than the first import into a bundle that has none.
 */
export function safeBrandName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().slice(0, MAX_BRAND_NAME);
  return v.length > 0 ? v : undefined;
}
```

- [ ] **Step 4: Store it and replay it**

Add to `interface RoomState`:

```ts
  /** what the publisher calls this stream; replayed to every viewer that joins */
  brandName?: string;
  /** `#rrggbb`, sanitised on the way in */
  brandColor?: string;
```

In the uplink `hello` handler, before `await this.save(room)`:

```ts
      room.brandName = safeBrandName(msg.brandName);
      room.brandColor = safeColor(msg.brandColor);
```

Add to **both** viewer-facing hellos — the one in the uplink handler and the one sent on viewer connect (~`:241`):

```ts
        brandName: room.brandName,
        brandColor: room.brandColor,
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run apps/hosted-relay && pnpm --filter @callout-relay/hosted-relay typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/hosted-relay/src/room.ts apps/hosted-relay/test/sanitise.test.ts
git commit -m "Keep the stream's name in the room, so a late viewer still sees it"
```

---

### Task 5: Guard every hello hop

**Files:**
- Modify: `packages/shared/test/speakerTag.test.ts`

**Interfaces:**
- Consumes: the hops completed in Tasks 2–4.
- Produces: a guard that fails if any hop rebuilds a hello without carrying the brand.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/test/speakerTag.test.ts`:

```ts
/**
 * The same disease, one frame over. A hello is rebuilt by hand at five places
 * across three packages, and a brand added to the type alone reaches none of
 * them. `color` proved this is not hypothetical.
 *
 * A spread passes: `...currentBrand` carries whatever the brand holds now and
 * later, which is the shape this guard is trying to encourage.
 */
const HELLO_HOPS = [
  { file: "packages/relay/src/server.ts", hop: "the embedded relay greeting its own viewers" },
  { file: "packages/companion/src/relayClient.ts", hop: "the app greeting its own relay" },
  { file: "packages/companion/src/uplinkClient.ts", hop: "the app greeting the hosted relay" },
  { file: "apps/hosted-relay/src/room.ts", hop: "the hosted relay greeting an internet viewer" },
];

/** the object literal containing the nth `type: "hello"`, from its `{` to its `}` */
function helloLiteral(src: string, nth: number): string {
  let at = -1;
  for (let i = 0; i <= nth; i += 1) at = src.indexOf('type: "hello"', at + 1);
  if (at < 0) return "";
  let open = at;
  while (open >= 0 && src[open] !== "{") open -= 1;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return "";
}

describe("a hello keeps the brand at every hop", () => {
  for (const { file, hop } of HELLO_HOPS) {
    it(`carries the brand through ${hop}`, () => {
      const src = fs.readFileSync(path.join(root, file), "utf8");
      let checked = 0;
      for (let nth = 0; ; nth += 1) {
        const literal = helloLiteral(src, nth);
        if (!literal) break;
        // a type declaration is not a hop; only literals that build a frame
        if (!/send|broadcast|this\.send|toViewers/.test(src.slice(0, src.indexOf(literal)).slice(-400))) continue;
        checked += 1;
        if (/\.\.\./.test(literal)) continue;
        const missing = ["brandName", "brandColor"].filter(
          (f) => !new RegExp(`\\b${f}\\b`).test(literal),
        );
        expect(missing, `${file} builds a hello without: ${missing.join(", ")}`).toEqual([]);
      }
      expect(checked, `no hello literal found in ${file}`).toBeGreaterThan(0);
    });
  }
});
```

- [ ] **Step 2: Run it and watch it pass, then break it deliberately**

Run: `npx vitest run packages/shared/test/speakerTag.test.ts`
Expected: PASS (Tasks 2–4 already carry the fields).

Now prove it bites. Temporarily delete `brandName: this.hello.brandName,` from `uplinkClient.ts`, re-run, and confirm exactly that hop goes red. Restore it.

**This step is not optional.** A guard that has never failed has not been shown to guard anything.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/test/speakerTag.test.ts
git commit -m "Fail the build if a hello stops carrying the brand"
```

---

### Task 6: The viewer shows it

**Files:**
- Modify: `packages/viewer/public/index.html`, `packages/viewer/public/app.js`, `packages/viewer/public/style.css`
- Test: `packages/viewer/test/viewer.test.ts`

**Interfaces:**
- Consumes: `ServerToViewer` hello carrying `brandName` / `brandColor`.
- Produces: `#brandBar`, `#brandName` in the viewer markup; the `--brand` custom property.

- [ ] **Step 1: Write the failing tests**

Append to `packages/viewer/test/viewer.test.ts`:

```ts
describe("whose captions these are", () => {
  const brandBar = (): HTMLElement => $("brandBar");

  it("names the stream when the hello carries one", () => {
    boot();
    push({
      type: "hello",
      languages: { source: "en", target: "vi" },
      live: true,
      translates: true,
      brandName: "Omer's stream",
      brandColor: "#e0a43a",
    });

    expect($("brandName").textContent).toBe("Omer's stream");
    expect(brandBar().hidden).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("#e0a43a");
  });

  it("shows nothing at all when the stream is unbranded", () => {
    boot();
    push({ type: "hello", languages: { source: "en", target: "vi" }, live: true, translates: true });
    expect(brandBar().hidden, "an unbranded stream reserved space for a name it does not have").toBe(true);
  });

  it("renders the name as text, never as markup", () => {
    // the publisher is only as trustworthy as its token, and this page is
    // served publicly with no CSP
    boot();
    push({
      type: "hello",
      languages: { source: "en", target: "vi" },
      live: true,
      translates: true,
      brandName: "<img src=x onerror=alert(1)>",
    });

    expect(document.querySelector("#brandBar img")).toBeNull();
    expect($("brandName").textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("leaves the reader's own accent alone", () => {
    // --accent belongs to the theme the reader picked; themeMatches() compares
    // it, and RESET reverts it. A brand painted there would be wiped.
    boot();
    const before = document.documentElement.style.getPropertyValue("--accent");
    push({
      type: "hello",
      languages: { source: "en", target: "vi" },
      live: true,
      translates: true,
      brandColor: "#ff0000",
    });
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe(before);
  });

  it("stays off the broadcast overlay", () => {
    // the streamer already brands that scene, and an element outside
    // .row.obs-live never fades - it would sit there through every quiet stretch
    boot("?obs=1");
    push({
      type: "hello",
      languages: { source: "en", target: "vi" },
      live: true,
      translates: true,
      brandName: "Omer's stream",
    });
    expect(brandBar().hidden, "the brand reached the broadcast overlay").toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/viewer/test/viewer.test.ts -t "whose captions"`
Expected: FAIL — `no #brandBar in the shipped markup`.

- [ ] **Step 3: Add the markup**

In `packages/viewer/public/index.html`, inside `<header class="hud">`, before `#hudLangs`:

```html
      <span id="brandBar" class="hud-brand" hidden><span id="brandName" class="hud-brand-name"></span></span>
```

- [ ] **Step 4: Render it**

In `packages/viewer/public/app.js`, in the `case "hello":` branch, after `applyStyle()`:

```js
          applyBrand(msg.brandName, msg.brandColor);
```

and add the function beside `applyStyle`:

```js
  /**
   * Who the stream belongs to. Chrome only: the reader keeps size, font and
   * theme, and the caption text is not touched. The colour goes into --brand,
   * NOT --accent - the reader owns that one, themeMatches() compares it and
   * RESET reverts it, so a brand painted there would vanish on the next tap.
   */
  function applyBrand(name, colour) {
    const bar = $("brandBar");
    // The overlay carries captions and nothing else. Suppressed HERE and not
    // only in CSS: `body.obs .hud-brand { display: none }` is real and stays,
    // but a stylesheet rule is invisible to happy-dom, so a test asserting it
    // would pass on markup that shows the brand to a whole Twitch audience.
    if (obs) {
      bar.hidden = true;
      return;
    }
    const text = typeof name === "string" ? name.trim() : "";
    // textContent, never innerHTML: this arrives over a socket from whoever
    // holds the publish token, onto a page served publicly with no CSP
    $("brandName").textContent = text;
    bar.hidden = text.length === 0;
    const safe = typeof colour === "string" && /^#[0-9a-f]{6}$/i.test(colour.trim())
      ? colour.trim().toLowerCase()
      : "";
    // setProperty, never a style attribute - a value smuggling more CSS cannot
    // bring it along. viewer.test.ts already pins this for speaker colours.
    if (safe) document.documentElement.style.setProperty("--brand", safe);
  }
```

- [ ] **Step 5: Style it, and keep it off the overlay**

Append to `packages/viewer/public/style.css`:

```css
/* Who the stream belongs to. Chrome only - the caption text below is the
   reader's, and --brand is deliberately not --accent (see applyBrand). */
.hud-brand { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.hud-brand-name {
  color: var(--brand, var(--fg));
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 14ch;
}
/* The overlay is composited into a scene the streamer already brands, and an
   element outside .row.obs-live never fades - it would sit on the broadcast
   through every quiet stretch, which is what the idle fade exists to stop. */
body.obs .hud-brand { display: none; }
```

- [ ] **Step 6: Run the tests and the id guard**

Run: `npx vitest run packages/viewer && node scripts/check-renderer-ids.mjs`
Expected: all five new tests PASS; ids resolve.

- [ ] **Step 7: Commit**

```bash
git add packages/viewer/public/index.html packages/viewer/public/app.js packages/viewer/public/style.css packages/viewer/test/viewer.test.ts
git commit -m "Say whose captions these are, without taking the reader's settings"
```

---

### Task 7: The streamer sets it

**Files:**
- Modify: `apps/standalone/renderer/index.html`, `apps/standalone/renderer/app.ts`
- Test: `apps/standalone/test/renderer.test.ts`

**Interfaces:**
- Consumes: `AppConfig.brandName` / `AppConfig.brandColor` from Task 1.
- Produces: `#brandNameInput`, `#brandColorInput`, `#brandSwatch` in the settings markup, inside `data-group="viewers"`.

- [ ] **Step 1: Write the failing test**

Append to `apps/standalone/test/renderer.test.ts`:

```ts
describe("setting what viewers are told the stream is called", () => {
  const doc = () => new DOMParser().parseFromString(html, "text/html");

  it("lives with the other things viewers see", () => {
    // renderer.test.ts already fails if a subject is split across groups; this
    // is what viewers see, so it belongs with captions and speaker names
    const settings = doc().getElementById("settings") as HTMLElement;
    const group = (id: string) =>
      settings.querySelector(`#${id}`)?.closest("[data-group]")?.getAttribute("data-group") ?? null;
    expect(group("brandNameInput")).toBe("viewers");
    expect(group("brandColorInput")).toBe("viewers");
  });

  it("locks while live, because the hello is sent once", async () => {
    // the brand rides the publisher hello, which relayClient sends on open and
    // never again - so editing it mid-session would change nothing and say so
    // nowhere. Same reason the speaker-name fields disable.
    await bootWith({ setupDone: true, brandName: "Omer's stream" });
    expect(pushStatus, "boot() never registered for status").toBeTypeOf("function");
    pushStatus!({
      companion: { version: "test" },
      session: { state: "live" },
      relay: { localViewerUrl: "", remoteViewerUrl: "", uplinkState: "off" },
      usage: undefined,
    });
    await settle(40);

    expect((document.getElementById("brandNameInput") as HTMLInputElement).disabled).toBe(true);
    expect((document.getElementById("brandColorInput") as HTMLInputElement).disabled).toBe(true);
  });
});
```

`bootWith`, `pushStatus`, `settle` and the status payload shape are that file's
own; the `session: { state: "live" }` field is what `renderCaptionSettings()`
reads to decide the lock.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/standalone/test/renderer.test.ts -t "the stream is called"`
Expected: FAIL — `brandNameInput` is in no group.

- [ ] **Step 3: Add the field**

In `apps/standalone/renderer/index.html`, inside `<div class="keys-group" data-group="viewers">`, after the SPEAKER NAMES field:

```html
          <div class="field">
            <div class="field-label">STREAM NAME<span class="field-status dim">SHOWN TO VIEWERS</span></div>
            <p class="hint">What the header on a viewer&#39;s page says this stream is. Blank shows nothing at all. It does not change how captions look - size, font and theme belong to the device reading them.</p>
            <div class="field-row">
              <input id="brandNameInput" type="text" class="uinput mono" maxlength="24" autocomplete="off" spellcheck="false" placeholder="unbranded" />
              <label class="swatch" title="Accent colour"><span id="brandSwatch"></span><input id="brandColorInput" type="color" /></label>
            </div>
          </div>
```

- [ ] **Step 4: Wire it**

In `apps/standalone/renderer/app.ts`, inside `renderCaptionSettings()` after `renderSourceNames(live)`:

```ts
  const brandInput = inp("brandNameInput");
  if (document.activeElement !== brandInput) brandInput.value = config?.brandName || "";
  brandInput.disabled = live;
  const brandColour = safeSpeakerColor(config?.brandColor) || SPEAKER_COLORS[0];
  inp("brandColorInput").value = brandColour;
  inp("brandColorInput").disabled = live;
  $("brandSwatch").style.background = brandColour;
```

and beside the `sourceName` handlers (~`:2270`):

```ts
  // "change" not "input", for the same reason as the speaker fields: this
  // restarts a session, and every keystroke rebuilding the publisher would be
  // its own kind of broken
  inp("brandNameInput").onchange = () => {
    void saveAndApply({ brandName: inp("brandNameInput").value.trim() }, { restart: true });
  };
  inp("brandColorInput").onchange = () => {
    void saveAndApply(
      { brandColor: safeSpeakerColor(inp("brandColorInput").value) || "" },
      { restart: true },
    );
  };
```

**Note:** `ConfigStore.merge` skips `undefined` and `null`, so clearing sends `""` explicitly — which is what `.trim()` and the `|| ""` above already produce.

- [ ] **Step 5: Run the tests and the id guard**

Run: `npx vitest run apps/standalone && node scripts/check-renderer-ids.mjs && pnpm -r typecheck`
Expected: new tests PASS; all renderer ids resolve.

- [ ] **Step 6: Commit**

```bash
git add apps/standalone/renderer/index.html apps/standalone/renderer/app.ts apps/standalone/test/renderer.test.ts
git commit -m "Let a streamer name the stream people are reading"
```

---

### Task 8: Say what changed, and ship it

**Files:**
- Modify: `packages/shared/src/changelog.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: the `0.6.0` changelog entry `versions.test.ts` requires before the version can be bumped.

- [ ] **Step 1: Add the entry**

At the head of `CHANGELOG` in `packages/shared/src/changelog.ts`:

```ts
  {
    version: "0.6.0",
    date: "2026-09-07",
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
    ],
  },
```

Set `date` to the day the release is actually cut - `versions.test.ts` does not
check it, so nothing will catch a stale one but a reader.

**No AI attribution in this file.** Tags, release notes and changelog text carry the prose only.

- [ ] **Step 2: Check the entry parses and reads right**

Run: `pnpm --filter @callout-relay/shared build && npx vitest run packages/shared/test/changelog.test.ts && node scripts/release-notes.mjs 0.6.0`
Expected: build clean, changelog guard PASSES, and the notes print as a streamer would read them.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/changelog.ts
git commit -m "Write down what 0.6.0 changes for the people running it"
```

- [ ] **Step 4: Run the full gate**

Run:

```bash
pnpm -r build && pnpm -r typecheck && pnpm typecheck:test && pnpm test && node scripts/check-renderer-ids.mjs && pnpm smoke
```

Expected: everything green. **Stop here and hand back** — the version bump, tag and deploy are the user's call, not part of this plan.

---

## Notes for whoever executes this

- **Both halves are needed before anything is visible.** The viewer change reaches hosted viewers on the next Worker deploy; the settings change reaches people on the next app release. Neither alone does anything.
- **`~:NNN` line numbers are approximate** and were correct on 2026-09-07. Anchor on the symbol names — `publisherHello`, `currentLanguages`, `renderCaptionSettings`, `interface RoomState` — which do not drift.
- **If a test passes the first time you run it**, assume it did not run before assuming the code was already right. That happened four times in one session in `ITERATION_LOG.md`, and twice more in the session that produced this plan.
