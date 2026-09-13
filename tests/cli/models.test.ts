import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { collectModelReport, formatModelReport } from "../../src/cli/models.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "subpixel-cli-models-"));
});

const CACHE = {
  fetched_at: new Date().toISOString(),
  models: [
    { slug: "alpha", visibility: "list", priority: 1, supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "beta", visibility: "list", priority: 2, supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "hidden", visibility: "hide", priority: 0, supported_reasoning_levels: [{ effort: "low" }] },
  ],
};

describe("collectModelReport", () => {
  it("lists candidates in resolution order and marks the selection", async () => {
    const path = join(home, "models_cache.json");
    await writeFile(path, JSON.stringify(CACHE));
    const report = await collectModelReport({ cachePath: path });
    expect(report.selected).toBe("alpha");
    expect(report.candidates).toEqual(["alpha", "beta"]);
    expect(report.source).toBe("cache");
  });

  it("reports the bundled source when no cache exists", async () => {
    const report = await collectModelReport({ cachePath: join(home, "nope.json") });
    expect(report.source).toBe("bundled");
    expect(report.candidates.length).toBeGreaterThan(0);
  });

  it("honours an override", async () => {
    const report = await collectModelReport({ override: "pinned", cachePath: join(home, "nope.json") });
    expect(report.selected).toBe("pinned");
    expect(report.source).toBe("override");
  });
});

describe("formatModelReport", () => {
  it("marks the selected model", async () => {
    const path = join(home, "models_cache.json");
    await writeFile(path, JSON.stringify(CACHE));
    const text = formatModelReport(await collectModelReport({ cachePath: path }));
    expect(text).toContain("* alpha");
    expect(text).toContain("  beta");
  });
});
