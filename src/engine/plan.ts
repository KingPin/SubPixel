import type { BackendName, GenerateRequest } from "../core/types.js";
import { hasCodexBinary } from "../providers/codex-exec.js";
import { resolveModel } from "../providers/models.js";
import { resolveChain } from "../providers/resolve.js";
import { cacheKey } from "./cache.js";
import { preflightCacheModes, preflightPostProcessing } from "./generate.js";
import { augmentPrompt } from "./prompt.js";
import { loadReferences } from "./references.js";

export interface PlanOptions {
  /** Where the image would be written. Already resolved by the caller. */
  outDir: string;
  backend?: BackendName;
  /** The `--model` / `model` override, if one was given. */
  model?: string;
  /** Optional, because `GenerateDeps` leaves them so; reported as plain booleans. */
  noCache?: boolean;
  cacheOnly?: boolean;
  overwrite?: boolean;
}

/** What a run would do, in the shape both `--dry-run` and `dry_run` hand back. */
export interface GeneratePlan {
  dryRun: true;
  chain: readonly BackendName[];
  model: string;
  modelSource: string;
  effectivePrompt: string;
  outDir: string;
  cacheKey: string;
  referenceImages?: string[];
  noCache: boolean;
  cacheOnly: boolean;
  overwrite: boolean;
}

/**
 * Work out what a request would do, without doing it.
 *
 * **This function takes no provider and no way to reach one.** That is the whole
 * guarantee, and it is structural rather than a promise in a comment: there is no
 * argument here that could carry a backend call, so no future edit can make a
 * preview spend quota by passing the wrong flag. `checkAssets` earns its zero-quota
 * claim the same way.
 *
 * Local file reads are still made — references have to be hashed, because a key
 * computed without the reference digests can never match the entry the real run
 * looks up, and a preview that reports a clean plan for a missing reference is
 * worse than no preview.
 *
 * A preview is not a reservation. Nothing is locked, no quota is set aside, and the
 * cache can be filled or emptied by another process between this and the real run.
 */
export async function planGenerate(
  request: GenerateRequest,
  options: PlanOptions,
): Promise<GeneratePlan> {
  // The same boundary check the real run makes, and for the same reason it exists:
  // a preview whose whole job is "tell me what would happen before I spend quota"
  // is worth nothing if it reports a clean plan for a request that cannot run.
  // Without it `--exact-size nonsense --dry-run` exited 0 and a malformed `--size`
  // failed later, inside aspect-ratio arithmetic, with no flag named.
  await preflightPostProcessing(request);
  // The same reasoning one line up, applied to the combinations `generate` refuses.
  // `--dry-run --cache-only --no-cache` reporting a clean plan for a call that cannot
  // run is the exact failure this function exists to prevent.
  preflightCacheModes(request, options);

  const resolved = await resolveModel({ override: options.model });
  const chain = resolveChain({
    hasCodexBinary: await hasCodexBinary(),
    requested: options.backend,
  });
  const references = await loadReferences(request.referenceImages);

  return {
    dryRun: true,
    chain,
    model: resolved.slug,
    modelSource: resolved.source,
    effectivePrompt: augmentPrompt(request.prompt, request),
    outDir: options.outDir,
    cacheKey: cacheKey({
      ...request,
      referenceHashes: references.map((reference) => reference.sha256),
    }),
    ...(request.referenceImages && { referenceImages: request.referenceImages }),
    // Reported so --force and --cache-only can be verified without spending anything.
    noCache: options.noCache === true,
    cacheOnly: options.cacheOnly === true,
    overwrite: options.overwrite === true,
  };
}
