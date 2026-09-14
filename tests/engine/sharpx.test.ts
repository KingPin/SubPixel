import { describe, expect, it } from "vitest";
import {
  convert,
  loadSharp,
  probeDimensions,
  resizeTo,
  sharpAvailable,
} from "../../src/engine/sharpx.js";
import { sniffFormat } from "../../src/engine/output.js";
import { ConfigError } from "../../src/core/errors.js";
import { tinyPng } from "../fixtures/tiny.png.js";

const PNG = tinyPng();
const hasSharp = await sharpAvailable();

describe("loadSharp", () => {
  it("returns a boolean from sharpAvailable and never throws", async () => {
    expect(typeof (await sharpAvailable())).toBe("boolean");
  });

  it.runIf(!hasSharp)("names the feature and `npm i sharp` when it is absent", async () => {
    const err = await loadSharp("--variants").catch((e: Error) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(String(err)).toContain("--variants");
    expect(String(err)).toContain("npm i sharp");
  });
});

describe("probeDimensions", () => {
  it.runIf(hasSharp)("reads the real pixel dimensions", async () => {
    expect(await probeDimensions(PNG)).toEqual({ width: 8, height: 8 });
  });

  it.runIf(hasSharp)("returns undefined for bytes it cannot decode", async () => {
    expect(await probeDimensions(Buffer.alloc(10))).toBeUndefined();
  });

  it.runIf(!hasSharp)("returns undefined rather than throwing when sharp is absent", async () => {
    expect(await probeDimensions(PNG)).toBeUndefined();
  });
});

describe.runIf(hasSharp)("convert", () => {
  it("re-encodes to webp", async () => {
    expect(sniffFormat(await convert(PNG, "webp"))).toBe("webp");
  });

  it("re-encodes to jpeg", async () => {
    expect(sniffFormat(await convert(PNG, "jpeg"))).toBe("jpeg");
  });

  it("returns the input untouched when the format already matches", async () => {
    expect(await convert(PNG, "png")).toEqual(PNG);
  });
});

describe.runIf(hasSharp)("resizeTo", () => {
  it("covers by cropping", async () => {
    const out = await resizeTo(PNG, 4, 2, "cover");
    expect(await probeDimensions(out)).toEqual({ width: 4, height: 2 });
  });

  it("contains by padding, keeping the whole subject", async () => {
    const out = await resizeTo(PNG, 4, 2, "contain");
    expect(await probeDimensions(out)).toEqual({ width: 4, height: 2 });
  });

  it("returns the requested container, not the source's", async () => {
    const jpeg = await convert(tinyPng(), "jpeg");
    expect(sniffFormat(await resizeTo(jpeg, 16, 16, "cover", "png"))).toBe("png");
    // The unasked case is the one that used to be wrong by default.
    expect(sniffFormat(await resizeTo(jpeg, 16, 16, "cover"))).toBe("jpeg");
  });
});
