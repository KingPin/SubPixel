import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/errors.js";
import { enforceExactSize } from "../../src/engine/output.js";

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
