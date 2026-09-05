/**
 * Set the version across every workspace package at once.
 *   pnpm version-bump 0.3.1
 *
 * The release workflow refuses to build when the tag and
 * apps/standalone/package.json disagree, so keep them in step with this.
 */
import { globSync, readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("usage: pnpm version-bump <version>   e.g. pnpm version-bump 0.3.1");
  process.exit(1);
}

const files = [
  "package.json",
  ...globSync("apps/*/package.json"),
  ...globSync("packages/*/package.json"),
].filter((f) => !f.includes("node_modules"));

let changed = 0;
for (const file of files) {
  const raw = readFileSync(file, "utf8");
  const pkg = JSON.parse(raw);
  if (pkg.version === version) continue;
  const from = pkg.version;
  // rewrite in place so key order and formatting survive
  const next = raw.replace(/("version":\s*)"[^"]+"/, `$1"${version}"`);
  writeFileSync(file, next);
  console.log(`${file}: ${from} -> ${version}`);
  changed += 1;
}

// The Stream Deck manifest carries its own version and is not a package.json,
// so it sat at 0.1.0 through five releases: Elgato shows this number and uses
// it to decide a plugin is newer, so a stuck one reads as "never updated".
for (const file of globSync("apps/*/*.sdPlugin/manifest.json").filter((f) => !f.includes("node_modules"))) {
  const raw = readFileSync(file, "utf8");
  const current = JSON.parse(raw).Version;
  if (current === version) continue;
  writeFileSync(file, raw.replace(/("Version":\s*)"[^"]+"/, `$1"${version}"`));
  console.log(`${file}: ${current} -> ${version}`);
  changed += 1;
}

console.log(changed ? `\n${changed} file(s) set to ${version}` : `already at ${version}`);
console.log(`next: git commit -am "Release v${version}" && git tag -a v${version} -m "v${version}"`);
console.log(`      git push origin master v${version}   # the Release workflow builds and publishes`);
