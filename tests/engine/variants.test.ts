import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../src/core/errors.js";
import { buildVariants, parseVariants, variantPath } from "../../src/engine/variants.js";
import { probeDimensions, resizeTo, sharpAvailable } from "../../src/engine/sharpx.js";
import { TINY_PNG_BASE64 } from "../fixtures/tiny.png.js";

const PNG = Buffer.from(TINY_PNG_BASE64, "base64");
const hasSharp = await sharpAvailable();

describe("parseVariants", () => {
  it("returns undefined for no spec", () => {
    expect(parseVariants(undefined)).toBeUndefined();
  });

  // The return type is a list of SPECS, not a list of numbers. `assets.yml` may
  // give a variant its own suffix, and one shape for both entry points is what
  // stops the suffix being dropped on the way to the filename.
  it("parses a comma separated list", () => {
    expect(parseVariants("400,800,1200")).toEqual([
      { width: 400 },
      { width: 800 },
      { width: 1200 },
    ]);
  });

  it("sorts and de-duplicates", () => {
    expect(parseVariants("800,400,800")).toEqual([{ width: 400 }, { width: 800 }]);
  });

  it("tolerates spaces", () => {
    expect(parseVariants(" 400 , 800 ")).toEqual([{ width: 400 }, { width: 800 }]);
  });

  it("names the bad value", () => {
    expect(() => parseVariants("400,wide")).toThrow(ConfigError);
    expect(() => parseVariants("400,wide")).toThrow(/wide/);
    expect(() => parseVariants("0")).toThrow(/0/);
    expect(() => parseVariants("-100")).toThrow(ConfigError);
  });

  it("rejects an empty list rather than treating it as no variants", () => {
    expect(() => parseVariants("")).toThrow(ConfigError);
    expect(() => parseVariants(",")).toThrow(ConfigError);
  });
});

describe("variantPath", () => {
  it("inserts the width before the extension", () => {
    expect(variantPath("/out/hero.webp", 800)).toBe("/out/hero-800w.webp");
  });

  it("handles a path with no extension", () => {
    expect(variantPath("/out/hero", 800)).toBe("/out/hero-800w");
  });

  it("handles a dotted stem", () => {
    expect(variantPath("/out/hero.v2.png", 400)).toBe("/out/hero.v2-400w.png");
  });

  it("uses an explicit suffix when one is given", () => {
    expect(variantPath("/out/hero.webp", 768, "@sm")).toBe("/out/hero@sm.webp");
  });
});

// Built at module scope: a `describe` callback is not async, so the await cannot
// live inside it. The fixture is a 64x32 image, deliberately wider than tall, so a
// derived height proves the aspect ratio was preserved rather than guessed.
const wide = hasSharp ? await resizeTo(PNG, 64, 32, "cover") : Buffer.alloc(0);

describe.runIf(hasSharp)("buildVariants", () => {

  it("preserves the aspect ratio", async () => {
    const built = await buildVariants(wide, [32], "png");
    expect(await probeDimensions(built[0]!.data)).toEqual({ width: 32, height: 16 });
  });

  it("returns one entry per width, in ascending order", async () => {
    const built = await buildVariants(wide, [16, 32], "png");
    expect(built.map((entry) => entry.width)).toEqual([16, 32]);
  });

  it("skips a width wider than the source and warns", async () => {
    const warn = vi.fn();
    const built = await buildVariants(wide, [32, 128], "png", warn);
    expect(built.map((entry) => entry.width)).toEqual([32]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("128"));
  });

  it("encodes in the requested format", async () => {
    const built = await buildVariants(wide, [32], "webp");
    expect(built[0]!.data.subarray(0, 4).toString("latin1")).toBe("RIFF");
  });

  it("returns nothing when every width is too large", async () => {
    expect(await buildVariants(wide, [512], "png", () => {})).toEqual([]);
  });
});
