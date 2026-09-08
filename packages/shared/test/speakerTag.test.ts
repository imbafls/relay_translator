import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A caption is built once and re-emitted three times, and the two halves are
 * written differently. The origin SPREADS the tag:
 *
 *   { type: "subtitle", id, source, final, latency, ...tag }   session.ts:293
 *
 * so it cannot lose a field. Every hop after it ENUMERATES:
 *
 *   { type: "subtitle", id, source, target, final, latency, channel, speaker }
 *
 * and two of the three quietly stopped there. `color` was never copied, so
 * per-speaker colour worked on the LAN and did nothing for anyone watching over
 * the internet. Nothing caught it: the literals are typed `& SpeakerTag`, an
 * absent optional field compiles, and every hop that drops it is one a
 * developer testing on their own machine never crosses.
 *
 * This reads the source rather than the behaviour on purpose. The property is
 * syntactic - "this literal names every field of the tag" - and two of the
 * three sites are a Durable Object and an Electron main process, neither of
 * which a unit test reaches. `uplink.test.ts` covers the third for real, over
 * sockets; this covers all three against being written the same way again.
 */

const root = path.resolve(__dirname, "..", "..", "..");

/** every field of SpeakerTag, which is what a hop has to carry whole */
const TAG_FIELDS = ["channel", "speaker", "color"];

const HOPS = [
  {
    file: "packages/relay/src/server.ts",
    hop: "the embedded relay re-emitting an uplinked caption to its own viewers",
  },
  {
    file: "apps/standalone/src/main.ts",
    hop: "the desktop app forwarding a caption up to the hosted relay",
  },
  {
    file: "apps/hosted-relay/src/room.ts",
    hop: "the hosted relay fanning a caption out to internet viewers",
  },
];

/** the object literal containing `type: "subtitle"`, from its `{` to its `}` */
function subtitleLiteral(src: string): string {
  const at = src.indexOf('type: "subtitle"');
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

describe("a caption keeps its speaker tag at every hop", () => {
  for (const { file, hop } of HOPS) {
    it(`carries the whole tag through ${hop}`, () => {
      const src = fs.readFileSync(path.join(root, file), "utf8");
      const literal = subtitleLiteral(src);
      expect(literal, `no subtitle literal found in ${file}`).not.toBe("");

      // a spread carries whatever the tag holds, now and later, so it passes
      if (/\.\.\./.test(literal)) return;

      const missing = TAG_FIELDS.filter((f) => !new RegExp(`\\b${f}\\b\\s*:`).test(literal));
      expect(missing, `${file} enumerates the caption and omits: ${missing.join(", ")}`).toEqual([]);
    });
  }
});

/**
 * Same defect shape, a fourth file the guard above cannot see. `main.ts`
 * never writes a `type: "hello"` object literal of its own - it hands a
 * hello-shaped object straight to `uplink.connect()` or `uplink.sendHello()`
 * and the uplink client stamps the type on before it hits the wire. The HOPS
 * guard keys on `type: "hello"` (or `"subtitle"`) text appearing in one of
 * four named files, so it is structurally blind to a call site that carries
 * neither the type nor a file of its own worth adding to that list.
 *
 * The drop this exists to catch: `bridgeBroadcasts()` forwards the embedded
 * relay's own live hello up to the uplink by hand-copying `languages`,
 * `translates` and `since` off `msg` and leaving `brandName`/`brandColor`
 * behind - legal and silent, because both fields are optional. That hello
 * fires every time the publisher goes live, so the hosted room's brand -
 * set correctly by the connect hello in `startUplink()` - would be wiped
 * back to blank the instant a viewer had a reason to look.
 *
 * This finds every `uplink.connect(`/`uplink.sendHello(` call in the file by
 * pattern, not by line number, so a fourth call site added tomorrow is
 * picked up and checked automatically instead of needing a fourth
 * hand-written assertion.
 */
describe("the uplink hears the stream's brand at every hello main.ts hands it", () => {
  const file = "apps/standalone/src/main.ts";
  const src = fs.readFileSync(path.join(root, file), "utf8");

  /**
   * the object literal this call is handed, or "" if it is handed anything else
   *
   * This used to scan forward to the first `{` it could find. That is only
   * correct while every call site happens to pass a literal inline: rewrite one
   * as `uplink.sendHello(buildHello(cfg, msg))` and the scan sails past the call
   * entirely and checks whatever block comes next - a function body, an object
   * three statements away - reporting it green. The argument has to BE the
   * literal, not merely be followed by one somewhere downstream, so the first
   * non-space character after the `(` has to be the `{`.
   */
  function literalFrom(text: string, from: number): string {
    let open = from;
    while (open < text.length && /\s/.test(text[open])) open += 1;
    if (text[open] !== "{") return "";
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(open, i + 1);
      }
    }
    return "";
  }

  const callSites = Array.from(src.matchAll(/uplink\.(?:connect|sendHello)\(/g)).map((m) => ({
    line: src.slice(0, m.index).split("\n").length,
    // from just past the `(`, so what gets checked is the argument itself
    literal: literalFrom(src, (m.index as number) + m[0].length),
  }));

  it("still finds exactly the three known uplink hello call sites", () => {
    // guards the guard: a count that moves means a call site was added or
    // removed, and this file's coverage needs a second look either way
    expect(callSites.map((c) => c.line), "uplink.connect/sendHello call sites").toHaveLength(3);
  });

  it.each(callSites)(`${file}:$line names both brandName and brandColor`, ({ line, literal }) => {
    expect(
      literal,
      `${file}:${line} call site does not pass a literal, so this guard cannot see the brand it carries - inline the hello or teach the guard to follow the builder`,
    ).not.toBe("");

    // a spread carries whatever the hello holds, now and later, so it passes
    if (/\.\.\./.test(literal)) return;

    const missing = ["brandName", "brandColor"].filter((f) => !new RegExp(`\\b${f}\\b\\s*:`).test(literal));
    expect(missing, `${file}:${line} enumerates the hello and omits: ${missing.join(", ")}`).toEqual([]);
  });
});

/**
 * The same disease, one frame over. A hello is rebuilt by hand at nine places
 * across the four files below - field by field, never by spreading - and a
 * field added to the shared type alone reaches none of them. It compiles, it
 * ships, and it carries nothing. `color` proved that is not hypothetical; the
 * guard at the top of this file is the scar it left.
 *
 * `hello` earns its own guard because it is the only frame a late joiner is
 * guaranteed to get. Drop the brand from a subtitle and one caption is plain;
 * drop it from a hello and the viewer never learns whose captions these are.
 *
 * A spread passes on purpose: `...currentBrand` carries whatever the brand
 * holds now and whatever is added to it later, which is the shape this guard
 * exists to encourage rather than punish.
 */
const HELLO_HOPS = [
  {
    file: "packages/relay/src/server.ts",
    hop: "the embedded relay greeting its own viewers",
    frames: 4,
  },
  {
    file: "packages/companion/src/relayClient.ts",
    hop: "the app greeting its own relay",
    frames: 1,
  },
  {
    file: "packages/companion/src/uplinkClient.ts",
    hop: "the app greeting the hosted relay",
    frames: 2,
  },
  {
    file: "apps/hosted-relay/src/room.ts",
    hop: "the hosted relay greeting an internet viewer",
    frames: 2,
  },
];

/** what a hello has to name for a viewer to know whose captions these are */
const BRAND_FIELDS = ["brandName", "brandColor"];

/**
 * Replace every comment with spaces, keeping length and newlines exact so
 * offsets and line numbers still point at the real file.
 *
 * This is load-bearing, not tidiness. The frame test below asks whether a
 * send-shaped call opens just before a literal, and `server.ts` carries this
 * sentence in the doc comment over `publisherHello`:
 *
 *   "a half-written client or a malicious one can all send a shape that ..."
 *
 * Read as code, that prose made the *type annotation* on the line beneath it -
 * `msg: PublisherToServer & { type: "hello" }` - look like a frame being sent,
 * and the guard went red over a declaration that never builds a hello at all.
 * A guard that reads source has to be told what is source.
 *
 * `\r` survives alongside `\n`: this repo stores LF but checks a good deal out
 * as CRLF - `git ls-files --eol` lists fourteen `w/crlf` files today, one of
 * them `packages/relay/src/index.ts` - so a hop file can arrive either way.
 * Blanking a `\r` would shorten the text and slide every offset after it.
 */
function blankComments(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
    }
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j += 1;
      blank(i, j);
      i = j;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const j = end < 0 ? src.length : end + 2;
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'" || c === "`") {
      // stepped over, never blanked: a `//` inside a URL string must not eat
      // the rest of that line, or a real hop downstream of it goes unseen
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
    } else {
      i += 1;
    }
  }
  return out.join("");
}

/**
 * Every `type: "hello"` object literal, each with the offset of its own `{`.
 *
 * The offset is returned rather than recovered later with `indexOf`, which
 * finds the FIRST copy of a string and not the one that was actually found.
 * `server.ts` builds two viewer hellos whose bodies are identical once
 * whitespace is ignored - they differ today only because the second was pasted
 * without re-indenting its tail. One formatter pass over that file makes them
 * the same text, and every question asked about the second would silently be
 * answered about the first.
 */
function helloLiterals(src: string): { at: number; literal: string }[] {
  const found: { at: number; literal: string }[] = [];
  let from = -1;
  for (;;) {
    const hit = src.indexOf('type: "hello"', from + 1);
    if (hit < 0) return found;
    from = hit;
    let open = hit;
    while (open >= 0 && src[open] !== "{") open -= 1;
    if (open < 0) continue;
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          found.push({ at: open, literal: src.slice(open, i + 1) });
          break;
        }
      }
    }
  }
}

/**
 * A frame is a literal with a send-shaped call open in front of it, which is
 * what separates `toViewers({ type: "hello" ... })` from the `{ type: "hello" }`
 * that only narrows a union in a type. The leading boundary keeps `resend(`
 * from passing as `send(`; the window is short enough that the call has to be
 * the one this literal is an argument to, and long enough to reach `ws.send(`
 * around an intervening `JSON.stringify(`.
 */
const SEND_CALL = /(?:^|[^\w$])(?:send|broadcast|toViewers)\w*\s*\(/;

describe("a hello keeps the brand at every hop", () => {
  for (const { file, hop, frames } of HELLO_HOPS) {
    it(`carries the brand through ${hop}`, () => {
      const code = blankComments(fs.readFileSync(path.join(root, file), "utf8"));
      const built = helloLiterals(code).filter(({ at }) =>
        SEND_CALL.test(code.slice(Math.max(0, at - 160), at)),
      );

      // guards the guard. Every assertion below runs inside a loop, so a filter
      // that quietly stopped matching would execute none of them and report
      // green - the exact shape of a test that proves nothing. A count that
      // moves means a hello was added, removed or rewritten, and this file's
      // coverage needs a second look either way.
      expect(built.length, `hello frames built in ${file}`).toBe(frames);

      for (const { at, literal } of built) {
        const line = code.slice(0, at).split("\n").length;

        // a spread carries whatever the brand holds, now and later, so it passes
        if (/\.\.\./.test(literal)) continue;

        // `[:,}]` so shorthand counts: `{ brandName, brandColor }` is a hello
        // that carries the brand. A bare mention - `safeBrandName(brandName)` -
        // still does not, since that leaves a `)` behind the name.
        const missing = BRAND_FIELDS.filter((f) => !new RegExp(`\\b${f}\\b\\s*[:,}]`).test(literal));
        expect(missing, `${file}:${line} builds a hello and omits: ${missing.join(", ")}`).toEqual([]);
      }
    });
  }
});
