import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generate } from "../../src/engine/generate.js";
import { silentLogger } from "../../src/core/logger.js";

// This test spends real subscription quota. It must never run unattended.
const live = process.env.SUBPIXEL_LIVE === "1";

describe.runIf(live)("live smoke", () => {
  it("generates a real image through the ChatGPT subscription", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subpixel-live-"));
    const result = await generate(
      { prompt: "a simple flat-style red fox icon on a white background", size: "1024x1024" },
      { outDir: dir, stateDir: join(dir, ".subpixel"), logger: silentLogger },
    );

    expect(result.images).toHaveLength(1);
    expect(result.cached).toBe(false);
    const bytes = await readFile(result.images[0]!.path);
    expect(bytes.subarray(0, 4).toString("hex")).toBe("89504e47");

    // The second run must cost nothing.
    const again = await generate(
      { prompt: "a simple flat-style red fox icon on a white background", size: "1024x1024" },
      { outDir: dir, stateDir: join(dir, ".subpixel"), logger: silentLogger },
    );
    expect(again.cached).toBe(true);
    expect(again.images[0]!.path).toBe(result.images[0]!.path);
  }, 600_000);
});
