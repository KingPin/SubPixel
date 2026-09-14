import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuthExpired, ContentBlocked } from "../../src/core/errors.js";
import type { GenerateRequest } from "../../src/core/types.js";
import { syncAssets } from "../../src/assets/sync.js";
import { loadAssets } from "../../src/assets/load.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

async function project(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "subpixel-sync-"));
  await writeFile(join(dir, "assets.yml"), body);
  return join(dir, "assets.yml");
}

/**
 * A provider that hands back a fixed PNG and records the prompts it saw.
 *
 * The shape is `ProviderResult` from `src/providers/codex-http.ts`: `images` is a
 * `Buffer[]`, and `effectivePrompt` is what the engine records in the manifest.
 */
function fakeProvider() {
  const prompts: string[] = [];
  const fn = vi.fn(async (request: GenerateRequest) => {
    prompts.push(request.prompt);
    return { images: [PNG], model: "gpt-5", effectivePrompt: request.prompt };
  });
  return { fn, prompts };
}

const NEVER = vi.fn(async () => {
  throw new Error("the provider must not be called");
});

describe("syncAssets", () => {
  it("generates every asset on a clean tree", async () => {
    const path = await project(`
assets:
  - id: hero
    prompt: a dashboard
  - id: icon
    prompt: a glyph
`);
    const loaded = await loadAssets(path);
    const provider = fakeProvider();
    const outcome = await syncAssets(loaded, { provider: provider.fn });

    expect(outcome.generated).toEqual(["hero", "icon"]);
    expect(outcome.skipped).toEqual([]);
    expect(provider.fn).toHaveBeenCalledTimes(2);
    expect(await readFile(loaded.assets[0]!.out)).toEqual(PNG);
  });

  it("skips an asset that is already current", async () => {
    const path = await project(`
assets:
  - id: hero
    prompt: a dashboard
`);
    const loaded = await loadAssets(path);
    await syncAssets(loaded, { provider: fakeProvider().fn });

    const second = await syncAssets(loaded, { provider: NEVER });
    expect(second.skipped).toEqual(["hero"]);
    expect(second.generated).toEqual([]);
    expect(NEVER).not.toHaveBeenCalled();
  });

  it("regenerates everything under force", async () => {
    const path = await project(`
assets:
  - id: hero
    prompt: a dashboard
`);
    const loaded = await loadAssets(path);
    await syncAssets(loaded, { provider: fakeProvider().fn });

    const provider = fakeProvider();
    const forced = await syncAssets(loaded, { provider: provider.fn, force: true });
    expect(forced.generated).toEqual(["hero"]);
    // The assertion that matters: the provider was actually CALLED. Selecting the
    // asset for processing is not regenerating it — without `noCache`, the engine
    // hands back the cached image and this count stays at zero.
    expect(provider.fn).toHaveBeenCalledTimes(1);
  });

  it("calls nothing on a dry run", async () => {
    const path = await project(`
assets:
  - id: hero
    prompt: a dashboard
`);
    const loaded = await loadAssets(path);
    const outcome = await syncAssets(loaded, { provider: NEVER, dryRun: true });

    expect(NEVER).not.toHaveBeenCalled();
    expect(outcome.generated).toEqual([]);
    expect(outcome.statuses[0]!.state).toBe("missing");
  });

  it("keeps going after one asset fails, and still returns the whole report", async () => {
    const path = await project(`
assets:
  - id: good
    prompt: a dashboard
  - id: bad
    prompt: a blocked thing
`);
    const loaded = await loadAssets(path);
    const provider = vi.fn(async (request: GenerateRequest) => {
      if (request.prompt.includes("blocked")) throw new ContentBlocked("refused");
      return { images: [PNG], model: "gpt-5", effectivePrompt: request.prompt };
    });

    // Returned, not thrown: the report is the point of the run, and `--json` has to
    // be able to print it on exactly the runs that failed.
    const outcome = await syncAssets(loaded, { provider, concurrency: 1 });
    expect(outcome.failure).toBeInstanceOf(ContentBlocked);
    expect(outcome.generated).toEqual(["good"]);
    expect(outcome.failures.map((failure) => failure.id)).toEqual(["bad"]);
    expect(provider).toHaveBeenCalledTimes(2);
    // The one that worked is still on disk.
    expect(await readFile(loaded.assets[0]!.out)).toEqual(PNG);
  });

  it("stops the run on an auth failure instead of repeating it", async () => {
    const path = await project(`
assets:
  - id: a
    prompt: one
  - id: b
    prompt: two
  - id: c
    prompt: three
`);
    const loaded = await loadAssets(path);
    const provider = vi.fn(async () => {
      throw new AuthExpired("log in again");
    });

    const outcome = await syncAssets(loaded, { provider, concurrency: 1 });
    expect(outcome.failure).toBeInstanceOf(AuthExpired);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("refuses a sync larger than the project budget, before submitting anything", async () => {
    const path = await project(`
assets:
  - id: a
    prompt: one
  - id: b
    prompt: two
  - id: c
    prompt: three
`);
    await writeFile(join(dirname(path), "subpixel.config.json"), '{ "budget": { "maxImagesPerRun": 2 } }');
    const loaded = await loadAssets(path);

    await expect(syncAssets(loaded, { provider: NEVER })).rejects.toThrow(/maxImagesPerRun/);
    expect(NEVER).not.toHaveBeenCalled();
  });

  it("takes the backend and concurrency from the project config when no flag says otherwise", async () => {
    const path = await project(`
assets:
  - id: hero
    prompt: a dashboard
`);
    await writeFile(
      join(dirname(path), "subpixel.config.json"),
      '{ "backend": "codex-exec", "concurrency": 1 }',
    );
    const loaded = await loadAssets(path);
    const seen: Array<string | undefined> = [];
    await syncAssets(loaded, {
      provider: async (request) => {
        seen.push(request.prompt);
        return { images: [PNG], model: "gpt-5", effectivePrompt: request.prompt, backend: "codex-exec" };
      },
    });
    expect(seen).toHaveLength(1);
  });

  it("redacts a credential in the reported prompt", async () => {
    const path = await project(`
assets:
  - id: hero
    prompt: logo for sk-proj-abcdefghijklmnopqrstuvwxyz012345
`);
    const loaded = await loadAssets(path);
    const lines: string[] = [];
    await syncAssets(loaded, { provider: fakeProvider().fn, log: (line) => lines.push(line) });
    expect(lines.join("\n")).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz012345");
  });
});
