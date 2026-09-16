import { describe, expect, it } from "vitest";
import { ICON_PACK, buildIco, buildIconPack } from "../../src/engine/icons.js";
import { sniffFormat } from "../../src/engine/output.js";
import { probeDimensions, sharpAvailable } from "../../src/engine/sharpx.js";
import { TINY_PNG_BASE64 } from "../fixtures/tiny.png.js";

const PNG = Buffer.from(TINY_PNG_BASE64, "base64");
const hasSharp = await sharpAvailable();

describe("buildIco", () => {
  it("writes the ICO magic and the image count", () => {
    const ico = buildIco([
      { size: 16, png: PNG },
      { size: 32, png: PNG },
    ]);
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // type: icon
    expect(ico.readUInt16LE(4)).toBe(2); // count
  });

  it("records each entry's size, length, and offset", () => {
    const ico = buildIco([
      { size: 16, png: PNG },
      { size: 48, png: PNG },
    ]);
    expect(ico.readUInt8(6)).toBe(16);
    expect(ico.readUInt32LE(6 + 8)).toBe(PNG.length);
    expect(ico.readUInt32LE(6 + 12)).toBe(6 + 16 * 2);
    // The second entry starts where the first payload ends.
    expect(ico.readUInt32LE(6 + 16 + 12)).toBe(6 + 16 * 2 + PNG.length);
  });

  it("writes 0 for a 256 pixel image, which is how ICO encodes 256", () => {
    const ico = buildIco([{ size: 256, png: PNG }]);
    expect(ico.readUInt8(6)).toBe(0);
  });

  it("stores the payloads verbatim", () => {
    const ico = buildIco([{ size: 16, png: PNG }]);
    expect(ico.subarray(6 + 16)).toEqual(PNG);
  });

  it("refuses an empty pack rather than writing a headerless file", () => {
    expect(() => buildIco([])).toThrow();
  });
});

describe.runIf(hasSharp)("buildIconPack", () => {
  it("produces every declared file at its declared size", async () => {
    const pack = await buildIconPack(PNG);
    for (const spec of ICON_PACK) {
      const file = pack.find((entry) => entry.name === spec.name);
      expect(file, spec.name).toBeDefined();
      expect(await probeDimensions(file!.data)).toEqual({ width: spec.size, height: spec.size });
    }
  });

  it("includes a favicon.ico alongside the PNGs", async () => {
    const pack = await buildIconPack(PNG);
    const ico = pack.find((entry) => entry.name === "favicon.ico");
    expect(ico).toBeDefined();
    expect(ico!.data.readUInt16LE(2)).toBe(1);
  });

  // 16 and 32 appear in both the pack and the ICO, and the ICO now reuses the
  // buffers the pack already rendered instead of resizing the source again. Reusing
  // the WRONG buffer is the way that goes wrong, so compare the bytes a browser
  // would decode against the file of the same size.
  it("packs the same bytes into the ICO that it wrote as PNGs", async () => {
    const pack = await buildIconPack(PNG);
    const ico = pack.find((entry) => entry.name === "favicon.ico")!.data;
    const payload = (index: number): Buffer =>
      ico.subarray(
        ico.readUInt32LE(6 + 16 * index + 12),
        ico.readUInt32LE(6 + 16 * index + 12) + ico.readUInt32LE(6 + 16 * index + 8),
      );

    for (const [index, name] of [
      [0, "favicon-16x16.png"],
      [1, "favicon-32x32.png"],
    ] as const) {
      expect(payload(index), name).toEqual(pack.find((entry) => entry.name === name)!.data);
    }
    // 48 is in no pack file, so it still gets its own resize.
    expect(await probeDimensions(payload(2))).toEqual({ width: 48, height: 48 });
  });

  it("reports a non-square source", async () => {
    const warnings: string[] = [];
    const { resizeTo } = await import("../../src/engine/sharpx.js");
    await buildIconPack(await resizeTo(PNG, 16, 8, "cover", "png"), (message) =>
      warnings.push(message),
    );
    expect(warnings.join(" ")).toMatch(/not square/i);
  });

  // The pack names every file `.png` and the ICO declares PNG payloads. A source in
  // another format must not carry that format into the outputs.
  it.each(["jpeg", "webp"] as const)("writes PNG payloads from a %s source", async (format) => {
    const { convert } = await import("../../src/engine/sharpx.js");
    const pack = await buildIconPack(await convert(PNG, format));

    for (const spec of ICON_PACK) {
      const file = pack.find((entry) => entry.name === spec.name);
      expect(sniffFormat(file!.data), spec.name).toBe("png");
    }

    // Read the first ICO payload back out through its own directory entry, so this
    // checks the bytes a browser would actually decode, not the buffer we passed in.
    const ico = pack.find((entry) => entry.name === "favicon.ico")!.data;
    const length = ico.readUInt32LE(6 + 8);
    const offset = ico.readUInt32LE(6 + 12);
    expect(sniffFormat(ico.subarray(offset, offset + length))).toBe("png");
  });
});
