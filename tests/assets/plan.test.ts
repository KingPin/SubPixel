import { describe, expect, it } from "vitest";
import type { ManifestEntry } from "../../src/engine/manifest.js";
import { cacheKey } from "../../src/engine/cache.js";
import { hasDrift, planAssets, type AssetProbe } from "../../src/assets/plan.js";
import type { ResolvedAsset } from "../../src/assets/load.js";

function asset(overrides: Partial<ResolvedAsset> = {}): ResolvedAsset {
  return {
    id: "hero",
    out: "/repo/public/hero.webp",
    request: { prompt: "a dashboard", size: "1536x1024", format: "webp", outputPath: "/repo/public/hero.webp" },
    variants: [],
    ...overrides,
  };
}

function manifestFor(a: ResolvedAsset, hashes: string[] = []): ManifestEntry {
  return {
    prompt: a.request.prompt,
    effectivePrompt: a.request.prompt,
    model: "gpt-5",
    backend: "codex-http",
    cacheKey: cacheKey({ ...a.request, referenceHashes: hashes }),
    sha256: "deadbeef",
    bytes: 1234,
    format: "webp",
  };
}

/** A probe over in-memory maps. Nothing here can reach a network. */
function probeOver(
  files: Set<string>,
  manifests: Map<string, ManifestEntry>,
  hashes: Record<string, string> = {},
  digests: Record<string, string> = {},
): AssetProbe {
  return {
    exists: async (path) => files.has(path),
    readManifest: async (path) => manifests.get(path),
    referenceHashes: async (paths) => (paths ?? []).map((path) => hashes[path] ?? "missing"),
    // Defaults to what the manifest claims, so only a test that sets this out of
    // step with the manifest is testing the verification.
    digest: async (path) => digests[path] ?? manifests.get(path)?.sha256,
  };
}

describe("planAssets", () => {
  it("reports a missing output file", async () => {
    const a = asset();
    const statuses = await planAssets([a], probeOver(new Set(), new Map()));
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.state).toBe("missing");
    expect(statuses[0]!.id).toBe("hero");
  });

  it("treats a file with no manifest as stale", async () => {
    const a = asset();
    const statuses = await planAssets([a], probeOver(new Set([a.out]), new Map()));
    expect(statuses[0]!.state).toBe("stale");
    expect(statuses[0]!.reason).toMatch(/manifest/);
  });

  it("is current when the recomputed key matches the manifest", async () => {
    const a = asset();
    const statuses = await planAssets(
      [a],
      probeOver(new Set([a.out]), new Map([[a.out, manifestFor(a)]])),
    );
    expect(statuses[0]!.state).toBe("current");
  });

  it("is stale when the prompt changed", async () => {
    const a = asset();
    const stored = manifestFor(a);
    const changed = asset({ request: { ...a.request, prompt: "a different dashboard" } });
    const statuses = await planAssets(
      [changed],
      probeOver(new Set([a.out]), new Map([[a.out, stored]])),
    );
    expect(statuses[0]!.state).toBe("stale");
  });

  it("is stale when a reference image's contents changed", async () => {
    const a = asset({ request: { ...asset().request, referenceImages: ["/repo/logo.png"] } });
    const manifests = new Map([[a.out, manifestFor(a, ["old-digest"])]]);
    const statuses = await planAssets(
      [a],
      probeOver(new Set([a.out]), manifests, { "/repo/logo.png": "new-digest" }),
    );
    expect(statuses[0]!.state).toBe("stale");
  });

  it("is stale when a declared variant file is absent", async () => {
    const a = asset({ variants: [{ width: 768 }] });
    const statuses = await planAssets(
      [a],
      probeOver(new Set([a.out]), new Map([[a.out, manifestFor(a)]])),
    );
    expect(statuses[0]!.state).toBe("stale");
    expect(statuses[0]!.reason).toMatch(/hero-768w\.webp/);
  });

  it("is current when every declared variant is present", async () => {
    const a = asset({ variants: [{ width: 768 }, { width: 1536, suffix: "@lg" }] });
    const files = new Set([a.out, "/repo/public/hero-768w.webp", "/repo/public/hero@lg.webp"]);
    const statuses = await planAssets([a], probeOver(files, new Map([[a.out, manifestFor(a)]])));
    expect(statuses[0]!.state).toBe("current");
  });

  it("redacts a credential that reached a prompt", async () => {
    const a = asset({ request: { ...asset().request, prompt: "logo for sk-proj-abcdefghijklmnopqrstuvwxyz012345" } });
    const statuses = await planAssets([a], probeOver(new Set(), new Map()));
    expect(statuses[0]!.reason).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz012345");
  });

  it("keeps input order", async () => {
    const statuses = await planAssets(
      [asset({ id: "b", out: "/out/b.png" }), asset({ id: "a", out: "/out/a.png" })],
      probeOver(new Set(), new Map()),
    );
    expect(statuses.map((status) => status.id)).toEqual(["b", "a"]);
  });
});

describe("hasDrift", () => {
  it("is false only when everything is current", () => {
    expect(hasDrift([{ id: "a", out: "/a", state: "current", reason: "", key: "k" }])).toBe(false);
    expect(hasDrift([{ id: "a", out: "/a", state: "stale", reason: "", key: "k" }])).toBe(true);
    expect(hasDrift([{ id: "a", out: "/a", state: "missing", reason: "", key: "k" }])).toBe(true);
    expect(hasDrift([])).toBe(false);
  });
});

describe("planAssets with verify", () => {
  // A key match says the INPUTS are unchanged. It says nothing about the file,
  // which a half-finished copy can truncate and an image optimiser can rewrite,
  // leaving a manifest that still matches and a check that passes forever.
  it("catches a file that no longer matches its own manifest", async () => {
    const a = asset();
    const probe = probeOver(
      new Set([a.out]),
      new Map([[a.out, manifestFor(a)]]),
      {},
      { [a.out]: "something else entirely" },
    );

    expect((await planAssets([a], probe))[0]!.state).toBe("current");
    const verified = await planAssets([a], probe, { verify: true });
    expect(verified[0]!.state).toBe("stale");
    expect(verified[0]!.reason).toMatch(/sha256/);
  });

  it("stays current when the bytes do match", async () => {
    const a = asset();
    const probe = probeOver(new Set([a.out]), new Map([[a.out, manifestFor(a)]]));
    expect((await planAssets([a], probe, { verify: true }))[0]!.state).toBe("current");
  });

  it("does not call for a digest when it is not verifying", async () => {
    const a = asset();
    const probe = probeOver(new Set([a.out]), new Map([[a.out, manifestFor(a)]]));
    probe.digest = async () => {
      throw new Error("a sync must not read every artifact back");
    };
    expect((await planAssets([a], probe))[0]!.state).toBe("current");
  });
});
