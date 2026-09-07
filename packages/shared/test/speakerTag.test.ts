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
