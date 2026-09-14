import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cacheKey,
  lookupCache,
  materialiseFromCache,
  storeCache,
} from "../../src/engine/cache.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "subpixel-cache-"));
});

const BASE = { prompt: "a red fox", size: "1024x1024", format: "png" as const };

describe("cacheKey", () => {
  it("is stable for identical requests", () => {
    expect(cacheKey(BASE)).toBe(cacheKey({ ...BASE }));
  });

  it("ignores the output path", () => {
    expect(cacheKey({ ...BASE, outputPath: "/a.png" })).toBe(
      cacheKey({ ...BASE, outputPath: "/b.png" }),
    );
  });

  it("ignores the driver model", () => {
    expect(cacheKey({ ...BASE, model: "gpt-6-astra" })).toBe(
      cacheKey({ ...BASE, model: "gpt-5.5" }),
    );
  });

  it("changes with the prompt", () => {
    expect(cacheKey({ ...BASE, prompt: "a blue fox" })).not.toBe(cacheKey(BASE));
  });

  it("changes with exactSize", () => {
    expect(cacheKey({ ...BASE, exactSize: "800x600" })).not.toBe(cacheKey(BASE));
  });

  it("changes with background", () => {
    expect(cacheKey({ ...BASE, background: "transparent" })).not.toBe(cacheKey(BASE));
  });

  it("keys on reference content, not on the number of references", () => {
    expect(cacheKey({ ...BASE, referenceHashes: ["aa"] })).not.toBe(cacheKey(BASE));
  });

  it("treats reference order as significant", () => {
    expect(cacheKey({ ...BASE, referenceHashes: ["aa", "bb"] })).not.toBe(
      cacheKey({ ...BASE, referenceHashes: ["bb", "aa"] }),
    );
  });

  it("leaves a reference-free key unchanged by the new field", () => {
    expect(cacheKey({ ...BASE, referenceHashes: [] })).toBe(cacheKey(BASE));
  });

  it("returns a 64-character hex digest", () => {
    expect(cacheKey(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("lookupCache / storeCache", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
  const digest = createHash("sha256").update(PNG).digest("hex");

  async function store(key: string, data = PNG, path = join(dir, "fox.png")) {
    await storeCache(
      dir,
      key,
      {
        path,
        bytes: data.length,
        format: "png",
        sha256: createHash("sha256").update(data).digest("hex"),
      },
      data,
    );
  }

  it("round-trips the bytes, not a path", async () => {
    const key = cacheKey(BASE);
    await store(key);
    const hit = await lookupCache(dir, key);
    expect(hit?.data).toEqual(PNG);
    expect(hit?.entry.sha256).toBe(digest);
  });

  it("still hits after the original output file is deleted", async () => {
    // The blob is the cache. Deleting what the user was given must not lose it.
    const image = join(dir, "gone.png");
    await writeFile(image, PNG);
    const key = cacheKey(BASE);
    await store(key, PNG, image);
    await rm(image);
    expect((await lookupCache(dir, key))?.data).toEqual(PNG);
  });

  it("is unaffected by edits to the original output file", async () => {
    const image = join(dir, "edited.png");
    const key = cacheKey(BASE);
    await store(key, PNG, image);
    await writeFile(image, "a completely different thing");
    expect((await lookupCache(dir, key))?.data).toEqual(PNG);
  });

  it("misses for an unknown key", async () => {
    expect(await lookupCache(dir, "0".repeat(64))).toBeUndefined();
  });

  it("survives a corrupted index entry", async () => {
    const key = cacheKey(BASE);
    await mkdir(join(dir, "cache"), { recursive: true });
    await writeFile(join(dir, "cache", `${key}.json`), "{{{");
    expect(await lookupCache(dir, key)).toBeUndefined();
  });

  it("rejects an index entry with no usable digest", async () => {
    const key = cacheKey(BASE);
    await mkdir(join(dir, "cache"), { recursive: true });
    await writeFile(join(dir, "cache", `${key}.json`), JSON.stringify({ sha256: "nope" }));
    expect(await lookupCache(dir, key)).toBeUndefined();
  });

  it("treats a corrupted blob as a miss and prunes the entry", async () => {
    const key = cacheKey(BASE);
    await store(key);
    // Simulate bit rot or a truncated write from an older build.
    await writeFile(join(dir, "blobs", digest.slice(0, 2), digest.slice(2)), "corrupt");
    expect(await lookupCache(dir, key)).toBeUndefined();
    // The entry is gone, so the next run regenerates instead of re-reading bad bytes.
    await expect(readFile(join(dir, "cache", `${key}.json`))).rejects.toThrow();
  });

  it("stores the same bytes twice without failing", async () => {
    const key = cacheKey(BASE);
    await store(key);
    await expect(store(cacheKey({ ...BASE, prompt: "another" }))).resolves.toBeUndefined();
    expect((await lookupCache(dir, key))?.data).toEqual(PNG);
  });

  it("round-trips the provenance a later manifest needs", async () => {
    const key = cacheKey(BASE);
    await storeCache(
      dir,
      key,
      { path: join(dir, "a.png"), bytes: PNG.length, format: "png", sha256: digest },
      PNG,
      { model: "model-a", backend: "codex-exec", effectivePrompt: "a fox, rendered" },
    );
    const entry = (await lookupCache(dir, key))!.entry;
    expect(entry.model).toBe("model-a");
    expect(entry.backend).toBe("codex-exec");
    expect(entry.effectivePrompt).toBe("a fox, rendered");
  });

  it("redacts a secret pasted into the prompt before it reaches the cache file", async () => {
    // The prompt is user text and the cache entry is a long-lived file under
    // ~/.local/state. Nothing else redacts it: the logger never sees this file and
    // the manifest writer guards a different one.
    const key = cacheKey(BASE);
    await storeCache(
      dir,
      key,
      { path: join(dir, "a.png"), bytes: PNG.length, format: "png", sha256: digest },
      PNG,
      {
        model: "model-a",
        backend: "codex-http",
        effectivePrompt: "diagram this config: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      },
    );
    // Assert on the FILE, not on the parsed entry. The bytes on disk are what leaks.
    const onDisk = await readFile(join(dir, "cache", `${key}.json`), "utf8");
    expect(onDisk).not.toContain("abcdefghijklmnop");
    expect(onDisk).toContain("[REDACTED]");
    expect(onDisk).toContain("diagram this config");
  });

  it("still loads an entry written before provenance existed", async () => {
    const key = cacheKey(BASE);
    await store(key);
    const entry = (await lookupCache(dir, key))!.entry;
    // An older cache is a hit with an incomplete record, never a corruption.
    expect(entry.model).toBeUndefined();
    expect(entry.sha256).toBe(digest);
  });
});

describe("materialiseFromCache", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]);

  it("writes the hit to the destination this run asked for", async () => {
    const key = cacheKey(BASE);
    await storeCache(
      dir,
      key,
      {
        path: join(dir, "first.png"),
        bytes: PNG.length,
        format: "png",
        sha256: createHash("sha256").update(PNG).digest("hex"),
      },
      PNG,
    );
    const hit = (await lookupCache(dir, key))!;
    const artifact = await materialiseFromCache(hit, join(dir, "second.png"));
    expect(artifact.path).toBe(join(dir, "second.png"));
    expect(await readFile(artifact.path)).toEqual(PNG);
  });

  it("obeys the no-clobber rule on a hit", async () => {
    const key = cacheKey(BASE);
    await storeCache(
      dir,
      key,
      {
        path: join(dir, "a.png"),
        bytes: PNG.length,
        format: "png",
        sha256: createHash("sha256").update(PNG).digest("hex"),
      },
      PNG,
    );
    const target = join(dir, "taken.png");
    await writeFile(target, "existing", "utf8");
    const hit = (await lookupCache(dir, key))!;
    const artifact = await materialiseFromCache(hit, target);
    expect(artifact.path).toBe(join(dir, "taken-v2.png"));
    expect(await readFile(target, "utf8")).toBe("existing");
  });
});

describe("cacheKey with a style", () => {
  const base = { prompt: "a fox", size: "1024x1024" } as const;

  it("changes when a style text field changes", () => {
    const a = cacheKey({ ...base, style: { palette: "navy" } });
    const b = cacheKey({ ...base, style: { palette: "amber" } });
    expect(a).not.toBe(b);
  });

  it("differs from the same prompt with no style", () => {
    expect(cacheKey({ ...base, style: { palette: "navy" } })).not.toBe(cacheKey(base));
  });

  it("ignores key order inside the style", () => {
    const a = cacheKey({ ...base, style: { palette: "navy", lighting: "soft" } });
    const b = cacheKey({ ...base, style: { lighting: "soft", palette: "navy" } });
    expect(a).toBe(b);
  });

  it("ignores generation defaults on the style, which reach the key as request fields", () => {
    expect(cacheKey({ ...base, style: { size: "512x512" } })).toBe(cacheKey({ ...base, style: {} }));
  });
});
