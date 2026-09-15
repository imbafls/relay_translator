import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * What has to be outside the asar, and why nothing else notices when it is not.
 *
 * Two things in this app cannot be read from inside `app.asar`: a file a REAL
 * CHILD PROCESS has to execute, and a native `.node` binary the loader has to
 * open. `sttWorkerPath()` is the first - the STT worker runs as a thread and
 * also as the model-load probe, which is a child process - and sherpa-onnx is
 * the second.
 *
 * Every one of those failures is invisible in development. Unpackaged, there
 * is no asar at all: `sttWorkerPath()` falls back to the packed path and it
 * works, the native module loads off disk and it works, and the whole test
 * suite passes. The first time anybody finds out is on an installed copy, with
 * local speech simply not starting - and CLAUDE.md's own advice is not to
 * launch the packaged app casually, so that discovery is expensive.
 *
 * The native packages are FOUND rather than listed. sherpa-onnx ships its
 * binary in a platform package named in `optionalDependencies`, so the one
 * that matters here is a transitive install that nobody typed; a version bump
 * that renames it would leave the old name in `asarUnpack` matching nothing.
 */

const appDir = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  build?: { asar?: boolean; asarUnpack?: string[]; files?: string[] };
};

const unpack = (): string[] => pkg.build?.asarUnpack ?? [];
const covered = (name: string): boolean => unpack().some((p) => p.includes(name));

/** does anything under this directory carry a compiled addon */
function hasNativeBinary(dir: string, depth = 0): boolean {
  if (depth > 4 || !fs.existsSync(dir)) return false;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".bin") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (hasNativeBinary(full, depth + 1)) return true;
    } else if (e.name.endsWith(".node")) return true;
  }
  return false;
}

/** the app's runtime dependencies, plus the platform packages they pull in */
function shippedPackages(): { name: string; dir: string }[] {
  const out: { name: string; dir: string }[] = [];
  const seen = new Set<string>();

  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const dir = path.join(appDir, "node_modules", name);
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return; // not installed on this platform
    }
    out.push({ name, dir: real });

    // a platform binary arrives as an optionalDependency nobody typed
    try {
      const own = JSON.parse(fs.readFileSync(path.join(real, "package.json"), "utf8")) as {
        optionalDependencies?: Record<string, string>;
      };
      for (const opt of Object.keys(own.optionalDependencies ?? {})) {
        if (seen.has(opt)) continue;
        seen.add(opt);
        // pnpm puts the one that matches this platform in the store
        const storeRoot = path.resolve(appDir, "..", "..", "node_modules", ".pnpm");
        if (!fs.existsSync(storeRoot)) continue;
        const match = fs.readdirSync(storeRoot).find((d) => d.startsWith(`${opt}@`));
        if (!match) continue;
        const optDir = path.join(storeRoot, match, "node_modules", opt);
        if (fs.existsSync(optDir)) out.push({ name: opt, dir: optDir });
      }
    } catch {
      /* no package.json to read */
    }
  };

  for (const name of Object.keys(pkg.dependencies ?? {})) add(name);
  return out;
}

describe("what the installed app needs outside the archive", () => {
  it("unpacks the worker, because a child process cannot run a file inside an asar", () => {
    // main.ts computes an app.asar.unpacked path for exactly this file
    const main = fs.readFileSync(path.join(appDir, "src", "main.ts"), "utf8");
    expect(main, "sttWorkerPath no longer reaches for an unpacked copy").toContain("app.asar.unpacked");
    expect(
      covered("localSttWorker.js"),
      "sttWorkerPath looks for localSttWorker.js outside the asar and asarUnpack does not put it there",
    ).toBe(true);
  });

  it("unpacks every dependency that ships a compiled binary", () => {
    const native = shippedPackages().filter((p) => hasNativeBinary(p.dir));
    const missed = native.filter((p) => !covered(p.name)).map((p) => p.name);
    expect(
      missed,
      `these ship a .node the loader must open from disk, and asarUnpack does not name them: ${missed.join(", ")}`,
    ).toEqual([]);
  });

  it("found a dependency with a binary, so the assertion above is about something", () => {
    // if this app ever genuinely has none, this is the line to delete - but it
    // failing quietly to nothing is the failure the check exists to prevent
    const native = shippedPackages().filter((p) => hasNativeBinary(p.dir));
    expect(native.map((p) => p.name)).toContain("sherpa-onnx-win-x64");
  });

  it("packages the built output the worker comes from at all", () => {
    expect(pkg.build?.files ?? []).toContain("dist/**/*");
    expect(pkg.build?.asar, "asarUnpack means nothing if nothing is archived").toBe(true);
  });
});
