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

console.log(changed ? `\n${changed} package(s) set to ${version}` : `already at ${version}`);
console.log(`next: git commit -am "Release v${version}" && git tag -a v${version} -m "v${version}"`);
console.log(`      git push origin master v${version}   # the Release workflow builds and publishes`);
