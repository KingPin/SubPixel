import { describe, expect, it } from "vitest";
import { collectStyleReport, formatStyleReport, resolveStyle } from "../../src/cli/styles.js";
import type { SubpixelConfig } from "../../src/config/schema.js";
import { ConfigError } from "../../src/core/errors.js";

const config: SubpixelConfig = {
  styles: {
    brand: { palette: "deep navy, warm amber", style: "flat vector", negative: "gradients" },
    icon: { size: "1024x1024", format: "png", subject: "a single centred glyph" },
  },
};

describe("resolveStyle", () => {
  it("returns undefined when no style is asked for", () => {
    expect(resolveStyle(config, undefined)).toBeUndefined();
  });

  it("returns the named style", () => {
    expect(resolveStyle(config, "brand")?.style).toBe("flat vector");
  });

  it("lists the available styles when the name is wrong", () => {
    expect(() => resolveStyle(config, "brnad")).toThrow(ConfigError);
    expect(() => resolveStyle(config, "brnad")).toThrow(/brand, icon/);
  });

  it("says so when the project defines none", () => {
    expect(() => resolveStyle({}, "brand")).toThrow(/No styles are defined/);
  });
});

describe("collectStyleReport", () => {
  it("lists every style in name order", () => {
    expect(collectStyleReport(config).styles.map((s) => s.name)).toEqual(["brand", "icon"]);
  });

  it("filters to one style", () => {
    expect(collectStyleReport(config, "icon").styles).toHaveLength(1);
  });

  it("throws for an unknown name rather than printing nothing", () => {
    expect(() => collectStyleReport(config, "nope")).toThrow(ConfigError);
  });

  it("separates prompt fields from generation defaults", () => {
    const icon = collectStyleReport(config, "icon").styles[0]!;
    expect(icon.fields).toEqual(["subject"]);
    expect(icon.defaults.size).toBe("1024x1024");
    expect(icon.block).toBe("- Subject: a single centred glyph");
  });

  it("reports an empty project without failing", () => {
    expect(formatStyleReport(collectStyleReport({}))).toMatch(/No styles/);
  });
});
