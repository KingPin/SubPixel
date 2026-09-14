import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runIcons } from "../../src/cli/icons.js";
import { sharpAvailable } from "../../src/engine/sharpx.js";
import { TINY_PNG_BASE64 } from "../fixtures/tiny.png.js";

const hasSharp = await sharpAvailable();

async function fixture(): Promise<{ source: string; outDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "subpixel-icons-"));
  const source = join(dir, "logo.png");
  await writeFile(source, Buffer.from(TINY_PNG_BASE64, "base64"));
  return { source, outDir: join(dir, "icons") };
}

describe.runIf(hasSharp)("runIcons", () => {
  it("writes the whole pack", async () => {
    const { source, outDir } = await fixture();
    await runIcons(source, { outDir });
    expect((await readdir(outDir)).sort()).toEqual([
      "android-chrome-192x192.png",
      "android-chrome-512x512.png",
      "apple-touch-icon.png",
      "favicon-16x16.png",
      "favicon-32x32.png",
      "favicon.ico",
    ]);
  });

  it("writes nothing when a later destination already exists", async () => {
    const { source, outDir } = await fixture();
    await mkdir(outDir, { recursive: true });
    // Last in the pack order, so the old behaviour wrote five PNGs before failing.
    await writeFile(join(outDir, "favicon.ico"), "old");
    await expect(runIcons(source, { outDir })).rejects.toThrow(/--overwrite/);
    expect(await readdir(outDir)).toEqual(["favicon.ico"]);
  });

  it("emits one JSON object listing every path", async () => {
    const { source, outDir } = await fixture();
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runIcons(source, { outDir, json: true });
    const payload = JSON.parse(write.mock.calls.map((call) => String(call[0])).join(""));
    expect(payload.files).toHaveLength(6);
    write.mockRestore();
  });

  it("refuses to clobber an existing pack without --overwrite", async () => {
    const { source, outDir } = await fixture();
    await runIcons(source, { outDir });
    const before = await readFile(join(outDir, "favicon.ico"));
    await writeFile(join(outDir, "favicon.ico"), Buffer.from("stale"));
    await expect(runIcons(source, { outDir })).rejects.toThrow();
    expect(await readFile(join(outDir, "favicon.ico"))).not.toEqual(before);
  });

  it("replaces the pack with --overwrite", async () => {
    const { source, outDir } = await fixture();
    await runIcons(source, { outDir });
    await expect(runIcons(source, { outDir, overwrite: true })).resolves.toBeUndefined();
  });

  it("names the missing file when the source does not exist", async () => {
    await expect(runIcons("/no/such/logo.png", {})).rejects.toThrow(/logo\.png/);
  });
});
