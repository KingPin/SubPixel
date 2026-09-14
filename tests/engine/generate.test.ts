import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  ContentBlocked,
  ModelRejected,
  ModelUnavailable,
} from "../../src/core/errors.js";
import { emit } from "../../src/engine/emit.js";
import { generate, rawCacheKey } from "../../src/engine/generate.js";
import { cacheKey } from "../../src/engine/cache.js";
import { sharpAvailable } from "../../src/engine/sharpx.js";
import { tinyPng } from "../fixtures/tiny.png.js";
import { silentLogger } from "../../src/core/logger.js";

let dir: string;
let stateDir: string;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

let sharpAvailable = true;
try {
  await import("sharp");
} catch {
  sharpAvailable = false;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "subpixel-generate-"));
  stateDir = join(dir, ".subpixel");
});

function deps(provider: unknown, extra: Record<string, unknown> = {}) {
  return {
    outDir: dir,
    stateDir,
    logger: silentLogger,
    resolveModelFn: async () => ({
      slug: "model-a",
      source: "cache" as const,
      candidates: [
        { slug: "model-a", visibility: "list", priority: 1 },
        { slug: "model-b", visibility: "list", priority: 2 },
      ],
    }),
    provider: provider as never,
    ...extra,
  };
}

const okProvider = async () => ({
  images: [PNG],
  model: "model-a",
  effectivePrompt: "a fox",
});

describe("generate", () => {
  it("writes an image, a manifest, and a cache entry", async () => {
    const result = await generate({ prompt: "a fox" }, deps(okProvider));
    expect(result.cached).toBe(false);
    expect(result.images).toHaveLength(1);
    expect((await readFile(result.images[0]!.path)).length).toBe(PNG.length);
    const manifest = JSON.parse(
      await readFile(`${result.images[0]!.path}.json`, "utf8"),
    ) as Record<string, unknown>;
    expect(manifest.model).toBe("model-a");
    // Two entries: the raw bank and the finished result. They live in different key
    // namespaces on purpose, so the unprocessed bytes can never be served as a
    // finished image.
    expect((await readdir(join(stateDir, "cache"))).length).toBe(2);
  });

  it("serves a repeat request from cache without calling the backend", async () => {
    const provider = vi.fn(okProvider);
    await generate({ prompt: "a fox" }, deps(provider));
    const second = await generate({ prompt: "a fox" }, deps(provider));
    expect(provider).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
  });

  it("re-materialises a cache hit onto the same derived path", async () => {
    // Without an --output the name is derived, and a derived name that moves per
    // run makes the cache saving invisible: every repeat run leaves another
    // identical copy in the output directory under a new name.
    const provider = vi.fn(okProvider);
    const first = await generate({ prompt: "a fox" }, deps(provider));
    const again = await generate({ prompt: "a fox" }, deps(provider));
    expect(again.cached).toBe(true);
    expect(again.images[0]!.path).toBe(first.images[0]!.path);
    expect((await readdir(dir)).filter((name) => name.endsWith(".png"))).toHaveLength(1);
  });

  it("writes a manifest with real provenance beside a cache hit at a new destination", async () => {
    const provider = vi.fn(okProvider);
    await generate({ prompt: "a fox", outputPath: join(dir, "first.png") }, deps(provider));

    const target = join(dir, "second.png");
    const hit = await generate({ prompt: "a fox", outputPath: target }, deps(provider));

    expect(provider).toHaveBeenCalledTimes(1);
    expect(hit.cached).toBe(true);
    expect(hit.images[0]!.path).toBe(target);

    // The sidecar belongs beside the file that was actually written.
    const manifest = JSON.parse(await readFile(`${target}.json`, "utf8")) as Record<string, unknown>;
    expect(manifest.model).toBe("model-a");
    expect(manifest.backend).toBe("codex-http");
    expect(manifest.effectivePrompt).toBe("a fox");
    // ...and the result says the same thing, not "(cached)".
    expect(hit.model).toBe("model-a");
  });

  it("puts the cache-hit manifest beside the collision sibling, not the requested name", async () => {
    const provider = vi.fn(okProvider);
    const target = join(dir, "taken.png");
    await generate({ prompt: "a fox", outputPath: target }, deps(provider));
    // Someone replaced the file with different content. Re-materialising the hit
    // over it would destroy their bytes, so it has to take a sibling.
    await writeFile(target, Buffer.concat([PNG, Buffer.from([0xff])]));

    const hit = await generate({ prompt: "a fox", outputPath: target }, deps(provider));
    expect(hit.images[0]!.path).not.toBe(target);
    await expect(readFile(`${hit.images[0]!.path}.json`, "utf8")).resolves.toContain("model-a");
  });

  it("never produces a raw key equal to the processed key", () => {
    // The plain request — no exactSize, no format — is the case where the two keys
    // used to coincide, which made the bank of unprocessed bytes a cache hit that
    // served a half-finished image.
    const base = { prompt: "a fox" };
    expect(rawCacheKey(base)).not.toBe(cacheKey(base));
    expect(rawCacheKey({ ...base, exactSize: "40x30" })).not.toBe(
      cacheKey({ ...base, exactSize: "40x30" }),
    );
  });

  it("banks the raw bytes beside the finished result, under its own key", async () => {
    const provider = vi.fn(okProvider);
    const request = { prompt: "a fox" };
    const result = await generate(request, deps(provider));
    expect(result.cached).toBe(false);
    const entries = await readdir(join(stateDir, "cache"));
    expect(entries).toContain(`${rawCacheKey(request)}.json`);
    expect(entries).toContain(`${cacheKey(request)}.json`);
  });

  it("bypasses the lookup with noCache but still stores the result", async () => {
    const provider = vi.fn(okProvider);
    await generate({ prompt: "a fox" }, deps(provider));
    const second = await generate({ prompt: "a fox" }, deps(provider, { noCache: true }));
    expect(provider).toHaveBeenCalledTimes(2);
    expect(second.cached).toBe(false);
  });

  it("issues one call per image when n > 1", async () => {
    const provider = vi.fn(okProvider);
    const result = await generate({ prompt: "a fox", n: 3 }, deps(provider));
    expect(provider).toHaveBeenCalledTimes(3);
    expect(result.images).toHaveLength(3);
    expect(new Set(result.images.map((i) => i.path)).size).toBe(3);
  });

  it("advances to the next model after a ModelUnavailable and retries", async () => {
    const provider = vi
      .fn()
      .mockRejectedValueOnce(new ModelUnavailable("no such model", "model-a"))
      .mockResolvedValueOnce({ images: [PNG], model: "model-b", effectivePrompt: "a fox" });
    const result = await generate({ prompt: "a fox" }, deps(provider));
    expect(provider).toHaveBeenCalledTimes(2);
    expect(result.model).toBe("model-b");
  });

  it("gives up when the last candidate is also unavailable", async () => {
    const provider = vi.fn().mockRejectedValue(new ModelUnavailable("no such model", "model-a"));
    await expect(generate({ prompt: "a fox" }, deps(provider))).rejects.toBeInstanceOf(
      ModelUnavailable,
    );
    // model-a then model-b, then no candidates remain.
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a ModelRejected on another model", async () => {
    // ModelRejected is the unclassified-4xx catch-all. It covers a rejected prompt
    // and a malformed request, so a second model spends a second unit of quota to
    // fail the same way — and if the first attempt was billed, the user pays twice.
    const provider = vi.fn().mockRejectedValue(new ModelRejected("bad request"));
    await expect(generate({ prompt: "a fox" }, deps(provider))).rejects.toBeInstanceOf(
      ModelRejected,
    );
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("propagates a ContentBlocked unchanged and writes no image", async () => {
    const provider = vi.fn().mockRejectedValue(new ContentBlocked("refused"));
    await expect(generate({ prompt: "a fox" }, deps(provider))).rejects.toBeInstanceOf(
      ContentBlocked,
    );
    // `.subpixel` holds the per-key lock directory, so the check is for image files.
    expect((await readdir(dir)).filter((name) => name !== ".subpixel")).toEqual([]);
  });

  it("persists quota telemetry when the backend reports it", async () => {
    const provider = async () => ({
      images: [PNG],
      model: "model-a",
      effectivePrompt: "a fox",
      quota: { planType: "plus", windows: [{ usedPercent: 95, windowMinutes: 300 }] },
    });
    const result = await generate({ prompt: "a fox" }, deps(provider));
    expect(result.images).toHaveLength(1);
    const quota = JSON.parse(await readFile(join(stateDir, "quota.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(quota.planType).toBe("plus");
  });

  it("warns from the cached quota BEFORE calling the backend", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "quota.json"),
      JSON.stringify({ planType: "plus", windows: [{ usedPercent: 97, windowMinutes: 300 }] }),
    );
    const seen: string[] = [];
    const provider = vi.fn(async () => {
      // The warning has to be on the tape by the time the backend runs. That is the
      // whole point: after the call, the user has already paid.
      expect(seen.some((line) => line.startsWith("Before this run"))).toBe(true);
      return { images: [PNG], model: "model-a", effectivePrompt: "a fox" };
    });
    await generate(
      { prompt: "a fox" },
      deps(provider, { warnAlways: (m: string) => seen.push(m) }),
    );
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("says nothing when there is no cached quota reading", async () => {
    const seen: string[] = [];
    await generate(
      { prompt: "a fox" },
      deps(okProvider, { warnAlways: (m: string) => seen.push(m) }),
    );
    expect(seen.filter((line) => line.startsWith("Before this run"))).toEqual([]);
  });

  it("says nothing when the cached quota is below the threshold", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "quota.json"),
      JSON.stringify({ planType: "plus", windows: [{ usedPercent: 12, windowMinutes: 300 }] }),
    );
    const seen: string[] = [];
    await generate(
      { prompt: "a fox" },
      deps(okProvider, { warnAlways: (m: string) => seen.push(m) }),
    );
    expect(seen.filter((line) => line.startsWith("Before this run"))).toEqual([]);
  });

  it("survives a corrupt quota.json instead of failing the run", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "quota.json"), "{ not json");
    const result = await generate({ prompt: "a fox" }, deps(okProvider));
    expect(result.images).toHaveLength(1);
  });

  it("prints no preflight quota warning on a cache hit", async () => {
    await generate({ prompt: "a fox" }, deps(okProvider));
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "quota.json"),
      JSON.stringify({ planType: "plus", windows: [{ usedPercent: 97, windowMinutes: 300 }] }),
    );
    const seen: string[] = [];
    const hit = await generate(
      { prompt: "a fox" },
      deps(okProvider, { warnAlways: (m: string) => seen.push(m) }),
    );
    expect(hit.cached).toBe(true);
    expect(seen.filter((line) => line.startsWith("Before this run"))).toEqual([]);
  });

  it("honours an explicit output path", async () => {
    const target = join(dir, "custom.png");
    const result = await generate({ prompt: "a fox", outputPath: target }, deps(okProvider));
    expect(result.images[0]!.path).toBe(target);
  });

  it("reports the elapsed time", async () => {
    const result = await generate({ prompt: "a fox" }, deps(okProvider));
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("writes a cache hit to the destination this run asked for", async () => {
    const provider = vi.fn(okProvider);
    const first = join(dir, "first.png");
    const second = join(dir, "second.png");
    await generate({ prompt: "a fox", outputPath: first }, deps(provider));
    const hit = await generate({ prompt: "a fox", outputPath: second }, deps(provider));
    expect(provider).toHaveBeenCalledTimes(1);
    expect(hit.cached).toBe(true);
    expect(hit.images[0]!.path).toBe(second);
    expect(await readFile(second)).toEqual(PNG);
  });

  it("rejects a malformed exactSize before calling the backend", async () => {
    const provider = vi.fn(okProvider);
    await expect(
      generate({ prompt: "a fox", exactSize: "enormous" }, deps(provider)),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(provider).not.toHaveBeenCalled();
  });

  it("banks the paid bytes even when the local write fails", async () => {
    // A read-only output directory stands in for a full disk. The generation was
    // paid for; losing it because mkdir failed is the failure this guards.
    const provider = vi.fn(okProvider);
    const readOnly = join(dir, "ro");
    await mkdir(readOnly);
    await chmod(readOnly, 0o500);
    await expect(
      generate({ prompt: "a fox" }, deps(provider, { outDir: readOnly })),
    ).rejects.toThrow();
    await chmod(readOnly, 0o700);
    // The blob survived, so a re-run costs nothing.
    expect((await readdir(join(stateDir, "blobs"))).length).toBeGreaterThan(0);
  });

  it("generates once when two processes race on the same key", async () => {
    const provider = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { images: [PNG], model: "model-a", effectivePrompt: "a fox" };
    });
    const [a, b] = await Promise.all([
      generate({ prompt: "a fox", outputPath: join(dir, "a.png") }, deps(provider)),
      generate({ prompt: "a fox", outputPath: join(dir, "b.png") }, deps(provider)),
    ]);
    // The second caller blocked on the per-key lock, re-checked the cache after
    // acquiring it, and served a hit instead of paying again.
    expect(provider).toHaveBeenCalledTimes(1);
    expect([a.cached, b.cached].sort()).toEqual([false, true]);
    expect(await readFile(join(dir, "a.png"))).toEqual(PNG);
    expect(await readFile(join(dir, "b.png"))).toEqual(PNG);
  });

  it("starts the deadline itself and hands it to the provider", async () => {
    const provider = vi.fn(okProvider);
    await generate({ prompt: "a fox" }, deps(provider, { timeoutMs: 5_000 }));
    const [, options] = provider.mock.calls[0]! as [unknown, { deadline?: { totalMs: number } }];
    expect(options.deadline?.totalMs).toBe(5_000);
  });

  it("writes a sibling instead of overwriting an existing output", async () => {
    const target = join(dir, "taken.png");
    await writeFile(target, "existing", "utf8");
    const result = await generate({ prompt: "a fox", outputPath: target }, deps(okProvider));
    expect(result.images[0]!.path).toBe(join(dir, "taken-v2.png"));
    expect(await readFile(target, "utf8")).toBe("existing");
  });

  it("overwrites when told to", async () => {
    const target = join(dir, "taken.png");
    await writeFile(target, "existing", "utf8");
    const result = await generate(
      { prompt: "a fox", outputPath: target },
      deps(okProvider, { overwrite: true }),
    );
    expect(result.images[0]!.path).toBe(target);
  });
});

// Needs a real decodable image, so it runs only where sharp is installed. The
// recovery branch it covers is the one the raw-bytes bank exists for, so it is
// worth the conditional rather than a fake resize seam in production code.
describe.runIf(sharpAvailable)("recovering banked raw bytes", () => {
  async function realPng(): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    return sharp({ create: { width: 64, height: 64, channels: 3, background: "#336699" } })
      .png()
      .toBuffer();
  }

  it("resizes locally on retry instead of buying the same image twice", async () => {
    const png = await realPng();
    const provider = vi.fn(async () => ({ images: [png], model: "model-a", effectivePrompt: "a fox" }));
    const request = { prompt: "a fox", exactSize: "40x30" };

    // A regular file where a directory has to go. The run is paid for, the raw
    // bytes are banked, and then the publish fails — exactly the window the bank
    // exists to cover.
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    await expect(
      generate({ ...request, outputPath: join(blocker, "out.png") }, deps(provider)),
    ).rejects.toThrow();
    expect(provider).toHaveBeenCalledTimes(1);

    // Full-key miss, raw-key hit: resized from the banked bytes, no second call.
    const second = await generate(request, deps(provider));
    expect(provider).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
    expect(second.model).toBe("model-a");

    const sharp = (await import("sharp")).default;
    const meta = await sharp(await readFile(second.images[0]!.path)).metadata();
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(30);

    // The manifest carries the ORIGINAL provenance, not a placeholder.
    const manifest = JSON.parse(
      await readFile(`${second.images[0]!.path}.json`, "utf8"),
    ) as Record<string, unknown>;
    expect(manifest.model).toBe("model-a");
    expect(manifest.effectivePrompt).toBe("a fox");

    // The resized result is now indexed under the full key, so run three is a
    // plain hit and does not re-run sharp.
    const third = await generate(request, deps(provider));
    expect(provider).toHaveBeenCalledTimes(1);
    expect(third.cached).toBe(true);
  });

  it("still calls the backend when neither key is present", async () => {
    const png = await realPng();
    const provider = vi.fn(async () => ({ images: [png], model: "model-a", effectivePrompt: "a fox" }));
    const result = await generate({ prompt: "something else", exactSize: "40x30" }, deps(provider));
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result.cached).toBe(false);
  });

  it("buys ONCE for two concurrent requests that differ only in --exact-size", async () => {
    // The two full keys differ, so a full-key lock gives each request its own lock,
    // lets both miss the raw bank, and buys the same picture twice. The upstream
    // bytes are shared, so the lock has to be too.
    const png = await realPng();
    const provider = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { images: [png], model: "model-a", effectivePrompt: "a fox" };
    });

    const [small, large] = await Promise.all([
      generate(
        { prompt: "a fox", exactSize: "40x30", outputPath: join(dir, "small.png") },
        deps(provider),
      ),
      generate(
        { prompt: "a fox", exactSize: "80x60", outputPath: join(dir, "large.png") },
        deps(provider),
      ),
    ]);

    expect(provider).toHaveBeenCalledTimes(1);

    // Both get their own size, cropped locally from the one purchase.
    const sharp = (await import("sharp")).default;
    const sizeOf = async (path: string) => {
      const meta = await sharp(await readFile(path)).metadata();
      return `${meta.width}x${meta.height}`;
    };
    expect(await sizeOf(small.images[0]!.path)).toBe("40x30");
    expect(await sizeOf(large.images[0]!.path)).toBe("80x60");
  });
  it("returns the images that succeeded when one of a batch fails", async () => {
    let call = 0;
    const result = await generate(
      { prompt: "a cat", n: 3 },
      deps(
        async () => {
          call += 1;
          if (call === 2) throw new ContentBlocked("refused");
          return { images: [PNG], model: "model-a", effectivePrompt: "a cat" };
        },
        { concurrency: 1 },
      ),
    );
    expect(result.images).toHaveLength(1);
    expect(result.requested).toBe(3);
    expect(result.failures).toHaveLength(1);
    expect(result.failures?.[0]?.kind).toBe("ContentBlocked");
    // The third slot was skipped, not attempted. Quota is not spent after a failure.
    expect(call).toBe(2);
  });

  it("redacts a secret echoed back in a failure message", async () => {
    // The failure message travels to stdout as JSON and to stderr as prose. Neither
    // goes through the logger, so `describeFailure` is the last place that can mask
    // an upstream body that quoted our Authorization header back at us.
    let call = 0;
    const result = await generate(
      { prompt: "a cat", n: 2 },
      deps(
        async () => {
          if (call === 0) {
            call += 1;
            return { images: [PNG], model: "model-a", effectivePrompt: "a cat" };
          }
          throw new ContentBlocked(
            "upstream rejected: Authorization: Bearer abc123def456ghi789jkl",
          );
        },
        { concurrency: 1 },
      ),
    );
    const message = result.failures![0]!.message;
    expect(message).not.toContain("abc123def456");
    expect(message).toContain("[REDACTED]");
    // And it stays masked at the boundary the caller actually reads.
    expect(emit(result, process.cwd(), "json")).not.toContain("abc123def456");
  });

  it("throws the original error when every image fails", async () => {
    await expect(
      generate(
        { prompt: "a cat", n: 2 },
        deps(
          async () => {
            throw new ContentBlocked("refused");
          },
          { concurrency: 1 },
        ),
      ),
    ).rejects.toBeInstanceOf(ContentBlocked);
  });

  it("returns the image when the cache write fails after it was published", async () => {
    // The cache is an optimisation; the image is the product. By the time
    // `storeCache` runs, the file and its manifest are on disk, so an awaited throw
    // here would lose an artifact the user has already paid for. This is reachable
    // by configuration, not just by accident: cache blobs always publish with
    // `overwrite: false`, which needs a hard link, so a state directory on a
    // filesystem without them fails here on every run — and `--overwrite` does not
    // help, because it applies to the image rather than to the blob.
    // No mock: a regular file where the blob directory has to go makes every
    // `atomicPublish` under it fail with ENOTDIR, which is the same shape as the
    // hard-link failure this is about. `lookupCache` swallows read errors, so the
    // run still starts as a clean miss.
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "blobs"), "");

    const warn = vi.fn();
    const result = await generate(
      { prompt: "a fox" },
      deps(okProvider, { overwrite: true, logger: { ...silentLogger, warn } }),
    );

    expect(result.images).toHaveLength(1);
    await expect(readFile(result.images[0]!.path)).resolves.toHaveLength(PNG.length);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be added to the cache"));
  });
});

describe.runIf(await sharpAvailable())("pixel dimensions", () => {
  const realProvider = async () => ({
    images: [tinyPng()],
    model: "model-a",
    effectivePrompt: "a fox",
  });

  it("records them on a freshly generated artifact", async () => {
    const result = await generate({ prompt: "a fox" }, deps(realProvider));
    expect(result.images[0]!.width).toBe(8);
    expect(result.images[0]!.height).toBe(8);
  });

  it("records them on a cache hit too", async () => {
    await generate({ prompt: "a fox" }, deps(realProvider));
    const hit = await generate({ prompt: "a fox" }, deps(realProvider));
    expect(hit.cached).toBe(true);
    expect(hit.images[0]!.width).toBe(8);
  });

  it("converts the primary image to the declared --format", async () => {
    // The backend answers PNG. A declared `webp` is a promise about the FILE, so a
    // .png here would make an assets.yml entry permanently stale.
    const result = await generate({ prompt: "a fox", format: "webp" }, deps(realProvider));
    expect(result.images[0]!.path.endsWith(".webp")).toBe(true);
    expect(result.images[0]!.format).toBe("webp");
  });

  it("keys banked raw bytes on retry, without a second request", async () => {
    // Exactly the failure this guards: run one banks the magenta bytes and dies on
    // the way to disk. Run two must produce a KEYED image, and must not call the
    // backend — the user has already paid for those pixels once.
    const { default: sharp } = (await import("sharp")) as { default: typeof import("sharp") };
    const magenta = await sharp(Buffer.from([255, 0, 255, 255, 0, 255]), {
      raw: { width: 2, height: 1, channels: 3 },
    })
      .png()
      .toBuffer();
    const magentaProvider = async () => ({
      images: [magenta],
      model: "model-a",
      effectivePrompt: "a fox",
    });

    const blocker = join(dir, "chroma-blocker");
    await writeFile(blocker, "not a directory", "utf8");
    await expect(
      generate(
        { prompt: "a fox", transparent: true, outputPath: join(blocker, "out.png") },
        deps(magentaProvider),
      ),
    ).rejects.toThrow();

    const recovered = await generate(
      { prompt: "a fox", transparent: true },
      deps(() => {
        throw new Error("must not call the backend");
      }),
    );
    expect(recovered.cached).toBe(true);
    const { data } = await sharp(await readFile(recovered.images[0]!.path))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0);
  });

  it("re-processes banked raw bytes rather than serving them", async () => {
    // Bank the raw bytes by failing the publish, then ask for the same picture with
    // a local step that must run. A provider that throws proves no second purchase.
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    await expect(
      generate(
        { prompt: "a fox", exactSize: "4x2", outputPath: join(blocker, "out.png") },
        deps(realProvider),
      ),
    ).rejects.toThrow();

    const recovered = await generate(
      { prompt: "a fox", exactSize: "4x2" },
      deps(() => {
        throw new Error("must not call the backend");
      }),
    );
    expect(recovered.cached).toBe(true);
    expect(recovered.images[0]!.width).toBe(4);
    expect(recovered.images[0]!.height).toBe(2);
  });
});
