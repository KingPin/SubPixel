import { describe, expect, it } from "vitest";
import { CHROMA_KEY_HEX, chromaKey } from "../../src/engine/chroma.js";
import { sharpAvailable } from "../../src/engine/sharpx.js";

const hasSharp = await sharpAvailable();

/** Build a raw RGB image and encode it as PNG for the function under test. */
async function png(pixels: Array<[number, number, number]>, width: number): Promise<Buffer> {
  const { default: sharp } = (await import("sharp")) as { default: typeof import("sharp") };
  const data = Buffer.from(pixels.flat());
  return sharp(data, { raw: { width, height: pixels.length / width, channels: 3 } })
    .png()
    .toBuffer();
}

async function pixels(data: Buffer): Promise<number[][]> {
  const { default: sharp } = (await import("sharp")) as { default: typeof import("sharp") };
  const { data: raw, info } = await sharp(data)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out: number[][] = [];
  for (let i = 0; i < raw.length; i += info.channels) {
    out.push(Array.from(raw.subarray(i, i + info.channels)));
  }
  return out;
}

describe.runIf(hasSharp)("chromaKey", () => {
  it("uses magenta as the key colour", () => {
    expect(CHROMA_KEY_HEX).toBe("#FF00FF");
  });

  it("makes an exactly-key pixel fully transparent", async () => {
    const out = await chromaKey(
      await png(
        [
          [255, 0, 255],
          [10, 20, 30],
        ],
        2,
      ),
      {},
    );
    const [keyed, kept] = await pixels(out);
    expect(keyed![3]).toBe(0);
    expect(kept![3]).toBe(255);
  });

  it("keeps a pixel far from the key fully opaque", async () => {
    const out = await chromaKey(await png([[0, 128, 0]], 1), {});
    expect((await pixels(out))[0]![3]).toBe(255);
  });

  it("gives a near-key pixel a partial alpha", async () => {
    // Inside tolerance+softness, outside tolerance.
    const out = await chromaKey(await png([[230, 40, 230]], 1), { tolerance: 20, softness: 120 });
    const alpha = (await pixels(out))[0]![3]!;
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(255);
  });

  it("suppresses magenta spill on an edge pixel", async () => {
    // An anti-aliased boundary pixel: close enough to the key to be in the fade
    // band (distance ~125 against the default band of 60..150), red and blue lifted
    // above green. This is what spill actually looks like.
    const out = await chromaKey(await png([[230, 120, 230]], 1), {});
    const [r, g, b] = (await pixels(out))[0]!;
    expect(r).toBeLessThan(230);
    expect(b).toBeLessThan(230);
    expect(g).toBe(120);
  });

  it("leaves a pixel with no spill alone", async () => {
    const out = await chromaKey(await png([[10, 200, 10]], 1), {});
    expect((await pixels(out))[0]!.slice(0, 3)).toEqual([10, 200, 10]);
  });

  // The regression this trio exists for. Each of these is a colour a user might
  // deliberately paint, each satisfies `min(r, b) > g`, and each was turned toward
  // black by suppression that ignored distance from the key.
  it.each([
    [128, 0, 128], // opaque purple: ~180 from the key, further away than a real edge pixel
    [90, 40, 110], // dull violet, ~223
    [110, 60, 130], // muted plum, ~201
  ])("leaves the opaque colour (%i, %i, %i) untouched", async (r, g, b) => {
    const out = await chromaKey(await png([[r, g, b]], 1), {});
    const [outR, outG, outB, alpha] = (await pixels(out))[0]!;
    expect([outR, outG, outB]).toEqual([r, g, b]);
    expect(alpha).toBe(255);
  });

  it("returns a PNG, because the result has an alpha channel", async () => {
    const out = await chromaKey(await png([[255, 0, 255]], 1), {});
    expect(out.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("is idempotent on an already-keyed image", async () => {
    const once = await chromaKey(
      await png(
        [
          [255, 0, 255],
          [10, 20, 30],
        ],
        2,
      ),
      {},
    );
    const twice = await chromaKey(once, {});
    expect(await pixels(twice)).toEqual(await pixels(once));
  });
});
