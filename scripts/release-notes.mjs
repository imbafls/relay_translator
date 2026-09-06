/**
 * Print the release notes for a version, from the changelog the app ships.
 *
 *   node scripts/release-notes.mjs 0.5.4              -> stdout
 *   node scripts/release-notes.mjs 0.5.4 | gh release edit v0.5.4 --notes-file -
 *
 * One source for the panel the app shows after an update and the notes people
 * read on the releases page, so the two cannot drift. Prose only: no tooling
 * credit and no emoji, which is what the changelog tests already enforce.
 */
import { CHANGELOG } from "../packages/shared/dist/index.js";

const want = (process.argv[2] || "").replace(/^v/, "");
if (!want) {
  console.error("usage: node scripts/release-notes.mjs <version>");
  console.error("known: " + CHANGELOG.map((e) => e.version).join(", "));
  process.exit(1);
}

const entry = CHANGELOG.find((e) => e.version === want);
if (!entry) {
  console.error(`no changelog entry for ${want}`);
  console.error("known: " + CHANGELOG.map((e) => e.version).join(", "));
  process.exit(1);
}

const KIND = { added: "New", fixed: "Fixed", changed: "Changed" };
console.log(entry.headline);
console.log("");
for (const c of entry.changes) console.log(`${KIND[c.kind] || c.kind}: ${c.text}`);
