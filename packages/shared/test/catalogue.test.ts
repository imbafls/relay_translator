import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_CONFIG,
  FALLBACK_STT,
  LOCAL_VAD,
  MODEL_TIERS,
  STT_MODELS,
  TRANSLATION_MODELS,
  clampChannels,
  MAX_CAPTURE_CHANNELS,
  isLocalStt,
  modelDiskBytes,
  recommendTier,
  sttModel,
} from "../src/index";

/**
 * The catalogue is data, and every field in it is a promise the download and
 * load paths rely on at runtime. A model added with a missing engine, an
 * archive that unpacks under a different name, or a mel-bin count that does not
 * match the export does not fail here - it fails on a user's PC, mid-session,
 * which is how whisper-small came to abort the whole app. These are the
 * invariants that were only ever enforced by review.
 */

const local = STT_MODELS.filter((m) => m.provider === "local");
const cloud = STT_MODELS.filter((m) => m.provider !== "local");

describe("catalogue shape", () => {
  it("has no duplicate ids", () => {
    const ids = STT_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every model a non-empty label", () => {
    for (const m of STT_MODELS) expect(m.label.trim().length).toBeGreaterThan(0);
  });

  it("resolves every id through sttModel", () => {
    for (const m of STT_MODELS) expect(sttModel(m.id)?.id).toBe(m.id);
  });

  it("agrees with isLocalStt on every entry", () => {
    for (const m of local) expect(isLocalStt(m.id)).toBe(true);
    for (const m of cloud) expect(isLocalStt(m.id)).toBe(false);
  });
});

describe("local models carry everything the loader needs", () => {
  it.each(local.map((m) => [m.id, m] as const))("%s", (_id, m) => {
    // the worker picks its sherpa constructor off engine; without it the
    // session fails with "unknown local model" instead of loading
    expect(m.engine).toBeTruthy();
    expect(m.kind === "streaming" || m.kind === "offline").toBe(true);
    expect(m.files?.length ?? 0).toBeGreaterThan(0);
    expect(m.sizeMb ?? 0).toBeGreaterThan(0);
    expect(MODEL_TIERS.map((t) => t.id)).toContain(m.tier);
  });

  it.each(local.map((m) => [m.id, m] as const))(
    "%s advertises the size it will actually download",
    (_id, m) => {
      // sizeMb is what the DOWNLOAD button shows. Every formatter divides by
      // 1000, so this field is decimal MB; the archive entries were quietly in
      // MiB, which understated each of them by about five percent.
      const bytes = m.archive ? m.archive.size : (m.files ?? []).reduce((n, f) => n + f.size, 0);
      const claimed = (m.sizeMb ?? 0) * 1e6;
      const drift = Math.abs(claimed - bytes) / bytes;
      expect(
        drift,
        `${m.id} says ${m.sizeMb} MB but downloads ${(bytes / 1e6).toFixed(1)} MB`,
      ).toBeLessThan(0.02);
    },
  );

  it("says how much disk each model needs, VAD included where it is required", () => {
    const vad = LOCAL_VAD.files!.reduce((n, f) => n + f.size, 0);
    for (const m of local) {
      const files = (m.files ?? []).reduce((n, f) => n + f.size, 0);
      const expected = m.kind === "offline" ? files + vad : files;
      expect(modelDiskBytes(m), m.id).toBe(expected);
      expect(modelDiskBytes(m)).toBeGreaterThan(0);
    }
  });

  it("shows that an archive needs more room than it downloads", () => {
    // the reason the helper exists: sizeMb answers how long, not whether it fits
    const turbo = sttModel("local-whisper-turbo")!;
    expect(modelDiskBytes(turbo)).toBeGreaterThan(turbo.archive!.size * 1.5);
  });

  it("only ever claims a mel-bin count the exports actually use", () => {
    for (const m of local) {
      if (m.melBins !== undefined) expect([80, 128]).toContain(m.melBins);
    }
  });

  it("keeps file names unique within a model", () => {
    for (const m of local) {
      const names = (m.files ?? []).map((f) => f.name);
      expect(new Set(names).size, `${m.id} repeats a file name`).toBe(names.length);
    }
  });

  /**
   * Where a model's bytes come from, and whether that place can change under us.
   *
   * Every archive model, and the shared VAD, fetch a GitHub release asset, which
   * is immutable - which is what made pinning their SHA-256 safe in 516247f. The
   * loose-file models fetched `huggingface.co/<repo>/resolve/main/<file>`, and
   * `main` is a branch: whatever it points at today is not a promise about
   * tomorrow. Since 03a3308 that matters more than it did, because readiness now
   * holds those files to the exact size the catalogue declares - so an upstream
   * re-upload would make an installed model read as damaged AND make the
   * re-download fail the write-side check, with no way out but deleting it.
   *
   * Verified before pinning, against all ten files: the revision-pinned URL and
   * the branch URL serve identical bytes, by ETag, and every size matches the
   * catalogue exactly.
   */
  it("fetches no model file from a branch that can move under it", () => {
    const moving: string[] = [];
    for (const m of local) {
      for (const f of m.files ?? []) {
        if (!f.url) continue;
        if (/\/resolve\/(main|master)\//.test(f.url)) moving.push(`${m.id}/${f.name}`);
      }
    }
    for (const f of LOCAL_VAD.files ?? []) {
      if (/\/resolve\/(main|master)\//.test(f.url)) moving.push(`local-vad-silero/${f.name}`);
    }
    expect(moving, "a file whose bytes can be replaced without the catalogue changing").toEqual([]);
  });

  /**
   * The size check in 2329673 closes truncation. It does not close substitution:
   * a file of exactly the right length is accepted whatever is in it. The
   * archives have had a pinned SHA-256 since 516247f, and the reason the loose
   * files did not was that pinning content to a moving pointer is meaningless -
   * 90b27e5 fixed the pointer, so there is no longer a reason.
   *
   * Required of a file WITH a url, not of every file. An archive model's `files`
   * describe what it unpacks to; they have no url, nothing fetches them
   * individually, and the archive carries the digest for all of them.
   */
  it("says what every file it fetches should hash to", () => {
    const undigested: string[] = [];
    for (const m of local) {
      for (const f of m.files ?? []) {
        if (!f.url) continue;
        if (!/^[0-9a-f]{64}$/.test(f.sha256 ?? "")) undigested.push(`${m.id}/${f.name}`);
      }
    }
    for (const f of LOCAL_VAD.files ?? []) {
      if (f.url && !/^[0-9a-f]{64}$/.test(f.sha256 ?? "")) undigested.push(`local-vad-silero/${f.name}`);
    }
    expect(undigested, "a file fetched over the network with nothing saying what it should be").toEqual([]);
  });

  it("pins every Hugging Face file to a full commit, not a name that can be re-pointed", () => {
    const loose: string[] = [];
    for (const m of local) {
      for (const f of m.files ?? []) {
        if (!f.url || !f.url.includes("huggingface.co")) continue;
        const rev = /\/resolve\/([^/]+)\//.exec(f.url)?.[1] ?? "";
        if (!/^[0-9a-f]{40}$/.test(rev)) loose.push(`${m.id}/${f.name} -> ${rev}`);
      }
    }
    expect(loose, "a revision that is not a 40-character commit can be moved to point elsewhere").toEqual([]);
  });

  it("gives every declared file a url or an archive to come out of", () => {
    for (const m of local) {
      for (const f of m.files ?? []) {
        if (m.archive) continue;
        expect(f.url, `${m.id}/${f.name} has no url`).toMatch(/^https:\/\//);
        expect(f.size, `${m.id}/${f.name} has no size`).toBeGreaterThan(0);
      }
    }
  });
});

describe("archive models", () => {
  const archived = local.filter((m) => m.archive);

  it("there is at least one, so these assertions mean something", () => {
    expect(archived.length).toBeGreaterThan(0);
  });

  it.each(archived.map((m) => [m.id, m] as const))(
    "%s maps every file it declares to an entry in the archive",
    (_id, m) => {
      const pick = m.archive!.pick;
      for (const f of m.files ?? []) {
        // a file with no pick entry is never extracted, and the model then
        // fails to load with a missing-file error the user cannot act on
        expect(Object.keys(pick), `${m.id} has no archive entry for ${f.name}`).toContain(f.name);
        expect(pick[f.name].length).toBeGreaterThan(0);
      }
      expect(m.archive!.url).toMatch(/^https:\/\//);
      expect(m.archive!.size).toBeGreaterThan(0);
    },
  );

  it.each(archived.map((m) => [m.id, m] as const))(
    "%s pins the compressed archive by SHA-256",
    (_id, m) => {
      // Reflect keeps this runtime guard red before sha256 becomes a required
      // catalogue field, rather than turning the watched failure into a type error.
      expect(Reflect.get(m.archive!, "sha256"), `${m.id} has no pinned archive digest`).toMatch(/^[0-9a-f]{64}$/);
    },
  );
});

describe("defaults resolve", () => {
  it("ships a default STT model that is in the catalogue", () => {
    expect(sttModel(DEFAULT_CONFIG.stt), `${DEFAULT_CONFIG.stt} is not in STT_MODELS`).toBeTruthy();
  });

  it("ships a default STT model that needs no download", () => {
    // a fresh install has no local models on disk, so the default has to be cloud
    expect(isLocalStt(DEFAULT_CONFIG.stt)).toBe(false);
  });

  it("ships a default translation model that is offered in the picker", () => {
    expect(TRANSLATION_MODELS.map((t) => t.id)).toContain(DEFAULT_CONFIG.translation);
  });

  it("keeps a cloud model available to fall back to", () => {
    // the app strands itself if a config names a model that left the catalogue
    // and the thing it falls back to has left as well
    expect(cloud.length).toBeGreaterThan(0);
  });

  it("points FALLBACK_STT at a model that is still here", () => {
    expect(sttModel(FALLBACK_STT), `${FALLBACK_STT} is not in STT_MODELS`).toBeTruthy();
  });

  it("points FALLBACK_STT at a model that needs no download", () => {
    // the fallback runs when nothing is known to be on disk, so it cannot be local
    expect(isLocalStt(FALLBACK_STT)).toBe(false);
  });

  it("describes the VAD every offline model needs", () => {
    expect(LOCAL_VAD.files?.length).toBeGreaterThan(0);
    for (const f of LOCAL_VAD.files!) {
      expect(f.url).toMatch(/^https:\/\//);
      expect(f.size).toBeGreaterThan(0);
    }
    expect(local.some((m) => m.kind === "offline")).toBe(true);
  });
});

describe("hardware recommendation", () => {
  it.each([
    [4, 8, "light"],
    [6, 8, "medium"],
    [8, 16, "medium"],
    [12, 16, "heavy"],
    [16, 32, "heavy"],
    // plenty of threads but not the RAM: heavy needs both
    [12, 8, "medium"],
    [6, 4, "light"],
  ])("%i threads and %i GB recommends %s", (threads, ram, tier) => {
    expect(recommendTier(threads, ram)).toBe(tier);
  });

  it("only ever recommends a tier that exists", () => {
    const ids = MODEL_TIERS.map((t) => t.id);
    for (const threads of [1, 2, 4, 6, 8, 12, 16, 32, 64]) {
      for (const ram of [2, 4, 8, 16, 32, 128]) {
        expect(ids).toContain(recommendTier(threads, ram));
      }
    }
  });

  it("offers at least one model at every tier it can recommend", () => {
    for (const tier of MODEL_TIERS.map((t) => t.id)) {
      expect(local.some((m) => m.tier === tier), `nothing to pick at tier ${tier}`).toBe(true);
    }
  });
});

describe("channel clamping", () => {
  it.each([
    [3, 3],
    [2, 2],
    [1, 1],
    [0, 1],
    [4, 1],
    [-1, 1],
    ["2", 1],
    [null, 1],
    [undefined, 1],
    [NaN, 1],
  ])("clamps %p to %i", (input, expected) => {
    expect(clampChannels(input)).toBe(expected);
  });

  /**
   * A count above the cap collapses to mono rather than to the cap. The number
   * is not a preference, it is how many samples every interleaved frame holds:
   * read a 4-channel frame as 3 and every channel after the first is a
   * different voice on every frame. Mono is the only reading that cannot be
   * wrong about which sample belongs to whom.
   */
  it("does not round an over-count down to the cap", () => {
    expect(clampChannels(MAX_CAPTURE_CHANNELS + 1)).toBe(1);
  });

  it("caps at what the capture worklet can actually interleave", () => {
    expect(clampChannels(MAX_CAPTURE_CHANNELS)).toBe(MAX_CAPTURE_CHANNELS);
  });
});

/**
 * README.md carries a table of the local models with a download size against
 * each one, and ends it by saying this file "is the catalogue of record - the
 * table above will drift before that does". It was right. Seven of the ten
 * sizes had drifted, one of them by a factor of four and a half.
 *
 * That number is not decoration. It is what somebody picking a model decides
 * on - "streaming English, larger" reads very differently at 68 MB than at
 * 310 MB - and it is the one claim on that page a test can settle outright.
 */
describe("the model table in README.md", () => {
  const readme = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "README.md"), "utf8");

  /** `| \`local-x\` | what it is | 44 MB |` -> { id, mb } */
  const rows = [...readme.matchAll(/^\|\s*`(local-[a-z0-9.-]+)`\s*\|[^|]*\|\s*(\d+)\s*MB\s*\|/gim)].map((m) => ({
    id: m[1]!,
    mb: Number(m[2]),
  }));

  it("found the table, so the assertions below are reading something", () => {
    expect(rows.length).toBeGreaterThan(5);
  });

  it("names models that exist", () => {
    const known = new Set(STT_MODELS.map((m) => m.id));
    expect(rows.filter((r) => !known.has(r.id)).map((r) => r.id)).toEqual([]);
  });

  it("quotes the size the catalogue holds", () => {
    const byId = new Map(STT_MODELS.map((m) => [m.id, m]));
    const wrong = rows
      .filter((r) => byId.get(r.id)?.sizeMb !== r.mb)
      .map((r) => `${r.id}: README says ${r.mb} MB, the catalogue says ${byId.get(r.id)?.sizeMb} MB`);
    expect(wrong, `the download size is what somebody picks a model on:\n${wrong.join("\n")}`).toEqual([]);
  });

  it("lists every local model, so a new one cannot be quietly left out", () => {
    const listed = new Set(rows.map((r) => r.id));
    const missing = STT_MODELS.filter((m) => m.id.startsWith("local-") && !listed.has(m.id)).map((m) => m.id);
    expect(missing, "these are installable and the README does not mention them").toEqual([]);
  });
});
