import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/errors.js";
import {
  augmentPrompt,
  buildImageToolParams,
  composeStyleBlock,
  describeAspect,
  parseSize,
} from "../../src/engine/prompt.js";
import type { StyleDefinition } from "../../src/core/types.js";

describe("parseSize", () => {
  it("parses WxH", () => {
    expect(parseSize("1024x1536")).toEqual({ width: 1024, height: 1536 });
  });

  it("accepts an uppercase X", () => {
    expect(parseSize("512X512")).toEqual({ width: 512, height: 512 });
  });

  it("rejects a malformed string", () => {
    expect(() => parseSize("big")).toThrow(ConfigError);
    expect(() => parseSize("1024x")).toThrow(ConfigError);
    expect(() => parseSize("0x100")).toThrow(ConfigError);
  });
});

describe("describeAspect", () => {
  it("names square", () => {
    expect(describeAspect("1024x1024")).toBe("1:1 square");
  });

  it("names portrait", () => {
    expect(describeAspect("1024x1536")).toBe("2:3 portrait");
  });

  it("names landscape", () => {
    expect(describeAspect("1536x1024")).toBe("3:2 landscape");
  });

  it("falls back to the raw ratio for unusual sizes", () => {
    expect(describeAspect("1000x300")).toContain("10:3");
  });
});

describe("augmentPrompt", () => {
  it("mirrors the aspect ratio into the prompt", () => {
    const out = augmentPrompt("a red fox", { size: "1024x1536" });
    expect(out).toContain("a red fox");
    expect(out).toContain("2:3 portrait");
    expect(out).toContain("1024x1536");
  });

  it("mirrors a transparent background", () => {
    const out = augmentPrompt("a logo", { size: "1024x1024", background: "transparent" });
    expect(out.toLowerCase()).toContain("transparent");
  });

  it("mirrors high quality", () => {
    const out = augmentPrompt("a scene", { size: "1024x1024", quality: "high" });
    expect(out.toLowerCase()).toContain("high detail");
  });

  it("appends nothing when everything is default", () => {
    expect(augmentPrompt("plain", {})).toBe("plain");
  });

  it("is idempotent", () => {
    const once = augmentPrompt("a fox", { size: "1024x1536" });
    expect(augmentPrompt(once, { size: "1024x1536" })).toBe(once);
  });

  it("leaves the user prompt first", () => {
    expect(augmentPrompt("MY PROMPT", { size: "1024x1024" }).startsWith("MY PROMPT")).toBe(true);
  });
});

describe("buildImageToolParams", () => {
  it("sends size, quality, and background when given", () => {
    expect(
      buildImageToolParams({
        prompt: "x",
        size: "1024x1536",
        quality: "high",
        background: "transparent",
      }),
    ).toEqual({
      type: "image_generation",
      size: "1024x1536",
      quality: "high",
      background: "transparent",
      output_format: "png",
    });
  });

  it("omits unset parameters rather than sending nulls", () => {
    expect(buildImageToolParams({ prompt: "x" })).toEqual({
      type: "image_generation",
      output_format: "png",
    });
  });

  it("honours an explicit output format", () => {
    expect(buildImageToolParams({ prompt: "x", format: "webp" }).output_format).toBe("webp");
  });
});

describe("composeStyleBlock", () => {
  it("returns an empty string for a style with no text", () => {
    expect(composeStyleBlock({})).toBe("");
    expect(composeStyleBlock({ size: "1024x1024", quality: "high" })).toBe("");
  });

  it("emits only the fields that are set, in a fixed order", () => {
    const style: StyleDefinition = { palette: "deep navy", subject: "a single object" };
    expect(composeStyleBlock(style)).toBe("- Subject: a single object\n- Palette: deep navy");
  });

  it("renders negative as an avoid line", () => {
    expect(composeStyleBlock({ negative: "text, watermarks" })).toBe("- Avoid: text, watermarks");
  });

  it("keeps the order stable regardless of key order in the object", () => {
    const a = composeStyleBlock({ lighting: "soft", subject: "a fox" });
    const b = composeStyleBlock({ subject: "a fox", lighting: "soft" });
    expect(a).toBe(b);
  });
});

describe("augmentPrompt with a style", () => {
  const style: StyleDefinition = { style: "flat vector", negative: "gradients" };

  it("puts the style block before the image requirements", () => {
    const result = augmentPrompt("a fox", { style, size: "1024x1024" });
    expect(result.indexOf("[Style]")).toBeGreaterThan(result.indexOf("a fox"));
    expect(result.indexOf("[Style]")).toBeLessThan(result.indexOf("[Image requirements]"));
    expect(result).toContain("- Style: flat vector");
    expect(result).toContain("- Avoid: gradients");
  });

  it("adds a style block with no size, quality, or background set", () => {
    const result = augmentPrompt("a fox", { style });
    expect(result).toContain("[Style]");
    expect(result).not.toContain("[Image requirements]");
  });

  it("is idempotent", () => {
    const once = augmentPrompt("a fox", { style, size: "1024x1024" });
    expect(augmentPrompt(once, { style, size: "1024x1024" })).toBe(once);
  });

  it("adds nothing for a style that only carries generation defaults", () => {
    expect(augmentPrompt("a fox", { style: { format: "webp" } })).toBe("a fox");
  });

  it("asks for a flat magenta background when transparent is set", () => {
    const result = augmentPrompt("a fox", { transparent: true });
    expect(result).toContain("#FF00FF");
    expect(result).toContain("no shadow cast onto the background");
  });

  it("prefers the chroma instruction over the plain transparent-background hint", () => {
    const result = augmentPrompt("a fox", { transparent: true, background: "transparent" });
    expect(result).toContain("#FF00FF");
    expect(result).not.toContain("Place the subject on an empty");
  });
});
