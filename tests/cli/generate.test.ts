import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// vi.mock is hoisted, so the fake has to be declared with it, not above it.
const generate = vi.fn();
vi.mock("../../src/engine/generate.js", () => ({ generate }));

const { resolveSharedFields, runGenerate } = await import("../../src/cli/generate.js");
const { loadConfig } = await import("../../src/config/load.js");

describe("spx generate --json", () => {
  it("reports a partial batch through the final CLI emitter", async () => {
    generate.mockResolvedValue({
      images: [
        {
          path: `${process.cwd()}/fox-1.png`,
          bytes: 10,
          format: "png",
          sha256: "a".repeat(64),
        },
      ],
      requested: 3,
      failures: [{ index: 1, kind: "ContentBlocked", message: "refused" }],
      backend: "codex-http",
      model: "gpt-5.6-sol",
      cached: false,
      effectivePrompt: "a red fox",
      elapsedMs: 12,
    });

    const out: string[] = [];
    const previousExitCode = process.exitCode;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await runGenerate("a red fox", { json: true });
    } finally {
      vi.restoreAllMocks();
      process.exitCode = previousExitCode;
    }

    const json = JSON.parse(out.join(""));
    expect(json.ok).toBe(false);
    expect(json.requested).toBe(3);
    expect(json.skipped).toBe(1);
    expect(json.failures).toEqual([{ index: 1, kind: "ContentBlocked", message: "refused" }]);
    expect(json.images[0].relativePath).toBe("fox-1.png");
  });

  it("keeps a credential out of --dry-run output", async () => {
    // Synthetic value, not a real key. --dry-run is the path people reach for when
    // something looks wrong, often with the config that broke it in the prompt, and
    // it is the only remaining path that serializes the prompt on its own.
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    // `generate` is a bare vi.fn, so its call log survives the test above.
    generate.mockClear();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    try {
      await runGenerate(`diagram this config: ${secret}`, { dryRun: true });
    } finally {
      vi.restoreAllMocks();
    }

    const text = out.join("");
    expect(text).not.toContain("sk-proj");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(JSON.parse(text).effectivePrompt).toContain("[REDACTED]");
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects a malformed numeric flag before printing a dry-run plan", async () => {
    // --dry-run exists to validate the plan before quota is spent, so a flag that
    // would abort the real run has to abort the rehearsal too.
    generate.mockClear();
    await expect(runGenerate("a red fox", { dryRun: true, timeout: "soon" })).rejects.toThrow(
      /--timeout/,
    );
    await expect(
      runGenerate("a red fox", { dryRun: true, concurrency: "abc" }),
    ).rejects.toThrow(/--concurrency/);
    await expect(
      runGenerate("a red fox", { dryRun: true, stallTimeout: "0" }),
    ).rejects.toThrow(/--stall-timeout/);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("config precedence", () => {
  it("uses the config outDir when --out-dir is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "subpixel-cli-config-"));
    await writeFile(join(root, "subpixel.config.json"), '{ "outDir": "generated", "format": "webp" }');
    const previous = process.cwd();
    process.chdir(root);
    try {
      const loaded = await loadConfig({ cwd: root, stopAt: root });
      expect(loaded.config.outDir).toBe(join(root, "generated"));
      expect(loaded.config.format).toBe("webp");
    } finally {
      process.chdir(previous);
    }
  });

  it("refuses an -n above the configured budget before generating", async () => {
    const root = await mkdtemp(join(tmpdir(), "subpixel-cli-budget-"));
    await writeFile(join(root, "subpixel.config.json"), '{ "budget": { "maxImagesPerRun": 2 } }');
    const previous = process.cwd();
    process.chdir(root);
    try {
      await expect(runGenerate("a fox", { n: "5" })).rejects.toThrow(/budget\.maxImagesPerRun/);
    } finally {
      process.chdir(previous);
    }
  });

  it("refuses --transparent with --format jpeg", async () => {
    await expect(runGenerate("a fox", { transparent: true, format: "jpeg" })).rejects.toThrow(
      /no alpha channel/,
    );
  });

  it("rejects a malformed --variants before generating", async () => {
    await expect(runGenerate("a fox", { variants: "400,wide" })).rejects.toThrow(/wide/);
  });
});

describe("resolveSharedFields and --transparent", () => {
  it("defaults to png over a format inherited from the config", () => {
    const resolved = resolveSharedFields({ transparent: true }, undefined, { format: "jpeg" } as never);
    expect(resolved.format).toBe("png");
  });

  it("defaults to png over a format inherited from a style", () => {
    const resolved = resolveSharedFields({ transparent: true }, { format: "jpeg" }, {} as never);
    expect(resolved.format).toBe("png");
  });

  it("leaves an inherited webp alone, which carries alpha too", () => {
    const resolved = resolveSharedFields({ transparent: true }, { format: "webp" }, {} as never);
    expect(resolved.format).toBe("webp");
  });

  it("still refuses an explicit --format jpeg", () => {
    expect(() => resolveSharedFields({ transparent: true, format: "jpeg" }, undefined, {} as never)).toThrow(
      /no alpha channel/,
    );
  });
});
