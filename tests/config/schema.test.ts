import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../src/core/errors.js";
import { validateConfig } from "../../src/config/schema.js";
import {
  BACKEND_NAMES,
  IMAGE_BACKGROUNDS,
  IMAGE_FORMATS,
  IMAGE_QUALITIES,
} from "../../src/core/types.js";

const SOURCE = "/repo/subpixel.config.json";

describe("validateConfig", () => {
  it("accepts an empty object", () => {
    expect(validateConfig({}, SOURCE)).toEqual({});
  });

  it("accepts the documented keys", () => {
    const config = validateConfig(
      {
        outDir: "public/images",
        format: "webp",
        style: "brand",
        backend: "codex-http",
        concurrency: 3,
        budget: { maxImagesPerRun: 8 },
        styles: {
          brand: { palette: "deep navy, warm amber", modifiers: "flat vector" },
        },
      },
      SOURCE,
    );
    expect(config.outDir).toBe("public/images");
    expect(config.styles?.brand?.palette).toBe("deep navy, warm amber");
  });

  it("rejects a non-object", () => {
    expect(() => validateConfig([], SOURCE)).toThrow(ConfigError);
    expect(() => validateConfig("brand", SOURCE)).toThrow(ConfigError);
  });

  it("names the key and the file when a type is wrong", () => {
    expect(() => validateConfig({ concurrency: "lots" }, SOURCE)).toThrow(
      /concurrency/,
    );
    expect(() => validateConfig({ concurrency: "lots" }, SOURCE)).toThrow(
      /subpixel\.config\.json/,
    );
  });

  it("rejects a format the engine cannot write", () => {
    expect(() => validateConfig({ format: "gif" }, SOURCE)).toThrow(
      ConfigError,
    );
  });

  it("rejects a concurrency that is not a positive whole number", () => {
    expect(() => validateConfig({ concurrency: 0 }, SOURCE)).toThrow(
      ConfigError,
    );
    expect(() => validateConfig({ concurrency: 1.5 }, SOURCE)).toThrow(
      ConfigError,
    );
  });

  it("warns about an unknown key and keeps going", () => {
    const warn = vi.fn();
    const config = validateConfig(
      { outDir: "img", colour: "blue" },
      SOURCE,
      warn,
    );
    expect(config.outDir).toBe("img");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("colour"));
  });

  it("validates style definitions as string maps", () => {
    expect(() =>
      validateConfig({ styles: { brand: "flat vector" } }, SOURCE),
    ).toThrow(ConfigError);
    expect(() =>
      validateConfig({ styles: { brand: { palette: 7 } } }, SOURCE),
    ).toThrow(/palette/);
  });

  it("carries generation defaults on a style", () => {
    const config = validateConfig(
      {
        styles: { icon: { size: "1024x1024", quality: "high", format: "png" } },
      },
      SOURCE,
    );
    expect(config.styles?.icon?.size).toBe("1024x1024");
  });
  // The point of the core declarations: a value added there must not be one this
  // layer alone rejects. Project config carries the extra "auto" backend, and
  // nothing else of its own.
  it.each(IMAGE_FORMATS)("accepts the core format %s", (format) => {
    expect(validateConfig({ format }, SOURCE).format).toBe(format);
  });

  it.each(IMAGE_QUALITIES)(
    "accepts the core quality %s in a style",
    (quality) => {
      const config = validateConfig({ styles: { s: { quality } } }, SOURCE);
      expect(config.styles?.s?.quality).toBe(quality);
    },
  );

  it.each(IMAGE_BACKGROUNDS)(
    "accepts the core background %s in a style",
    (background) => {
      const config = validateConfig({ styles: { s: { background } } }, SOURCE);
      expect(config.styles?.s?.background).toBe(background);
    },
  );

  it.each(BACKEND_NAMES)("accepts the core backend %s", (backend) => {
    expect(validateConfig({ backend }, SOURCE).backend).toBe(backend);
  });
});
