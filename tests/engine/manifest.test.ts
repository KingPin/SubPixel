import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MANIFEST_VERSION,
  manifestPathFor,
  readManifest,
  writeManifest,
} from "../../src/engine/manifest.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "subpixel-manifest-"));
});

const ENTRY = {
  prompt: "a red fox",
  effectivePrompt: "a red fox\n\n[Image requirements]\n- ...",
  model: "gpt-5.6-sol",
  backend: "codex-http" as const,
  size: "1024x1024",
  exactSize: undefined,
  cacheKey: "a".repeat(64),
  sha256: "b".repeat(64),
  bytes: 1234,
  format: "png" as const,
};

describe("manifestPathFor", () => {
  it("appends .json to the image path", () => {
    expect(manifestPathFor("/out/fox.png")).toBe("/out/fox.png.json");
  });
});

describe("writeManifest / readManifest", () => {
  it("round-trips", async () => {
    const image = join(dir, "fox.png");
    await writeFile(image, "bytes");
    await writeManifest(image, ENTRY);
    const manifest = await readManifest(image);
    expect(manifest?.prompt).toBe("a red fox");
    expect(manifest?.backend).toBe("codex-http");
    expect(manifest?.generatedAt).toBeTruthy();
  });

  it("writes valid JSON next to the image", async () => {
    const image = join(dir, "fox.png");
    await writeManifest(image, ENTRY);
    const raw = JSON.parse(await readFile(`${image}.json`, "utf8")) as Record<string, unknown>;
    expect(raw.model).toBe("gpt-5.6-sol");
  });

  it("contains no credential material", async () => {
    const image = join(dir, "fox.png");
    await writeManifest(image, {
      ...ENTRY,
      prompt: "Bearer abc123def456ghi789 secret",
    });
    const raw = await readFile(`${image}.json`, "utf8");
    expect(raw).not.toContain("abc123def456");
  });

  it("returns undefined when there is no manifest", async () => {
    expect(await readManifest(join(dir, "absent.png"))).toBeUndefined();
  });
});

describe("the replayable manifest", () => {
  it("stamps the shape version so a replay can tell what was recorded", async () => {
    const image = join(dir, "fox.png");
    await writeManifest(image, ENTRY);
    expect((await readManifest(image))?.manifestVersion).toBe(MANIFEST_VERSION);
  });

  it("stores reference paths relative to the sidecar and resolves them back", async () => {
    await mkdir(join(dir, "images"), { recursive: true });
    await mkdir(join(dir, "refs"), { recursive: true });
    const image = join(dir, "images", "hero.png");
    const reference = join(dir, "refs", "source.png");

    await writeManifest(image, { ...ENTRY, referenceImages: [reference] });

    const raw = JSON.parse(await readFile(`${image}.json`, "utf8")) as { referenceImages: string[] };
    expect(raw.referenceImages).toEqual([join("..", "refs", "source.png")]);
    // And back out absolute, so the replay reads the same file from any directory.
    expect((await readManifest(image))?.referenceImages).toEqual([reference]);
  });

  it("round-trips the requested variant specs, suffix included", async () => {
    const image = join(dir, "hero.png");
    await writeManifest(image, {
      ...ENTRY,
      variantSpecs: [{ width: 400, suffix: "sm" }, { width: 4000 }],
      skippedVariants: [4000],
    });
    expect((await readManifest(image))?.variantSpecs).toEqual([
      { width: 400, suffix: "sm" },
      { width: 4000 },
    ]);
  });

  it("redacts a credential nested inside a style's prompt text", async () => {
    // Synthetic value. Field-by-field redaction of `prompt` alone would publish it:
    // a style is a nested object and its text never passed through the old masks.
    const image = join(dir, "fox.png");
    await writeManifest(image, {
      ...ENTRY,
      style: { subject: "a fox", constraints: "use sk-proj-abcdefghijklmnopqrstuvwxyz0123" },
    });
    const raw = await readFile(`${image}.json`, "utf8");
    expect(raw).not.toContain("abcdefghijklmnop");
    expect(raw).toContain("[REDACTED]");
    // Still a document, not a smear.
    expect(JSON.parse(raw)).toBeTypeOf("object");
  });

  it("rejects valid JSON that is not a manifest", async () => {
    const image = join(dir, "fox.png");
    await writeFile(manifestPathFor(image), JSON.stringify({ hello: "world" }));
    expect(await readManifest(image)).toBeUndefined();
  });

  it("rejects a manifest whose optional field is present with the wrong type", async () => {
    const image = join(dir, "fox.png");
    await writeFile(manifestPathFor(image), JSON.stringify({ ...ENTRY, variantSpecs: "400" }));
    expect(await readManifest(image)).toBeUndefined();
  });

  it("accepts a manifest whose optional fields are simply absent", async () => {
    const image = join(dir, "fox.png");
    await writeFile(manifestPathFor(image), JSON.stringify(ENTRY));
    expect((await readManifest(image))?.prompt).toBe("a red fox");
  });

  // A sidecar travels with the image: out of a pull request, a cache, a colleague.
  // `regen` concatenates its variant suffix into an output path, so these are the
  // values that must never reach `variantPath`.
  it.each([
    ["a suffix that escapes the image directory", { variantSpecs: [{ width: 400, suffix: "../../x" }] }],
    ["a suffix with a path separator", { variantSpecs: [{ width: 400, suffix: "/etc/x" }] }],
    ["an empty suffix, which names the primary image", { variantSpecs: [{ width: 400, suffix: "" }] }],
    ["a fractional width", { variantSpecs: [{ width: 400.5 }] }],
    ["a negative width", { variantSpecs: [{ width: -400 }] }],
  ])("rejects %s", async (_name, overrides) => {
    const image = join(dir, "fox.png");
    await writeFile(manifestPathFor(image), JSON.stringify({ ...ENTRY, ...overrides }));
    expect(await readManifest(image)).toBeUndefined();
  });

  it("accepts a variant spec with a real custom suffix", async () => {
    const image = join(dir, "fox.png");
    await writeFile(
      manifestPathFor(image),
      JSON.stringify({ ...ENTRY, variantSpecs: [{ width: 400, suffix: "@sm" }] }),
    );
    expect((await readManifest(image))?.variantSpecs).toEqual([{ width: 400, suffix: "@sm" }]);
  });

  // `composeStyleBlock` trims every text field. A non-string there used to reach
  // replay and throw a raw TypeError instead of "this sidecar is unusable".
  it.each([
    ["a non-string style field", { subject: 7 }],
    ["an unknown quality", { quality: "ultra" }],
    ["an unknown format", { format: "gif" }],
  ])("rejects a style with %s", async (_name, style) => {
    const image = join(dir, "fox.png");
    await writeFile(manifestPathFor(image), JSON.stringify({ ...ENTRY, style }));
    expect(await readManifest(image)).toBeUndefined();
  });

  it("accepts a style whose fields are all well typed", async () => {
    const image = join(dir, "fox.png");
    const style = { subject: "a fox", quality: "high", format: "webp" };
    await writeFile(manifestPathFor(image), JSON.stringify({ ...ENTRY, style }));
    expect((await readManifest(image))?.style).toEqual(style);
  });

  it("rejects a truncated file rather than replaying half a request", async () => {
    const image = join(dir, "fox.png");
    const full = JSON.stringify(ENTRY, null, 2);
    await writeFile(manifestPathFor(image), full.slice(0, full.length / 2));
    expect(await readManifest(image)).toBeUndefined();
  });

  it("refuses a sidecar slot a stranger took after the destination was chosen", async () => {
    // The gap writeImage cannot cover: the slot was empty when the destination was
    // picked, and something else filled it while the image was being generated.
    const image = join(dir, "fox.png");
    const stranger = '{"notes":"landed mid-run"}';
    await writeFile(manifestPathFor(image), stranger);
    await expect(writeManifest(image, ENTRY)).rejects.toThrow(/--overwrite/);
    expect(await readFile(manifestPathFor(image), "utf8")).toBe(stranger);
  });

  it("replaces its own sidecar without --overwrite", async () => {
    const image = join(dir, "fox.png");
    await writeManifest(image, ENTRY);
    await writeManifest(image, { ...ENTRY, prompt: "a blue fox" });
    expect((await readManifest(image))?.prompt).toBe("a blue fox");
  });

  it("replaces a stranger's sidecar when --overwrite was asked for", async () => {
    const image = join(dir, "fox.png");
    await writeFile(manifestPathFor(image), '{"notes":"landed mid-run"}');
    await writeManifest(image, ENTRY, { overwrite: true });
    expect((await readManifest(image))?.prompt).toBe(ENTRY.prompt);
  });
});
