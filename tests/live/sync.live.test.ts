import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAssets } from "../../src/assets/load.js";
import { syncAssets } from "../../src/assets/sync.js";
import { checkAssets } from "../../src/cli/sync.js";

// This test spends real subscription quota. It must never run unattended.
const live = process.env.SUBPIXEL_LIVE === "1";

describe.runIf(live)("live sync", () => {
  it("generates a declared manifest, then reports no drift", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subpixel-live-sync-"));
    const path = join(dir, "assets.yml");
    await writeFile(
      path,
      `
defaults:
  outDir: images
  size: square
styles:
  flat:
    modifiers: "flat vector illustration, generous whitespace"
assets:
  - id: fox
    prompt: a red fox icon
    style: flat
  - id: leaf
    prompt: a green leaf icon
    style: flat
    variants: [{ width: 64 }]
`,
    );

    const loaded = await loadAssets(path);
    const first = await syncAssets(loaded, { concurrency: 1 });
    expect(first.generated).toEqual(["fox", "leaf"]);
    expect(first.failures).toEqual([]);

    for (const asset of loaded.assets) {
      const bytes = await readFile(asset.out);
      expect(bytes.length).toBeGreaterThan(0);
    }
    // The declared variant is on disk beside its parent.
    expect((await readFile(join(dir, "images", "leaf-64w.png"))).length).toBeGreaterThan(0);

    // The gate now passes, and it spends nothing to say so.
    await expect(checkAssets(loaded)).resolves.toHaveLength(2);

    // A second sync is free: everything is current.
    const second = await syncAssets(loaded, { concurrency: 1 });
    expect(second.generated).toEqual([]);
    expect(second.skipped).toEqual(["fox", "leaf"]);
  }, 900_000);
});
