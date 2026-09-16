import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigError, OutputError } from "../../src/core/errors.js";
import {
  pathForFormat,
  preflightExactSize,
  resolveOutputPath,
  sha256,
  siblingPath,
  sniffFormat,
  slugify,
  writeImage,
} from "../../src/engine/output.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "subpixel-output-"));
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBP"),
]);

describe("sniffFormat", () => {
  it("recognises PNG", () => {
    expect(sniffFormat(PNG)).toBe("png");
  });

  it("recognises JPEG", () => {
    expect(sniffFormat(JPEG)).toBe("jpeg");
  });

  it("recognises WebP", () => {
    expect(sniffFormat(WEBP)).toBe("webp");
  });

  it("returns undefined for text", () => {
    expect(sniffFormat(Buffer.from("not an image at all"))).toBeUndefined();
  });

  it("returns undefined for an empty buffer", () => {
    expect(sniffFormat(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("slugify", () => {
  it("lowercases and dash-separates", () => {
    expect(slugify("A Red Fox")).toBe("a-red-fox");
  });

  it("strips punctuation and path characters", () => {
    expect(slugify("../../etc/passwd")).toBe("etc-passwd");
  });

  it("caps the length", () => {
    expect(slugify("word ".repeat(40)).length).toBeLessThanOrEqual(40);
  });

  it("falls back for an empty result", () => {
    expect(slugify("!!!")).toBe("image");
  });

  it("handles non-ASCII by dropping it", () => {
    expect(slugify("café ☕ shop")).toBe("caf-shop");
  });
});

describe("resolveOutputPath", () => {
  it("uses an explicit path", () => {
    expect(resolveOutputPath({ outDir: dir, prompt: "x", format: "png", explicit: "/tmp/a.png" })).toBe(
      "/tmp/a.png",
    );
  });

  it("derives a slug-and-hash filename", () => {
    const path = resolveOutputPath({ outDir: dir, prompt: "A Red Fox", format: "png" });
    expect(dirname(path)).toBe(dir);
    expect(path).toMatch(/a-red-fox-[0-9a-f]{8}\.png$/);
  });

  it("stays inside outDir for a hostile prompt", () => {
    const path = resolveOutputPath({ outDir: dir, prompt: "../../etc/passwd", format: "png" });
    expect(dirname(path)).toBe(dir);
  });

  it("derives the same name for the same request twice", () => {
    // The idempotency the cache promises is worthless if the hit lands on a new
    // filename: the output directory grows a duplicate per run and every CI build
    // publishes a different URL for the same picture.
    const a = resolveOutputPath({ outDir: dir, prompt: "a fox", format: "png", key: "k1" });
    const b = resolveOutputPath({ outDir: dir, prompt: "a fox", format: "png", key: "k1" });
    expect(a).toBe(b);
  });

  it("separates two requests that share a prompt", () => {
    const a = resolveOutputPath({ outDir: dir, prompt: "a fox", format: "png", key: "k1" });
    const b = resolveOutputPath({ outDir: dir, prompt: "a fox", format: "png", key: "k2" });
    expect(a).not.toBe(b);
  });

  it("gives distinct paths to successive images", () => {
    const a = resolveOutputPath({ outDir: dir, prompt: "same", format: "png", index: 0 });
    const b = resolveOutputPath({ outDir: dir, prompt: "same", format: "png", index: 1 });
    expect(a).not.toBe(b);
  });

  it("uses the format as the extension", () => {
    expect(resolveOutputPath({ outDir: dir, prompt: "x", format: "webp" }).endsWith(".webp")).toBe(
      true,
    );
  });

  it("keeps a credential out of the generated filename", () => {
    // Synthetic value, not a real key. `slugify` only lowercases and swaps
    // punctuation for dashes, so a key shape survives it whole — and the path is
    // then printed to stdout, pasted into a snippet, and stored as the cache
    // entry's `firstWrittenTo`.
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    const path = resolveOutputPath({
      outDir: dir,
      prompt: `diagram this config: ${secret}`,
      format: "png",
    });
    expect(path).not.toContain("sk-proj");
    expect(path).not.toContain("abcdefghijklmnop");
    expect(path).toContain("redacted");
  });
});

describe("pathForFormat", () => {
  it("leaves a matching extension alone", () => {
    expect(pathForFormat("/a/b.png", "png")).toBe("/a/b.png");
  });

  it("accepts both jpg and jpeg for JPEG bytes", () => {
    expect(pathForFormat("/a/b.jpg", "jpeg")).toBe("/a/b.jpg");
    expect(pathForFormat("/a/b.jpeg", "jpeg")).toBe("/a/b.jpeg");
  });

  it("rewrites a lying extension", () => {
    expect(pathForFormat("/a/b.png", "jpeg")).toBe("/a/b.jpg");
  });

  it("appends an extension when there is none", () => {
    expect(pathForFormat("/a/b", "webp")).toBe("/a/b.webp");
  });
});

describe("siblingPath", () => {
  it("produces the spec's -v2 form", () => {
    expect(siblingPath("/a/hero.png", 2)).toBe("/a/hero-v2.png");
  });

  it("increments instead of stacking", () => {
    expect(siblingPath("/a/hero-v2.png", 3)).toBe("/a/hero-v3.png");
  });
});

describe("writeImage", () => {
  it("writes bytes and reports metadata", async () => {
    const target = join(dir, "out.png");
    const artifact = await writeImage(target, PNG);
    expect(artifact.path).toBe(target);
    expect(artifact.bytes).toBe(PNG.length);
    expect(artifact.format).toBe("png");
    expect(artifact.sha256).toBe(sha256(PNG));
    expect(artifact.siblingOf).toBeUndefined();
    expect(await readFile(target)).toEqual(PNG);
  });

  it("refuses to write non-image bytes", async () => {
    await expect(writeImage(join(dir, "bad.png"), Buffer.from("hello"))).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("creates missing directories", async () => {
    const target = join(dir, "a", "b", "out.png");
    await writeImage(target, PNG);
    expect((await readFile(target)).length).toBe(PNG.length);
  });

  it("reports the existing path when the file already holds these bytes", async () => {
    const target = join(dir, "hero.png");
    const first = await writeImage(target, PNG);
    const warnings: string[] = [];
    const again = await writeImage(target, PNG, { warn: (m) => warnings.push(m) });
    expect(again.path).toBe(first.path);
    expect(again.siblingOf).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("does not take a destination whose sidecar slot holds a stranger's file", async () => {
    // The image name is free; the sidecar name is not. `writeManifest` replaces its
    // target unconditionally right after this returns, so taking `hero.png` here
    // would destroy a JSON file nobody passed --overwrite for.
    const stranger = '{"notes":"hand written, not ours"}';
    await writeFile(join(dir, "hero.png.json"), stranger);
    const warnings: string[] = [];
    const artifact = await writeImage(join(dir, "hero.png"), PNG, {
      warn: (m) => warnings.push(m),
    });
    expect(artifact.path).toBe(join(dir, "hero-v2.png"));
    expect(artifact.siblingOf).toBe(join(dir, "hero.png"));
    expect(await readFile(join(dir, "hero.png.json"), "utf8")).toBe(stranger);
    expect(warnings.join(" ")).toContain("hero.png.json");
  });

  it("takes the destination back when the sidecar there is one of ours", async () => {
    // A leftover manifest from an image that was deleted is not a stranger's file.
    // Stepping around it would strand the name forever.
    await writeFile(
      join(dir, "hero.png.json"),
      JSON.stringify({
        prompt: "a fox",
        effectivePrompt: "a fox",
        model: "m",
        backend: "codex-http",
        cacheKey: "k",
        sha256: "0".repeat(64),
        bytes: 9,
        format: "png",
      }),
    );
    const artifact = await writeImage(join(dir, "hero.png"), PNG);
    expect(artifact.path).toBe(join(dir, "hero.png"));
  });

  it("replaces a stranger's sidecar when overwrite was actually asked for", async () => {
    await writeFile(join(dir, "hero.png.json"), '{"notes":"hand written"}');
    const artifact = await writeImage(join(dir, "hero.png"), PNG, { overwrite: true });
    expect(artifact.path).toBe(join(dir, "hero.png"));
  });

  it("writes a -v2 sibling instead of overwriting", async () => {
    const target = join(dir, "hero.png");
    await writeFile(target, "existing", "utf8");
    const warnings: string[] = [];
    const artifact = await writeImage(target, PNG, { warn: (m) => warnings.push(m) });
    expect(artifact.path).toBe(join(dir, "hero-v2.png"));
    expect(artifact.siblingOf).toBe(target);
    expect(await readFile(target, "utf8")).toBe("existing");
    expect(warnings.join(" ")).toContain("hero-v2.png");
  });

  it("walks to -v3 when -v2 is also taken", async () => {
    await writeFile(join(dir, "hero.png"), "a", "utf8");
    await writeFile(join(dir, "hero-v2.png"), "b", "utf8");
    const artifact = await writeImage(join(dir, "hero.png"), PNG);
    expect(artifact.path).toBe(join(dir, "hero-v3.png"));
  });

  it("overwrites only when told to", async () => {
    const target = join(dir, "hero.png");
    await writeFile(target, "existing", "utf8");
    const artifact = await writeImage(target, PNG, { overwrite: true });
    expect(artifact.path).toBe(target);
    expect(await readFile(target)).toEqual(PNG);
  });

  it("names the file from the bytes, not the request, and warns unconditionally", async () => {
    // The caller asked for PNG and passed a .png path; the backend sent JPEG.
    const warnings: string[] = [];
    const artifact = await writeImage(join(dir, "hero.png"), JPEG, {
      requestedFormat: "png",
      warn: (m) => warnings.push(m),
    });
    expect(artifact.path).toBe(join(dir, "hero.jpg"));
    expect(artifact.format).toBe("jpeg");
    expect(artifact.requestedFormat).toBe("png");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("jpeg");
  });

  it("gives up with OutputError when every sibling is taken", async () => {
    await writeFile(join(dir, "x.png"), "a", "utf8");
    await writeFile(join(dir, "x-v2.png"), "b", "utf8");
    await expect(
      writeImage(join(dir, "x.png"), PNG, { maxSiblings: 1 }),
    ).rejects.toBeInstanceOf(OutputError);
  });

  it("lets one of two racing writers win and the other take a sibling", async () => {
    // Different bytes: the loser must not clobber the winner, so it gets a sibling.
    const target = join(dir, "race.png");
    const [a, b] = await Promise.all([
      writeImage(target, PNG),
      writeImage(target, Buffer.concat([PNG, Buffer.from([0x01])])),
    ]);
    expect(new Set([a.path, b.path]).size).toBe(2);
    expect([a.path, b.path]).toContain(target);
    expect(await readFile(target)).toHaveLength(
      a.path === target ? PNG.length : PNG.length + 1,
    );
  });

  it("converges two racing writers of identical bytes on one file", async () => {
    const target = join(dir, "same.png");
    const [a, b] = await Promise.all([writeImage(target, PNG), writeImage(target, PNG)]);
    expect(a.path).toBe(target);
    expect(b.path).toBe(target);
  });
});

describe("preflightExactSize", () => {
  it("accepts an absent value", async () => {
    await expect(preflightExactSize(undefined)).resolves.toBeUndefined();
  });

  it("rejects a malformed size before any network call", async () => {
    await expect(preflightExactSize("huge")).rejects.toBeInstanceOf(ConfigError);
  });
});
