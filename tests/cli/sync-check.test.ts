import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigError, DriftDetected } from "../../src/core/errors.js";
import { exitCodeFor } from "../../src/cli/exit.js";
import { loadAssets } from "../../src/assets/load.js";
import { syncAssets } from "../../src/assets/sync.js";
import { checkAssets, driftError, formatDriftReport, runSync } from "../../src/cli/sync.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

async function project(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "subpixel-check-"));
  await writeFile(join(dir, "assets.yml"), body);
  return join(dir, "assets.yml");
}

const MANIFEST = `
assets:
  - id: hero
    prompt: a dashboard
  - id: icon
    prompt: a glyph
`;

const NEVER = vi.fn(async () => {
  throw new Error("--check must not call a provider");
});

describe("checkAssets", () => {
  // It REPORTS drift; it does not throw on it. The throw is the caller's, after the
  // report has been written. See Step 2.
  it("reports drift when assets are missing", async () => {
    const loaded = await loadAssets(await project(MANIFEST));
    const statuses = await checkAssets(loaded);
    expect(statuses.every((status) => status.state === "missing")).toBe(true);
  });

  it("passes once the assets have been generated", async () => {
    const loaded = await loadAssets(await project(MANIFEST));
    await syncAssets(loaded, {
      provider: async (request) => ({ images: [PNG], model: "gpt-5", effectivePrompt: request.prompt }),
    });
    expect((await checkAssets(loaded)).every((status) => status.state === "current")).toBe(true);
  });
});

describe("driftError", () => {
  it("maps to exit code 6 and names every drifted asset", async () => {
    const loaded = await loadAssets(await project(MANIFEST));
    const err = driftError(await checkAssets(loaded))!;
    expect(err).toBeInstanceOf(DriftDetected);
    expect(exitCodeFor(err)).toBe(6);
    expect(err.message).toContain("hero");
    expect(err.message).toContain("icon");
  });

  it("is undefined when nothing drifted", () => {
    expect(driftError([{ id: "a", out: "/a", state: "current", reason: "", key: "k" }])).toBeUndefined();
  });

  it("redacts a credential that reached a prompt", async () => {
    const loaded = await loadAssets(
      await project("assets:\n  - id: hero\n    prompt: logo for sk-proj-abcdefghijklmnopqrstuvwxyz012345\n"),
    );
    expect(driftError(await checkAssets(loaded))!.message).not.toContain(
      "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
    );
  });
});

describe("runSync --check", () => {
  it("never reaches a provider", async () => {
    const path = await project(MANIFEST);
    await expect(runSync({ file: path, check: true, provider: NEVER })).rejects.toThrow(DriftDetected);
    expect(NEVER).not.toHaveBeenCalled();
  });

  it("refuses --check with --force", async () => {
    const path = await project(MANIFEST);
    await expect(runSync({ file: path, check: true, force: true })).rejects.toThrow(ConfigError);
  });

  it("reports a missing manifest as a config error, not as drift", async () => {
    await expect(runSync({ file: "/no/such/assets.yml", check: true })).rejects.toThrow(ConfigError);
  });

  // stdout, stderr, and exit status in one assertion, on the path that matters:
  // the drifted one. A JSON document that appears only on success is a document a
  // CI job can never use, because success is the case it does not need to inspect.
  it("emits one JSON document AND exits 6 on drift", async () => {
    const path = await project(MANIFEST);
    const out: string[] = [];
    const err: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });

    const caught = await runSync({ file: path, check: true, json: true }).catch((e: unknown) => e);
    stdout.mockRestore();
    stderr.mockRestore();

    expect(exitCodeFor(caught)).toBe(6);
    const documents = out.join("").trim();
    expect(() => JSON.parse(documents)).not.toThrow();
    expect(JSON.parse(documents).drift).toBe(true);
    expect(err.join("")).toContain("hero");
  });

  it("emits one JSON document and exits 0 when nothing drifted", async () => {
    const path = await project(MANIFEST);
    const loaded = await loadAssets(path);
    await syncAssets(loaded, {
      provider: async (request) => ({ images: [PNG], model: "gpt-5", effectivePrompt: request.prompt }),
    });

    const out: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    await runSync({ file: path, check: true, json: true });
    stdout.mockRestore();

    expect(JSON.parse(out.join("").trim()).drift).toBe(false);
  });
});

describe("runSync output contract", () => {
  // README: stdout carries the path of the written file and nothing else. A caller
  // that reads stdout to learn what a run produced cannot tell a progress line from
  // an answer, and under `--json` a progress line on stdout is a second document.
  it("keeps progress off stdout", async () => {
    const path = await project(MANIFEST);
    const out: string[] = [];
    const err: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });

    try {
      await runSync({
        file: path,
        provider: async (request) => ({
          images: [PNG],
          model: "gpt-5",
          effectivePrompt: request.prompt,
        }),
      });
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }

    expect(out.join("")).toBe("");
    expect(err.join("")).toContain("hero");
  });
});

describe("formatDriftReport", () => {
  it("prints one line per drifted asset and nothing for the current ones", () => {
    const report = formatDriftReport([
      { id: "hero", out: "/out/hero.webp", state: "missing", reason: "hero.webp does not exist", key: "k1" },
      { id: "icon", out: "/out/icon.png", state: "current", reason: "", key: "k2" },
    ]);
    expect(report).toContain("hero");
    expect(report).not.toContain("icon");
  });
});

describe("runSync option parsing", () => {
  // Both of these reached `syncAssets` unvalidated: `Number("1.5")` admits two
  // workers while `active < 1.5`, and "auto" is a truthy string no runner answers to.
  it("refuses a fractional --concurrency", async () => {
    await expect(
      runSync({ file: await project(MANIFEST), concurrency: "1.5", provider: NEVER }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(NEVER).not.toHaveBeenCalled();
  });

  it("refuses an unknown --backend", async () => {
    await expect(
      runSync({ file: await project(MANIFEST), backend: "nope", provider: NEVER }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("treats --backend auto as the default chain, not as a named backend", async () => {
    const seen: string[] = [];
    await runSync({
      file: await project(MANIFEST),
      backend: "auto",
      quiet: true,
      provider: async (request) => {
        seen.push(request.prompt);
        return { images: [PNG], model: "gpt-5", effectivePrompt: request.prompt };
      },
    });
    expect(seen).toHaveLength(2);
  });
});
