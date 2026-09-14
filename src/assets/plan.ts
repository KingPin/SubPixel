import { access } from "node:fs/promises";
import { basename } from "node:path";
import { cacheKey } from "../engine/cache.js";
import { readManifest, type ManifestEntry } from "../engine/manifest.js";
import { loadReferences } from "../engine/references.js";
import { variantPath } from "../engine/variants.js";
import { redact } from "../core/redact.js";
import type { ResolvedAsset } from "./load.js";

export type AssetState = "missing" | "stale" | "current";

export interface AssetStatus {
  id: string;
  out: string;
  state: AssetState;
  /** Why, in one short phrase, for the drift report. Already redacted. */
  reason: string;
  /** The key the asset WOULD be stored under. Reported by `--json`. */
  key: string;
}

/**
 * Everything the planner is allowed to touch.
 *
 * The interface exists so the tests can run over in-memory maps, and so that the
 * set of capabilities this module has is visible in one place: three reads, no
 * writes, no provider. See the task note above for why that matters.
 */
export interface AssetProbe {
  exists(path: string): Promise<boolean>;
  readManifest(path: string): Promise<ManifestEntry | undefined>;
  /** sha256 of each reference image's CONTENTS, in order. */
  referenceHashes(paths: string[] | undefined): Promise<string[]>;
}

export const diskProbe: AssetProbe = {
  exists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  readManifest,
  referenceHashes: async (paths) =>
    (await loadReferences(paths)).map((reference) => reference.sha256),
};

async function statusFor(asset: ResolvedAsset, probe: AssetProbe): Promise<AssetStatus> {
  const hashes = await probe.referenceHashes(asset.request.referenceImages);
  const key = cacheKey({ ...asset.request, referenceHashes: hashes });
  const base = { id: asset.id, out: asset.out, key };

  if (!(await probe.exists(asset.out))) {
    return { ...base, state: "missing", reason: redact(`${basename(asset.out)} does not exist`) };
  }

  const manifest = await probe.readManifest(asset.out);
  if (!manifest) {
    // The file exists but nothing records what produced it. That is not evidence
    // of being current — it is the absence of evidence, and the whole point of
    // --check is that it only passes on proof.
    return { ...base, state: "stale", reason: redact(`${basename(asset.out)} has no manifest`) };
  }

  if (manifest.cacheKey !== key) {
    return { ...base, state: "stale", reason: redact(`${asset.id}: prompt or settings changed`) };
  }

  for (const variant of asset.variants) {
    // A width the engine refused to upscale is not drift. It is a decision, taken
    // once, recorded in the sidecar by the run that took it. Without this check the
    // asset is stale forever: every sync re-materialises the primary, skips the
    // width again for the same good reason, and reports the same failure. The
    // sidecar is rewritten whenever the primary is, so this record cannot go stale
    // independently of the file it describes.
    if (manifest.skippedVariants?.includes(variant.width)) continue;

    const path = variantPath(asset.out, variant.width, variant.suffix);
    if (!(await probe.exists(path))) {
      return { ...base, state: "stale", reason: redact(`${basename(path)} is missing`) };
    }
  }

  return { ...base, state: "current", reason: "" };
}

export async function planAssets(
  assets: readonly ResolvedAsset[],
  probe: AssetProbe = diskProbe,
): Promise<AssetStatus[]> {
  // Sequential on purpose. These are local stat calls, the lists are short, and a
  // deterministic order makes the drift report diffable between CI runs.
  const statuses: AssetStatus[] = [];
  for (const asset of assets) statuses.push(await statusFor(asset, probe));
  return statuses;
}

export function hasDrift(statuses: readonly AssetStatus[]): boolean {
  return statuses.some((status) => status.state !== "current");
}
