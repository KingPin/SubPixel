import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { manifestPathFor, readManifest, writeManifest } from "../../src/engine/manifest.js";

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
