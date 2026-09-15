import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tinyPng } from "../fixtures/tiny.png.js";

// Same seam `tests/cli/generate.test.ts` uses: the CLI binding is what is under
// test, so the engine is a spy and the assertion is on the request it received.
const generate = vi.fn();
vi.mock("../../src/engine/generate.js", () => ({ generate }));

const { runRegen } = await import("../../src/cli/regen.js");
const { writeManifest, manifestPathFor } = await import("../../src/engine/manifest.js");
const { ConfigError } = await import("../../src/core/errors.js");

let dir: string;

const ENTRY = {
  prompt: "a red fox",
  effectivePrompt: "a red fox\n\n[Image requirements]",
  model: "gpt-5.6-sol",
  backend: "codex-http" as const,
  size: "1024x1024",
  cacheKey: "a".repeat(64),
  sha256: "b".repeat(64),
  bytes: 1234,
  format: "png" as const,
};

function silence(): void {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

function generatedAt(path: string): void {
  generate.mockResolvedValue({
    images: [{ path, bytes: 10, format: "png", sha256: "c".repeat(64) }],
    requested: 1,
    backend: "codex-http",
    model: "gpt-5.6-sol",
    cached: false,
    effectivePrompt: "a red fox",
    elapsedMs: 1,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "subpixel-regen-"));
  generate.mockReset();
});

describe("spx regen", () => {
  it("replays the recorded request, without the cache and over the original", async () => {
    const image = join(dir, "fox.png");
    await writeFile(image, tinyPng());
    await writeManifest(image, { ...ENTRY, quality: "high", background: "opaque" });
    generatedAt(image);

    silence();
    try {
      await runRegen(image, {});
    } finally {
      vi.restoreAllMocks();
    }

    const [request, deps] = generate.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(request.prompt).toBe("a red fox");
    expect(request.size).toBe("1024x1024");
    expect(request.quality).toBe("high");
    expect(request.background).toBe("opaque");
    expect(request.outputPath).toBe(image);
    expect(deps.noCache).toBe(true);
    expect(deps.overwrite).toBe(true);
  });

  it("carries a recorded style into the replay", async () => {
    const image = join(dir, "fox.png");
    await writeFile(image, tinyPng());
    await writeManifest(image, {
      ...ENTRY,
      style: { subject: "a fox", palette: "autumn", negative: "no text" },
    });
    generatedAt(image);

    silence();
    try {
      await runRegen(image, {});
    } finally {
      vi.restoreAllMocks();
    }

    const [request] = generate.mock.calls[0] as [Record<string, unknown>];
    expect(request.style).toEqual({ subject: "a fox", palette: "autumn", negative: "no text" });
  });

  it("replays transparency, so post-processing stays on", async () => {
    const image = join(dir, "fox.png");
    await writeFile(image, tinyPng());
    await writeManifest(image, { ...ENTRY, transparent: true });
    generatedAt(image);

    silence();
    try {
      await runRegen(image, {});
    } finally {
      vi.restoreAllMocks();
    }

    const [request] = generate.mock.calls[0] as [Record<string, unknown>];
    expect(request.transparent).toBe(true);
  });

  it("replays the requested variant specs, suffix and skipped width included", async () => {
    const image = join(dir, "hero.webp");
    await writeFile(image, tinyPng());
    await writeManifest(image, {
      ...ENTRY,
      format: "webp",
      // 400 was written under a custom name; 4000 was refused as an upscale. Only
      // the SPEC list carries either fact.
      variantSpecs: [{ width: 400, suffix: "sm" }, { width: 4000 }],
      variants: [{ width: 400, height: 300, path: join(dir, "hero@sm.webp"), bytes: 99 }],
      skippedVariants: [4000],
    });
    generatedAt(image);

    silence();
    try {
      await runRegen(image, {});
    } finally {
      vi.restoreAllMocks();
    }

    const [request] = generate.mock.calls[0] as [Record<string, unknown>];
    expect(request.variants).toEqual([{ width: 400, suffix: "sm" }, { width: 4000 }]);
  });

  it("resolves reference paths against the sidecar, not the caller's cwd", async () => {
    // The trap: a manifest written in one directory, replayed from another, with a
    // decoy at the same relative path under the replay cwd.
    const project = join(dir, "project");
    await mkdir(join(project, "refs"), { recursive: true });
    await mkdir(join(project, "images", "refs"), { recursive: true });
    const real = join(project, "refs", "source.png");
    await writeFile(real, tinyPng());
    await writeFile(join(project, "images", "refs", "source.png"), tinyPng());

    const image = join(project, "images", "hero.png");
    await writeFile(image, tinyPng());
    await writeManifest(image, { ...ENTRY, referenceImages: [real] });
    generatedAt(image);

    const previous = process.cwd();
    process.chdir(join(project, "images"));
    silence();
    try {
      await runRegen("hero.png", {});
    } finally {
      vi.restoreAllMocks();
      process.chdir(previous);
    }

    const [request] = generate.mock.calls[0] as [{ referenceImages?: string[] }];
    expect(request.referenceImages).toEqual([real]);
  });

  it("exits 2 without a provider call when the manifest is missing", async () => {
    const image = join(dir, "fox.png");
    await writeFile(image, tinyPng());
    await expect(runRegen(image, {})).rejects.toThrow(ConfigError);
    expect(generate).not.toHaveBeenCalled();
  });

  it("exits 2 without a provider call on valid JSON of the wrong shape", async () => {
    const image = join(dir, "fox.png");
    await writeFile(image, tinyPng());
    await writeFile(manifestPathFor(image), JSON.stringify({ hello: "world" }));
    await expect(runRegen(image, {})).rejects.toThrow(ConfigError);
    expect(generate).not.toHaveBeenCalled();
  });

  it("warns once on a v1 manifest and replays what it has", async () => {
    const image = join(dir, "fox.png");
    await writeFile(image, tinyPng());
    // A manifest as M1 wrote them: no manifestVersion, no replayable fields.
    await writeFile(manifestPathFor(image), JSON.stringify(ENTRY, null, 2));
    generatedAt(image);

    const errors: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    try {
      await runRegen(image, {});
    } finally {
      vi.restoreAllMocks();
    }

    expect(errors.join("")).toContain("predates the replayable manifest fields");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("lets a flag override the recorded value", async () => {
    const image = join(dir, "fox.png");
    await writeFile(image, tinyPng());
    await writeManifest(image, ENTRY);
    generatedAt(image);

    const target = join(dir, "other.png");
    silence();
    try {
      await runRegen(image, { size: "512x512", model: "gpt-image-1.5", out: target });
    } finally {
      vi.restoreAllMocks();
    }

    const [request] = generate.mock.calls[0] as [Record<string, unknown>];
    expect(request.size).toBe("512x512");
    expect(request.model).toBe("gpt-image-1.5");
    expect(request.outputPath).toBe(target);
  });
});
