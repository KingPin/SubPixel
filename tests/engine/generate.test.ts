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
import { generate } from "../../src/engine/generate.js";
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
    expect((await readdir(join(stateDir, "cache"))).length).toBe(1);
  });

  it("serves a repeat request from cache without calling the backend", async () => {
    const provider = vi.fn(okProvider);
    await generate({ prompt: "a fox" }, deps(provider));
    const second = await generate({ prompt: "a fox" }, deps(provider));
    expect(provider).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
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

    // Same prompt, same destination, no overwrite: writeImage picks a sibling.
    const hit = await generate({ prompt: "a fox", outputPath: target }, deps(provider));
    expect(hit.images[0]!.path).not.toBe(target);
    await expect(readFile(`${hit.images[0]!.path}.json`, "utf8")).resolves.toContain("model-a");
  });

  it("does not perform a second lookup when there is no exact size", async () => {
    // Without --exact-size the raw key IS the full key, so a second lookup would be
    // a guaranteed second miss on every cold request.
    const provider = vi.fn(okProvider);
    const result = await generate({ prompt: "a fox" }, deps(provider));
    expect(result.cached).toBe(false);
    expect((await readdir(join(stateDir, "cache"))).length).toBe(1);
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
});
