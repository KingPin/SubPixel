import { join } from "node:path";
import { ModelUnavailable, OutputError } from "../core/errors.js";
import { createDeadline, type Deadline } from "../core/deadline.js";
import { withFileLock, type LockHandle } from "../core/fsx.js";
import { silentLogger, type Logger } from "../core/logger.js";
import { redact } from "../core/redact.js";
import type { GenerateRequest, GenerateResult, ImageArtifact } from "../core/types.js";
import { generateViaCodexHttp, type ProviderResult } from "../providers/codex-http.js";
import { advancePast, resolveModel, type ResolvedModel } from "../providers/models.js";
import { formatQuota, loadQuota, saveQuota, shouldWarn } from "../providers/quota.js";
import {
  cacheKey,
  lookupCache,
  materialiseFromCache,
  storeCache,
  type CacheEntry,
  type CacheProvenance,
} from "./cache.js";
import { writeManifest } from "./manifest.js";
import {
  enforceExactSize,
  preflightExactSize,
  resolveOutputPath,
  sha256,
  writeImage,
} from "./output.js";

export type ProviderFn = (
  request: GenerateRequest,
  options: { model: string; deadline?: Deadline },
) => Promise<ProviderResult>;

export interface GenerateDeps {
  outDir: string;
  stateDir: string;
  logger?: Logger;
  /** Skip the cache LOOKUP. The result is still stored. */
  noCache?: boolean;
  /** Replace an existing output file instead of writing a `-v2` sibling. */
  overwrite?: boolean;
  /** Whole-request budget in milliseconds, started here, after the slot is held. */
  timeoutMs?: number;
  provider?: ProviderFn;
  resolveModelFn?: (options: { override?: string }) => Promise<ResolvedModel>;
  /** Emitted to stderr even under `--quiet`, per the output contract. */
  warnAlways?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * One image, one backend call.
 *
 * `ModelUnavailable` is the ONLY error worth retrying here. It is the narrow case
 * where the backend rejected the model slug by name before generating anything, so
 * nothing was billed and the next candidate probably works.
 *
 * `ModelRejected` deliberately does NOT qualify. It is the catch-all for a 4xx the
 * classifier could not place, which includes a rejected prompt, a malformed
 * request, and an unsupported parameter. Retrying those on a second model spends a
 * second unit of quota to fail the same way, and if the first attempt was in fact
 * billed, the user pays twice for nothing. Every other error propagates untouched:
 * the orchestrator is not entitled to decide that a possibly-billed failure
 * deserves another billed attempt.
 */
export async function callWithModelRecovery(
  request: GenerateRequest,
  resolved: ResolvedModel,
  provider: ProviderFn,
  logger: Logger,
  deadline: Deadline,
): Promise<ProviderResult> {
  let slug: string | undefined = resolved.slug;

  for (;;) {
    if (!slug) {
      throw new ModelUnavailable(
        "No driver model candidates remain. Run `spx models` to see the current list.",
      );
    }
    try {
      return await provider(request, { model: slug, deadline });
    } catch (err) {
      if (!(err instanceof ModelUnavailable)) throw err;
      const next = advancePast(resolved.candidates, slug);
      if (!next) throw err;
      logger.warn(
        `Model "${slug}" is not available on this account. Falling back to "${next.slug}". ` +
          "Run `spx models` to see the current list.",
      );
      slug = next.slug;
    }
  }
}

/** The key for the bytes as the backend produced them, before any local resize. */
function rawCacheKey(request: GenerateRequest): string {
  return cacheKey({ ...request, exactSize: undefined });
}

/**
 * What a manifest says when the cache entry predates provenance being recorded.
 *
 * Not "(cached)" and not the currently resolved driver model. Both would be lies:
 * the first names no model at all, the second names one that may never have touched
 * these bytes. Say plainly that the record is missing.
 */
const UNKNOWN_CACHED_MODEL = "unknown (cached before provenance was recorded)";

function provenanceOf(entry: CacheEntry): CacheProvenance | undefined {
  if (!entry.model || !entry.backend || entry.effectivePrompt === undefined) return undefined;
  return { model: entry.model, backend: entry.backend, effectivePrompt: entry.effectivePrompt };
}

export async function generate(
  request: GenerateRequest,
  deps: GenerateDeps,
): Promise<GenerateResult> {
  // Fail on a bad --exact-size or a missing sharp BEFORE anything is spent. Both
  // checks are free and deterministic; discovering them after generation costs the
  // user quota for an image they never receive.
  await preflightExactSize(request.exactSize);

  const key = cacheKey(request);
  const count = Math.max(1, request.n ?? 1);

  // Serialise identical concurrent requests ACROSS PROCESSES. Without this, two
  // `spx sync` runs, or a watch loop firing twice, both miss the cache and both
  // pay for the same picture.
  //
  // The lock is on the RAW key, not the full key. `--exact-size` is a local resize
  // of bytes the backend never sees, so `100x100` and `200x200` for the same prompt
  // are one purchase and two crops. Locking the full key gives them different locks:
  // both enter, both miss the raw bank, both submit, and the second raw entry
  // overwrites the first — so which bytes a later recovery finds depends on which
  // generation happened to finish last. One lock per purchase is the whole point.
  // Unrelated prompts still run in parallel, which is all the granularity buys.
  if (count === 1 && !deps.noCache) {
    return withFileLock(
      join(deps.stateDir, "locks", `${rawCacheKey(request)}.lock`),
      (lock) => runGeneration(request, deps, key, count, lock),
      {
        // Long enough to cover a full generation behind another process.
        timeoutMs: (deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 60_000,
      },
    );
  }
  return runGeneration(request, deps, key, count);
}

async function runGeneration(
  request: GenerateRequest,
  deps: GenerateDeps,
  key: string,
  count: number,
  /** Present only on the locked single-image path. */
  lock?: LockHandle,
): Promise<GenerateResult> {
  const startedAt = Date.now();
  const logger = deps.logger ?? silentLogger;
  const warnAlways = deps.warnAlways ?? ((message: string) => logger.warn(message));
  const provider = deps.provider ?? ((req, opts) => generateViaCodexHttp(req, opts));
  const resolveFn = deps.resolveModelFn ?? ((options) => resolveModel(options));

  const destinationFor = (index: number): string =>
    resolveOutputPath({
      outDir: deps.outDir,
      prompt: request.prompt,
      // Provisional: writeImage re-derives the extension from the sniffed bytes.
      format: request.format ?? "png",
      explicit: count === 1 ? request.outputPath : undefined,
      index,
    });

  const writeOptions = {
    requestedFormat: request.format,
    overwrite: deps.overwrite === true,
    warn: warnAlways,
  };

  // Finish a cache hit the same way a fresh generation finishes: manifest beside the
  // file that was actually written — including a collision sibling — and the real
  // provenance, not a "(cached)" placeholder that describes nothing.
  const finishFromCache = async (
    artifact: ImageArtifact,
    entry: CacheEntry,
  ): Promise<GenerateResult> => {
    const model = entry.model ?? UNKNOWN_CACHED_MODEL;
    const backend = entry.backend ?? "codex-http";
    const effectivePrompt = entry.effectivePrompt ?? request.prompt;
    await writeManifest(artifact.path, {
      prompt: request.prompt,
      effectivePrompt,
      model,
      backend,
      size: request.size,
      exactSize: request.exactSize,
      cacheKey: key,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      format: artifact.format,
    });
    return {
      images: [artifact],
      // A hit serves one image and never starts a batch.
      requested: 1,
      backend,
      model,
      cached: true,
      effectivePrompt,
      elapsedMs: Date.now() - startedAt,
    };
  };

  // Re-check the cache now that the lock is held. Another process may have
  // generated this exact image while we were queued behind it; without this
  // re-check the lock only staggers the duplicate spend instead of preventing it.
  if (!deps.noCache && count === 1) {
    const hit = await lookupCache(deps.stateDir, key);
    if (hit) {
      logger.debug(`Cache hit for ${key.slice(0, 12)}; no quota spent.`);
      // Materialise at THIS run's destination. A hit still has to produce the file
      // the caller asked for.
      return finishFromCache(await materialiseFromCache(hit, destinationFor(0), writeOptions), hit.entry);
    }

    // Second lookup, on the key the bytes were BANKED under. This is the recovery
    // half of the raw-bytes bank: the previous run paid for these pixels and then
    // failed in `sharp`, in `mkdir`, or on a full disk. Without this lookup the
    // retry looks like a plain miss and buys the same picture again.
    //
    // The two keys differ only when `--exact-size` is set, so this costs one extra
    // `stat`-shaped miss on the common path and nothing at all otherwise.
    const rawKey = rawCacheKey(request);
    if (request.exactSize && rawKey !== key) {
      const rawHit = await lookupCache(deps.stateDir, rawKey);
      if (rawHit) {
        logger.debug(`Raw-bytes hit for ${rawKey.slice(0, 12)}; resizing locally, no quota spent.`);
        const bytes = await enforceExactSize(rawHit.data, request.exactSize);
        const artifact = await writeImage(destinationFor(0), bytes, writeOptions);
        // Index the resized result under the full key so the next run is a plain hit.
        await storeCache(deps.stateDir, key, artifact, bytes, provenanceOf(rawHit.entry));
        return finishFromCache(artifact, rawHit.entry);
      }
    }
  }

  // Preflight quota warning. The last run wrote what the backend told it about the
  // remaining allowance; say so BEFORE spending, not after. This is the only place
  // the user can still change their mind. A cache hit never reaches here, because a
  // hit spends nothing and a warning about it would be noise.
  //
  // This never blocks and never throws. The cached figure can be hours old and the
  // real limit lives on the server, so the tool reports and proceeds.
  // `formatQuota` already opens with "Quota:", so the prefix ends without a colon.
  const cachedQuota = await loadQuota(join(deps.stateDir, "quota.json"));
  if (shouldWarn(cachedQuota)) {
    warnAlways(`Before this run — ${formatQuota(cachedQuota)}`);
  }

  const resolved = await resolveFn({ override: request.model });

  const images: ImageArtifact[] = [];
  let modelUsed = resolved.slug;
  let effectivePrompt = request.prompt;

  for (let index = 0; index < count; index += 1) {
    // The budget starts HERE, not when the command was typed. The spec is explicit
    // that the timeout begins after slot acquisition, and by this point the caller's
    // concurrency slot and the per-key lock are both held.
    const deadline = createDeadline(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, { label: "generate" });
    deadline.start();

    // The last thing before the money is spent. Holding the lock is what makes the
    // cache re-check above meaningful: if the lock was lost between that check and
    // here, another owner is generating this same image and submitting would buy a
    // second copy. `assertHeld()` re-reads the record, so it answers for this line.
    await lock?.assertHeld();

    let result: ProviderResult;
    try {
      result = await callWithModelRecovery(request, resolved, provider, logger, deadline);
    } finally {
      deadline.dispose();
    }
    modelUsed = result.model;
    effectivePrompt = result.effectivePrompt;

    if (result.quota) {
      await saveQuota(join(deps.stateDir, "quota.json"), result.quota);
      if (shouldWarn(result.quota)) {
        warnAlways(formatQuota(result.quota));
      }
    }

    const raw = result.images[0];
    if (!raw) throw new OutputError("The backend returned no image data.");

    // Bank the paid bytes IMMEDIATELY, before any local step that can fail.
    // Everything after this point — sharp, mkdir, the write itself — can throw on a
    // full disk or a read-only directory, and without this the user has paid for an
    // image that exists nowhere. Stored under the exactSize-free key so a re-run
    // reuses it whatever `--exact-size` says next time.

    // `check()` rather than `assertHeld()`: the bytes are already paid for, so a
    // lost lock must never throw them away. It only means the shared bank belongs
    // to someone else now, and this run keeps its image locally.
    const mayPublish = lock ? await lock.check() : true;
    if (!mayPublish) {
      warnAlways(
        "Another process took over this request's lock, so the result was not added " +
          "to the shared cache. The image itself is written normally.",
      );
    }

    if (count === 1 && mayPublish) {
      await storeCache(
        deps.stateDir,
        rawCacheKey(request),
        { path: "", bytes: raw.length, format: "png", sha256: sha256(raw) },
        raw,
        // Banked WITH its provenance. A later run that recovers these bytes has to
        // write a truthful manifest, and by then this process is gone.
        { model: modelUsed, backend: "codex-http", effectivePrompt },
      ).catch((err: unknown) => {
        logger.debug(`Could not bank the raw bytes: ${String(err)}`);
      });
    }

    const bytes = request.exactSize ? await enforceExactSize(raw, request.exactSize) : raw;

    const artifact = await writeImage(destinationFor(index), bytes, writeOptions);
    await writeManifest(artifact.path, {
      prompt: request.prompt,
      effectivePrompt,
      model: modelUsed,
      backend: "codex-http",
      size: request.size,
      exactSize: request.exactSize,
      cacheKey: key,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      format: artifact.format,
    });
    images.push(artifact);

    // Only a single-image request has an unambiguous cache entry.
    if (count === 1 && mayPublish) {
      await storeCache(deps.stateDir, key, artifact, bytes, {
        model: modelUsed,
        backend: "codex-http",
        effectivePrompt,
      });
    }
  }

  return {
    images,
    requested: count,
    backend: "codex-http",
    model: modelUsed,
    cached: false,
    effectivePrompt,
    elapsedMs: Date.now() - startedAt,
  };
}
