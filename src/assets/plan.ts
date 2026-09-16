import { access, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { cacheKey } from "../engine/cache.js";
import { readManifest, type ManifestEntry } from "../engine/manifest.js";
import { referenceHashes } from "../engine/references.js";
import { sha256 } from "../engine/output.js";
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
  /** sha256 of a written artifact, or `undefined` when it cannot be read. */
  digest(path: string): Promise<string | undefined>;
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
  digest: async (path) => {
    try {
      return sha256(await readFile(path));
    } catch {
      return undefined;
    }
  },
  referenceHashes,
};

export interface PlanOptions {
  /**
   * Also read every artifact back and compare it to the sha256 in its own sidecar.
   *
   * Every artifact: the primary AND each variant. A variant is a file on disk that
   * nothing in the cache key describes, so checking only that it exists leaves the
   * one artifact this option never looked at.
   *
   * OFF for a sync, ON for a check, and the asymmetry is the point. A key match
   * says "the inputs are unchanged since this was generated". It says nothing about
   * the file, which can be truncated by a half-finished copy, mangled by an
   * optimiser run over the assets directory, or replaced wholesale — and the
   * manifest beside it still matches, so every `--check` passes.
   *
   * A sync does not do it because a sync is about to consult the cache and write
   * whatever it finds anyway, and reading every artifact twice buys nothing there.
   * A check is the run whose entire output is the word "current", so it is the run
   * that has to have looked.
   */
  verify?: boolean;
}

async function statusFor(
  asset: ResolvedAsset,
  probe: AssetProbe,
  options: PlanOptions,
): Promise<AssetStatus> {
  const hashes = await probe.referenceHashes(asset.request.referenceImages);
  const key = cacheKey({ ...asset.request, referenceHashes: hashes });
  const base = { id: asset.id, out: asset.out, key };

  if (!(await probe.exists(asset.out))) {
    return {
      ...base,
      state: "missing",
      reason: redact(`${basename(asset.out)} does not exist`),
    };
  }

  const manifest = await probe.readManifest(asset.out);
  if (!manifest) {
    // The file exists but nothing records what produced it. That is not evidence
    // of being current — it is the absence of evidence, and the whole point of
    // --check is that it only passes on proof.
    return {
      ...base,
      state: "stale",
      reason: redact(`${basename(asset.out)} has no manifest`),
    };
  }

  if (manifest.cacheKey !== key) {
    return {
      ...base,
      state: "stale",
      reason: redact(`${asset.id}: prompt or settings changed`),
    };
  }

  if (options.verify && manifest.sha256) {
    const digest = await probe.digest(asset.out);
    if (digest !== manifest.sha256) {
      return {
        ...base,
        state: "stale",
        reason: redact(
          `${basename(asset.out)} does not match the sha256 its own manifest records`,
        ),
      };
    }
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
      return {
        ...base,
        state: "stale",
        reason: redact(`${basename(path)} is missing`),
      };
    }

    // The same reasoning as the primary, and the same reason it is a check-only
    // step: a variant is a file on disk that nothing in the cache key describes, so
    // existing is not evidence of being intact. Left on trust it was the one
    // artifact `--verify` never looked at.
    const record = manifest.variants?.find((v) => v.width === variant.width);
    if (
      options.verify &&
      record?.sha256 &&
      (await probe.digest(path)) !== record.sha256
    ) {
      return {
        ...base,
        state: "stale",
        reason: redact(
          `${basename(path)} does not match the sha256 its own manifest records`,
        ),
      };
    }
  }

  return { ...base, state: "current", reason: "" };
}

export async function planAssets(
  assets: readonly ResolvedAsset[],
  probe: AssetProbe = diskProbe,
  options: PlanOptions = {},
): Promise<AssetStatus[]> {
  // Sequential on purpose. These are local stat calls, the lists are short, and a
  // deterministic order makes the drift report diffable between CI runs.
  const statuses: AssetStatus[] = [];
  for (const asset of assets)
    statuses.push(await statusFor(asset, probe, options));
  return statuses;
}

export function hasDrift(statuses: readonly AssetStatus[]): boolean {
  return statuses.some((status) => status.state !== "current");
}
