import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/errors.js";
import { enforceExactSize, sniffFormat } from "../../src/engine/output.js";

let sharpAvailable = true;
try {
  await import("sharp");
} catch {
  sharpAvailable = false;
}

describe.runIf(sharpAvailable)("enforceExactSize with sharp", () => {
  it("cover-crops to the exact requested size", async () => {
    const sharp = (await import("sharp")).default;
    const input = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();

    const output = await enforceExactSize(input, "800x600");
    const meta = await sharp(output).metadata();
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
  });

  it("returns the input unchanged when it is already the right size", async () => {
    const sharp = (await import("sharp")).default;
    const input = await sharp({
      create: { width: 400, height: 300, channels: 3, background: "#000000" },
    })
      .png()
      .toBuffer();
    const output = await enforceExactSize(input, "400x300");
    const meta = await sharp(output).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(300);
  });

  it("re-encodes at this file's quality, not at sharp's default", async () => {
    // `toBuffer()` with no format call re-encodes JPEG and WebP at quality 80, so the
    // crop used to hand back a third fewer bytes than the same crop at 90 -- a silent
    // quality cut on an image the caller has already paid for. Noise, because a flat
    // fill compresses to nothing at either quality and the two would tie.
    const sharp = (await import("sharp")).default;
    const pixels = Buffer.alloc(1024 * 1024 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (Math.sin(i * 0.37) * 127 + 128) | 0;
    const input = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();

    const output = await enforceExactSize(input, "800x600");
    const atSharpsDefault = await sharp(input)
      .resize(800, 600, { fit: "cover", position: "attention" })
      .toBuffer();
    // Still JPEG, asserted here rather than on its own: a test that only checked the
    // format would pass either way, because sharp's default re-encode is JPEG too.
    expect(sniffFormat(output)).toBe("jpeg");
    expect(output.length).toBeGreaterThan(atSharpsDefault.length * 1.15);
  });

  it("rejects a malformed size", async () => {
    await expect(enforceExactSize(Buffer.alloc(10), "huge")).rejects.toBeInstanceOf(ConfigError);
  });
});

describe.runIf(!sharpAvailable)("enforceExactSize without sharp", () => {
  it("explains how to install sharp", async () => {
    const err = await enforceExactSize(Buffer.alloc(10), "800x600").catch((e: Error) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(String(err)).toContain("npm i sharp");
  });
});
