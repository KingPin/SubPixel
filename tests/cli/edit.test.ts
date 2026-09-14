import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEditRequest } from "../../src/cli/edit.js";
import { ConfigError } from "../../src/core/errors.js";
import { TINY_PNG_BASE64 } from "../fixtures/tiny.png.js";

async function tempImage(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "subpixel-edit-"));
  const path = join(dir, "photo.png");
  await writeFile(path, Buffer.from(TINY_PNG_BASE64, "base64"));
  return path;
}

// The two trailing arguments are the resolved style and the loaded config. Both
// are plain values, so no fixture file is needed.
const noStyle = undefined;
const noConfig = {};

describe("buildEditRequest", () => {
  it("uses the source image as the only reference", async () => {
    const path = await tempImage();
    const request = buildEditRequest(path, "make the sky orange", {}, noStyle, noConfig);
    expect(request.referenceImages).toEqual([path]);
    expect(request.prompt).toContain("make the sky orange");
  });

  it("states that the attached image is the thing being edited", async () => {
    const path = await tempImage();
    const request = buildEditRequest(path, "make the sky orange", {}, noStyle, noConfig);
    expect(request.prompt).toMatch(/attached image/i);
  });

  it("resolves the source path so a relative argument still reaches the loader", () => {
    const request = buildEditRequest("photo.png", "brighter", {}, noStyle, noConfig);
    expect(request.referenceImages?.[0]?.startsWith("/")).toBe(true);
  });

  it("refuses an empty instruction rather than sending a bare image", () => {
    expect(() => buildEditRequest("photo.png", "   ", {}, noStyle, noConfig)).toThrow(ConfigError);
  });

  it("passes the ordinary generation options through", () => {
    const request = buildEditRequest(
      "photo.png",
      "brighter",
      { size: "1024x1024", format: "webp" },
      noStyle,
      noConfig,
    );
    expect(request.size).toBe("1024x1024");
    expect(request.format).toBe("webp");
  });

  it("applies the style's defaults, exactly as generate does", () => {
    const request = buildEditRequest(
      "photo.png",
      "brighter",
      {},
      { size: "1024x1024", format: "webp", palette: "deep navy" },
      noConfig,
    );
    expect(request.size).toBe("1024x1024");
    expect(request.format).toBe("webp");
  });

  it("lets a flag beat the style, the same way generate does", () => {
    const request = buildEditRequest(
      "photo.png",
      "brighter",
      { size: "512x512" },
      { size: "1024x1024" },
      noConfig,
    );
    expect(request.size).toBe("512x512");
  });
});
