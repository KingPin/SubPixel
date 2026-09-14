import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/errors.js";
import { MAX_REFERENCE_BYTES, loadReference, loadReferences } from "../../src/engine/references.js";
import { TINY_PNG_BASE64 } from "../fixtures/tiny.png.js";

const PNG = Buffer.from(TINY_PNG_BASE64, "base64");

async function tempFile(name: string, data: Buffer | string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "subpixel-ref-"));
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

describe("loadReference", () => {
  it("reads the bytes, the digest, the format, and a data URL", async () => {
    const path = await tempFile("logo.png", PNG);
    const reference = await loadReference(path);
    expect(reference.format).toBe("png");
    expect(reference.bytes).toBe(PNG.length);
    expect(reference.sha256).toHaveLength(64);
    expect(reference.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(reference.dataUrl.endsWith(TINY_PNG_BASE64)).toBe(true);
  });

  it("hashes the contents, so two names for the same bytes agree", async () => {
    const a = await loadReference(await tempFile("a.png", PNG));
    const b = await loadReference(await tempFile("b.png", PNG));
    expect(a.sha256).toBe(b.sha256);
  });

  it("changes the digest when the contents change", async () => {
    const path = await tempFile("logo.png", PNG);
    const before = await loadReference(path);
    await writeFile(path, Buffer.concat([PNG, Buffer.from([0])]));
    const after = await loadReference(path);
    expect(after.sha256).not.toBe(before.sha256);
  });

  it("names the path when the file is missing", async () => {
    await expect(loadReference("/no/such/logo.png")).rejects.toThrow(ConfigError);
    await expect(loadReference("/no/such/logo.png")).rejects.toThrow(/logo\.png/);
  });

  it("rejects a file that is not an image", async () => {
    const path = await tempFile("notes.txt", "hello");
    await expect(loadReference(path)).rejects.toThrow(/notes\.txt/);
    await expect(loadReference(path)).rejects.toThrow(/PNG, JPEG, or WebP/);
  });

  it("rejects a reference over the per-file cap", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_REFERENCE_BYTES)]);
    const path = await tempFile("huge.png", big);
    await expect(loadReference(path)).rejects.toThrow(/too large/);
  });
});

describe("loadReferences", () => {
  it("returns an empty array for no references", async () => {
    expect(await loadReferences(undefined)).toEqual([]);
    expect(await loadReferences([])).toEqual([]);
  });

  it("preserves the given order", async () => {
    const a = await tempFile("a.png", PNG);
    const b = await tempFile("b.png", Buffer.concat([PNG, Buffer.from([1])]));
    const loaded = await loadReferences([a, b]);
    expect(loaded.map((r) => r.path)).toEqual([a, b]);
  });

  it("rejects when the combined size exceeds the total cap", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_REFERENCE_BYTES - PNG.length - 1)]);
    const paths = [
      await tempFile("1.png", big),
      await tempFile("2.png", big),
      await tempFile("3.png", big),
      await tempFile("4.png", big),
      await tempFile("5.png", big),
    ];
    await expect(loadReferences(paths)).rejects.toThrow(/combined/);
  });
});
