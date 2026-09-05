import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  FALLBACK_STT,
  LOCAL_VAD,
  MODEL_TIERS,
  STT_MODELS,
  TRANSLATION_MODELS,
  clampChannels,
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
    [2, 2],
    [1, 1],
    [0, 1],
    [3, 1],
    [-1, 1],
    ["2", 1],
    [null, 1],
    [undefined, 1],
    [NaN, 1],
  ])("clamps %p to %i", (input, expected) => {
    expect(clampChannels(input)).toBe(expected);
  });
});
