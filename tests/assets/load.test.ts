import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/errors.js";
import { loadAssets } from "../../src/assets/load.js";

async function manifest(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "subpixel-assets-"));
  const path = join(dir, "assets.yml");
  await writeFile(path, body);
  return path;
}

describe("loadAssets", () => {
  it("resolves out against the manifest directory", async () => {
    const path = await manifest(`
defaults:
  outDir: public/images
  format: webp
assets:
  - id: hero
    prompt: a dashboard
`);
    const loaded = await loadAssets(path);
    expect(loaded.assets[0]!.out).toBe(join(path, "..", "public", "images", "hero.webp"));
  });

  it("prefers an explicit out", async () => {
    const path = await manifest(`
assets:
  - id: hero
    prompt: a dashboard
    out: img/hero.png
`);
    const loaded = await loadAssets(path);
    expect(loaded.assets[0]!.out).toBe(join(path, "..", "img", "hero.png"));
  });

  it("refuses an out that escapes the manifest directory", async () => {
    const path = await manifest(`
assets:
  - id: hero
    prompt: a dashboard
    out: ../../etc/hero.png
`);
    await expect(loadAssets(path)).rejects.toThrow(/outside/);
  });

  it("builds a request with the defaults folded in", async () => {
    const path = await manifest(`
defaults:
  size: landscape
  quality: high
  style: brand
styles:
  brand:
    palette: navy
assets:
  - id: hero
    prompt: a dashboard
  - id: icon
    prompt: a glyph
    size: square
    style: brand
`);
    const loaded = await loadAssets(path);
    expect(loaded.assets[0]!.request.size).toBe("1536x1024");
    expect(loaded.assets[0]!.request.quality).toBe("high");
    expect(loaded.assets[0]!.request.style?.palette).toBe("navy");
    expect(loaded.assets[1]!.request.size).toBe("1024x1024");
  });

  it("names an unknown style rather than generating without it", async () => {
    const path = await manifest(`
assets:
  - id: hero
    prompt: a dashboard
    style: missing
`);
    await expect(loadAssets(path)).rejects.toThrow(/missing/);
  });

  it("keeps file order", async () => {
    const path = await manifest(`
assets:
  - id: b
    prompt: second
  - id: a
    prompt: first
`);
    const loaded = await loadAssets(path);
    expect(loaded.assets.map((asset) => asset.id)).toEqual(["b", "a"]);
  });

  it("reports malformed YAML with the file name", async () => {
    const path = await manifest("assets:\n  - id: hero\n   prompt: bad indent\n");
    await expect(loadAssets(path)).rejects.toThrow(ConfigError);
    await expect(loadAssets(path)).rejects.toThrow(/assets\.yml/);
  });

  it("reports a missing manifest with the path it looked for", async () => {
    await expect(loadAssets("/no/such/assets.yml")).rejects.toThrow(/assets\.yml/);
  });

  it("takes size, quality, format, and background from the style", async () => {
    const path = await manifest(`
styles:
  brand:
    palette: navy
    size: 1024x1024
    quality: high
    format: webp
    background: opaque
defaults:
  style: brand
assets:
  - id: hero
    prompt: a dashboard
`);
    const [asset] = (await loadAssets(path)).assets;
    // The NAME comes from the style's format too. Getting the request right and the
    // filename wrong would leave `sync` chasing a file it never writes.
    expect(asset!.out.endsWith("hero.webp")).toBe(true);
    expect(asset!.request.format).toBe("webp");
    expect(asset!.request.size).toBe("1024x1024");
    expect(asset!.request.quality).toBe("high");
    expect(asset!.request.background).toBe("opaque");
  });

  it("lets the asset and defaults beat the style", async () => {
    const path = await manifest(`
styles:
  brand:
    palette: navy
    size: 1024x1024
    quality: high
defaults:
  style: brand
  quality: low
assets:
  - id: hero
    prompt: a dashboard
    size: 512x512
`);
    const [asset] = (await loadAssets(path)).assets;
    expect(asset!.request.size).toBe("512x512");
    expect(asset!.request.quality).toBe("low");
  });

  it("carries the variant suffix into the request", async () => {
    const path = await manifest(`
assets:
  - id: hero
    prompt: a dashboard
    variants:
      - width: 768
        suffix: "@sm"
`);
    const [asset] = (await loadAssets(path)).assets;
    expect(asset!.request.variants).toEqual([{ width: 768, suffix: "@sm" }]);
  });

  it("refuses two assets that write the same file", async () => {
    const path = await manifest(`
assets:
  - id: hero
    prompt: one
    out: shared.png
  - id: banner
    prompt: two
    out: shared.png
`);
    await expect(loadAssets(path)).rejects.toThrow(ConfigError);
    await expect(loadAssets(path)).rejects.toThrow(/hero/);
    await expect(loadAssets(path)).rejects.toThrow(/banner/);
  });

  it("refuses a variant that lands on another asset's primary", async () => {
    const path = await manifest(`
assets:
  - id: hero
    prompt: one
    variants: [800]
  - id: hero-800w
    prompt: two
`);
    await expect(loadAssets(path)).rejects.toThrow(/hero-800w/);
  });
});
