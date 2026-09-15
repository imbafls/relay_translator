import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { MIME } from "../src/server";

/**
 * The relay serves the viewer bundle straight off disk and picks a content type
 * from a map, falling back to `application/octet-stream` for anything it does
 * not recognise. That fallback is the right default for the update binaries it
 * also serves, and the wrong one for a page: a browser with `nosniff` refuses a
 * stylesheet or a script sent as octet-stream outright, and quietly ignores a
 * web manifest, so the failure is a page that renders wrong rather than an
 * error anybody sees.
 *
 * The bundle is `packages/viewer/public`, which the hosted Worker serves too
 * and the desktop build copies wholesale into `dist/viewer`. So a file type
 * added there has to be one this map knows, and nothing said so until now: the
 * font licence has been shipping as octet-stream since it was added.
 *
 * Read from the directory rather than listed, so the next new type is covered
 * the day it arrives.
 */

const bundle = path.resolve(__dirname, "..", "..", "viewer", "public");

/** every distinct file extension in the shipped viewer bundle */
function extensions(): string[] {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const ext = path.extname(e.name).toLowerCase();
        if (ext) out.add(ext);
      }
    }
  };
  walk(bundle);
  return [...out].sort();
}

describe("serving the viewer bundle", () => {
  it("knows a content type for every kind of file in it", () => {
    const unknown = extensions().filter((ext) => !MIME[ext]);
    expect(
      unknown,
      `these ship in the viewer bundle and the relay would send them as application/octet-stream: ${unknown.join(", ")}`,
    ).toEqual([]);
  });

  it("found the bundle, so the assertion above is about something", () => {
    // if this ever reads an empty directory the check above passes while
    // covering nothing at all
    const found = extensions();
    expect(found.length).toBeGreaterThan(4);
    expect(found).toContain(".js");
    expect(found).toContain(".css");
  });

  it("sends a stylesheet and a script as themselves, which nosniff requires", () => {
    expect(MIME[".css"]).toMatch(/^text\/css\b/);
    expect(MIME[".js"]).toMatch(/^text\/javascript\b/);
  });
});
