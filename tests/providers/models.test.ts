import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BUNDLED_MODELS,
  advancePast,
  loadModelCache,
  orderCandidates,
  resolveModel,
  type ModelDescriptor,
} from "../../src/providers/models.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "subpixel-models-"));
});

const LOW = [{ effort: "low", description: "fast" }];
const HIGH_ONLY = [{ effort: "high", description: "slow" }];

function model(partial: Partial<ModelDescriptor> & { slug: string }): ModelDescriptor {
  return {
    visibility: "list",
    priority: 10,
    default_reasoning_level: "medium",
    supported_reasoning_levels: LOW,
    ...partial,
  };
}

/** Mirrors the real ~/.codex/models_cache.json observed on 2026-09-12. */
const LIVE_CACHE = {
  fetched_at: new Date().toISOString(),
  etag: "W/\"abc\"",
  client_version: "0.154.0",
  models: [
    model({ slug: "gpt-6-astra", priority: 1 }),
    model({ slug: "gpt-reserve", priority: 3, visibility: "hide" }),
    model({ slug: "gpt-5.6-sol", priority: 10 }),
    model({ slug: "gpt-5.6-terra", priority: 20 }),
    model({ slug: "gpt-5.6-luna", priority: 30 }),
    model({ slug: "gpt-5.5", priority: 40 }),
    model({ slug: "codex-auto-review", priority: 43, visibility: "hide" }),
  ],
};

describe("orderCandidates", () => {
  it("produces the expected order for the live cache", () => {
    expect(orderCandidates(LIVE_CACHE.models).map((m) => m.slug)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
  });

  it("drops hidden models", () => {
    const out = orderCandidates([
      model({ slug: "visible", priority: 5 }),
      model({ slug: "hidden", priority: 1, visibility: "hide" }),
    ]);
    expect(out.map((m) => m.slug)).toEqual(["visible"]);
  });

  it("prefers models that support low reasoning effort", () => {
    const out = orderCandidates([
      model({ slug: "high-only", priority: 1, supported_reasoning_levels: HIGH_ONLY }),
      model({ slug: "has-low", priority: 99 }),
    ]);
    expect(out.map((m) => m.slug)).toEqual(["has-low", "high-only"]);
  });

  it("sorts by ascending priority inside a preference group", () => {
    const out = orderCandidates([
      model({ slug: "c", priority: 30 }),
      model({ slug: "a", priority: 10 }),
      model({ slug: "b", priority: 20 }),
    ]);
    expect(out.map((m) => m.slug)).toEqual(["a", "b", "c"]);
  });

  it("treats a missing reasoning array as no low support", () => {
    const out = orderCandidates([
      { slug: "bare", visibility: "list", priority: 1 } as ModelDescriptor,
      model({ slug: "low", priority: 50 }),
    ]);
    expect(out.map((m) => m.slug)).toEqual(["low", "bare"]);
  });

  it("returns an empty list when everything is hidden", () => {
    expect(orderCandidates([model({ slug: "x", visibility: "hide" })])).toEqual([]);
  });
});

describe("loadModelCache", () => {
  it("reads a fresh cache", async () => {
    const path = join(home, "models_cache.json");
    await writeFile(path, JSON.stringify(LIVE_CACHE));
    const cache = await loadModelCache(path);
    expect(cache?.models).toHaveLength(7);
  });

  it("returns undefined when the file is missing", async () => {
    expect(await loadModelCache(join(home, "nope.json"))).toBeUndefined();
  });

  it("returns undefined for malformed JSON", async () => {
    const path = join(home, "bad.json");
    await writeFile(path, "{{{");
    expect(await loadModelCache(path)).toBeUndefined();
  });

  it("returns undefined when the cache holds no model array", async () => {
    const path = join(home, "empty.json");
    await writeFile(path, JSON.stringify({ fetched_at: "x" }));
    expect(await loadModelCache(path)).toBeUndefined();
  });

  it("drops malformed descriptors and keeps the usable ones", async () => {
    // Someone else's program writes this file. Valid JSON with a non-empty array
    // says nothing about what is in the array, and every one of these reaches the
    // sort comparator and throws if it is not filtered here.
    const path = join(home, "mixed.json");
    await writeFile(
      path,
      JSON.stringify({
        fetched_at: new Date().toISOString(),
        models: [
          null,
          { visibility: "list", priority: 1 },
          { slug: "bad-levels", visibility: "list", supported_reasoning_levels: "low" },
          { slug: "null-level", visibility: "list", supported_reasoning_levels: [null] },
          { slug: "good", visibility: "list", priority: 5, supported_reasoning_levels: [{ effort: "low" }] },
        ],
      }),
    );
    const cache = await loadModelCache(path);
    expect(cache?.models.map((m) => m.slug)).toEqual(["good"]);
    expect(() => orderCandidates(cache!.models)).not.toThrow();
  });

  it("returns undefined when no descriptor survives, so the bundled list is used", async () => {
    const path = join(home, "all-bad.json");
    await writeFile(path, JSON.stringify({ models: [null] }));
    expect(await loadModelCache(path)).toBeUndefined();

    const result = await resolveModel({ cachePath: path });
    expect(result.source).toBe("bundled");
    expect(result.slug).toBe(BUNDLED_MODELS[0]!.slug);
  });
});

describe("resolveModel", () => {
  it("honours an explicit override without reading the cache", async () => {
    const result = await resolveModel({ override: "my-model", cachePath: join(home, "nope.json") });
    expect(result.slug).toBe("my-model");
    expect(result.source).toBe("override");
  });

  it("uses the on-disk cache when present", async () => {
    const path = join(home, "models_cache.json");
    await writeFile(path, JSON.stringify(LIVE_CACHE));
    const result = await resolveModel({ cachePath: path });
    expect(result.slug).toBe("gpt-6-astra");
    expect(result.source).toBe("cache");
    expect(result.candidates.map((m) => m.slug)).toContain("gpt-5.6-sol");
  });

  it("marks an old cache stale but still uses it", async () => {
    const path = join(home, "old.json");
    const old = { ...LIVE_CACHE, fetched_at: new Date(Date.now() - 48 * 3600_000).toISOString() };
    await writeFile(path, JSON.stringify(old));
    const result = await resolveModel({ cachePath: path });
    expect(result.slug).toBe("gpt-6-astra");
    expect(result.source).toBe("stale-cache");
    expect(result.stale).toBe(true);
  });

  it("treats an unparseable fetched_at as stale", async () => {
    const path = join(home, "nodate.json");
    await writeFile(path, JSON.stringify({ ...LIVE_CACHE, fetched_at: "not-a-date" }));
    const result = await resolveModel({ cachePath: path });
    expect(result.source).toBe("stale-cache");
    expect(result.stale).toBe(true);
  });

  it("falls back to the bundled list when no cache exists", async () => {
    const result = await resolveModel({ cachePath: join(home, "nope.json") });
    expect(result.source).toBe("bundled");
    expect(result.slug).toBe(BUNDLED_MODELS[0]!.slug);
  });
});

describe("advancePast", () => {
  it("returns the next candidate", () => {
    const ordered = orderCandidates(LIVE_CACHE.models);
    expect(advancePast(ordered, "gpt-6-astra")?.slug).toBe("gpt-5.6-sol");
  });

  it("returns undefined after the last candidate", () => {
    const ordered = orderCandidates(LIVE_CACHE.models);
    expect(advancePast(ordered, "gpt-5.5")).toBeUndefined();
  });

  it("returns undefined for an unknown slug", () => {
    expect(advancePast(orderCandidates(LIVE_CACHE.models), "not-a-model")).toBeUndefined();
  });
});
