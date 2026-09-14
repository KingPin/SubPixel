import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../src/core/errors.js";
import { NAMED_SIZES, validateAssetsFile } from "../../src/assets/schema.js";

const SOURCE = "/repo/assets.yml";

const MINIMAL = { assets: [{ id: "hero", prompt: "a dashboard" }] };

describe("validateAssetsFile", () => {
  it("accepts a minimal file", () => {
    const file = validateAssetsFile(MINIMAL, SOURCE);
    expect(file.assets).toHaveLength(1);
    expect(file.assets[0]!.id).toBe("hero");
  });

  it("requires at least one asset", () => {
    expect(() => validateAssetsFile({ assets: [] }, SOURCE)).toThrow(/at least one asset/);
    expect(() => validateAssetsFile({}, SOURCE)).toThrow(ConfigError);
  });

  it("names the position of an asset with no id", () => {
    expect(() => validateAssetsFile({ assets: [{ prompt: "x" }] }, SOURCE)).toThrow(/assets\[0\]/);
  });

  it("requires a prompt", () => {
    expect(() => validateAssetsFile({ assets: [{ id: "hero" }] }, SOURCE)).toThrow(/prompt/);
  });

  it("rejects an empty prompt, which would generate something arbitrary", () => {
    expect(() => validateAssetsFile({ assets: [{ id: "hero", prompt: "  " }] }, SOURCE)).toThrow(
      ConfigError,
    );
  });

  it("names both positions on a duplicate id", () => {
    const input = { assets: [{ id: "hero", prompt: "a" }, { id: "hero", prompt: "b" }] };
    expect(() => validateAssetsFile(input, SOURCE)).toThrow(/assets\[0\].*assets\[1\]/s);
  });

  it("accepts the three named sizes and a literal size", () => {
    for (const name of Object.keys(NAMED_SIZES)) {
      const file = validateAssetsFile({ assets: [{ id: "a", prompt: "p", size: name }] }, SOURCE);
      expect(file.assets[0]!.size).toBe(NAMED_SIZES[name as keyof typeof NAMED_SIZES]);
    }
    const literal = validateAssetsFile({ assets: [{ id: "a", prompt: "p", size: "800x600" }] }, SOURCE);
    expect(literal.assets[0]!.size).toBe("800x600");
  });

  it("rejects a size that is neither a name nor WIDTHxHEIGHT", () => {
    expect(() => validateAssetsFile({ assets: [{ id: "a", prompt: "p", size: "big" }] }, SOURCE)).toThrow(
      /big/,
    );
  });

  it("normalises both variant spellings to the object form", () => {
    const file = validateAssetsFile(
      { assets: [{ id: "a", prompt: "p", variants: [768, { width: 1536, suffix: "@lg" }] }] },
      SOURCE,
    );
    expect(file.assets[0]!.variants).toEqual([{ width: 768 }, { width: 1536, suffix: "@lg" }]);
  });

  it("rejects a variant with no width", () => {
    expect(() =>
      validateAssetsFile({ assets: [{ id: "a", prompt: "p", variants: [{ suffix: "@sm" }] }] }, SOURCE),
    ).toThrow(/width/);
  });

  // An empty suffix names the primary, so the variant overwrites its own source.
  it.each(["", "   "])("rejects the empty suffix %p", (suffix) => {
    expect(() =>
      validateAssetsFile({ assets: [{ id: "a", prompt: "p", variants: [{ width: 8, suffix }] }] }, SOURCE),
    ).toThrow(/suffix/);
  });

  it.each(["../../outside", "sub/thing", "a\\b"])("rejects a path-shaped suffix %p", (suffix) => {
    expect(() =>
      validateAssetsFile({ assets: [{ id: "a", prompt: "p", variants: [{ width: 8, suffix }] }] }, SOURCE),
    ).toThrow(/suffix/);
  });

  it("validates defaults and styles", () => {
    const file = validateAssetsFile(
      {
        defaults: { outDir: "public/images", format: "webp", style: "brand" },
        styles: { brand: { palette: "navy" } },
        assets: [{ id: "a", prompt: "p" }],
      },
      SOURCE,
    );
    expect(file.defaults.format).toBe("webp");
    expect(file.styles.brand?.palette).toBe("navy");
  });

  it("warns about an unknown asset key and keeps going", () => {
    const warn = vi.fn();
    const file = validateAssetsFile(
      { assets: [{ id: "a", prompt: "p", colour: "blue" }] },
      SOURCE,
      warn,
    );
    expect(file.assets).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("colour"));
  });

  it("fails on a wrong type for a known key", () => {
    expect(() => validateAssetsFile({ assets: [{ id: "a", prompt: "p", transparent: "yes" }] }, SOURCE)).toThrow(
      /transparent/,
    );
  });
});
