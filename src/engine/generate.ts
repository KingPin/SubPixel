import { createHash } from "node:crypto";
import { join } from "node:path";
import { ModelUnavailable, OutputError } from "../core/errors.js";
import { createDeadline, type Deadline } from "../core/deadline.js";
import { withFileLock, type LockHandle } from "../core/fsx.js";
import { silentLogger, type Logger } from "../core/logger.js";
import { redact } from "../core/redact.js";
import type {
  BackendName,
  BatchFailure,
  GenerateRequest,
  GenerateResult,
  ImageArtifact,
} from "../core/types.js";
import { generateViaCodexHttp, type ProviderResult } from "../providers/codex-http.js";
import { generateViaCodexExec, hasCodexBinary } from "../providers/codex-exec.js";
import { resolveChain, runWithFallback } from "../providers/resolve.js";
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
import { mapWithConcurrency } from "./semaphore.js";
import { resolveOutputPath, sha256, sniffFormat, writeImage } from "./output.js";
import {
  convert,
  enforceExactSize,
  preflightExactSize,
  probeDimensions,
  sharpAvailable,
} from "./sharpx.js";

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
  /** How long a stream may produce nothing before it is abandoned. */
  stallMs?: number;
  /** How many images of an `-n` batch may be in flight at once. */
  concurrency?: number;
  backend?: BackendName;
  allowPaid?: boolean;
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

/**
 * The key for the bytes as the backend produced them, before any local step.
 *
 * The domain prefix is the point. Dropping the locally-applied fields is not
 * enough: when none of them are set, the "raw" key equals the processed key, and
 * the bank of unprocessed bytes becomes a cache hit that serves a half-finished
 * image. A separate namespace makes that collision unrepresentable rather than
 * merely unlikely.
 *
 * `format` is dropped for the same reason `exactSize` is: format is a LOCAL
 * conversion (see `postProcess`), so the same backend bytes serve every requested
 * format.
 */
export function rawCacheKey(request: GenerateRequest): string {
  return createHash("sha256")
    .update("raw\0")
    .update(cacheKey({ ...request, exactSize: undefined, format: undefined }))
    .digest("hex");
}

/**
 * Every local transformation between "bytes the backend returned" and "bytes on
 * disk", in the one order that is correct.
 *
 * Fresh generation and raw-bank recovery both call THIS. That is the whole reason
 * it exists: the two paths produced different images the last time they each had
 * their own copy of these steps.
 */
async function postProcess(
  raw: Uint8Array,
  request: GenerateRequest,
  warn: (message: string) => void,
): Promise<Uint8Array> {
  let bytes: Uint8Array = raw;

  if (request.exactSize) bytes = await enforceExactSize(bytes, request.exactSize);

  // Format conversion is last, and it is a real conversion.
  //
  // `writeImage` does not convert: it sniffs the bytes and renames the file to
  // match them. So a request for `hero.webp` that the backend answers with PNG
  // bytes writes `hero.png` — and `assets.yml`, which declared `hero.webp`, then
  // reports that asset as missing on every run, forever. A declared format is a
  // promise about the file, not a hint about the request.
  const actual = sniffFormat(bytes);
  if (request.format && actual && actual !== request.format) {
    if (await sharpAvailable()) {
      bytes = await convert(bytes, request.format);
    } else {
      // Not fatal: the bytes are a real image and the user gets it, correctly named
      // for what it is. But say plainly why the name is not the one they asked for.
      warn(
        `The backend returned ${actual}, not ${request.format}, and sharp is not installed to convert it. ` +
          `Writing a .${actual} file. Run \`npm i sharp\` for ${request.format} output.`,
      );
    }
  }

  return bytes;
}

/**
 * Everything a local post-processing step needs, checked BEFORE any quota is spent.
 *
 * Format conversion is deliberately NOT here: whether it is needed depends on what
 * the backend returns, and refusing a `--format webp` run on a machine without
 * sharp would break the common case where the backend simply returns WebP.
 */
export async function preflightPostProcessing(request: GenerateRequest): Promise<void> {
  await preflightExactSize(request.exactSize);
}

/**
 * Attach the real pixel dimensions, best effort.
 *
 * `ImageArtifact` has declared `width?`/`height?` since M1 and nothing filled them
 * in, so a consumer reading the sidecar manifest to lay out a page had to open the
 * image itself. sharp is optional, so an absent dependency — or bytes it cannot
 * decode — leaves them unset rather than failing the run.
 */
async function withDimensions(
  artifact: ImageArtifact,
  data: Uint8Array,
): Promise<ImageArtifact> {
  return { ...artifact, ...(await probeDimensions(data)) };
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
  await preflightPostProcessing(request);

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
  const provider: ProviderFn =
    deps.provider ??
    (async (req, opts) => {
      const chain = resolveChain({
        hasCodexBinary: await hasCodexBinary(),
        requested: deps.backend,
        allowPaid: deps.allowPaid,
      });
      const run = await runWithFallback(
        chain,
        {
          // The deadline is forwarded, not recreated. It was started in the
          // worker after the concurrency slot and the lock were taken, and it is
          // what makes --timeout cover connect, headers and body.
          "codex-http": (r) =>
            generateViaCodexHttp(r, {
              model: opts.model,
              stallMs: deps.stallMs,
              deadline: opts.deadline,
            }),
          "codex-exec": (r) =>
            generateViaCodexExec(r, {
              model: opts.model,
              timeoutMs: deps.timeoutMs,
              // Exec runs after HTTP has already spent part of the request. Without
              // the deadline it starts a fresh full budget, so `--timeout 60` can
              // run for two minutes, and a request the user stopped waiting for can
              // still spawn and spend quota.
              deadline: opts.deadline,
            }),
        },
        logger,
        req,
      );
      return run;
    });
  const resolveFn = deps.resolveModelFn ?? ((options) => resolveModel(options));

  const destinationFor = (index: number): string =>
    resolveOutputPath({
      outDir: deps.outDir,
      prompt: request.prompt,
      // Provisional: writeImage re-derives the extension from the sniffed bytes.
      format: request.format ?? "png",
      explicit: count === 1 ? request.outputPath : undefined,
      index,
      key,
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
      const materialised = await materialiseFromCache(hit, destinationFor(0), writeOptions);
      return finishFromCache(await withDimensions(materialised, hit.data), hit.entry);
    }

    // Second lookup, on the key the bytes were BANKED under. This is the recovery
    // half of the raw-bytes bank: the previous run paid for these pixels and then
    // failed in `sharp`, in `mkdir`, or on a full disk. Without this lookup the
    // retry looks like a plain miss and buys the same picture again.
    //
    // The raw key lives in its own namespace, so it can never equal `key` and the
    // bank can never be served as a finished image. Every request may have local
    // steps to re-apply, so the lookup is unconditional.
    const rawKey = rawCacheKey(request);
    const rawHit = await lookupCache(deps.stateDir, rawKey);
    if (rawHit) {
      logger.debug(`Raw-bytes hit for ${rawKey.slice(0, 12)}; re-processing locally, no quota spent.`);
      // The SAME function the fresh path uses. A recovered image and a freshly
      // generated one must be byte-identical, or the cache is lying about what it
      // holds.
      const bytes = await postProcess(rawHit.data, request, warnAlways);
      const artifact = await withDimensions(
        await writeImage(destinationFor(0), bytes, writeOptions),
        bytes,
      );
      // Index the processed result under the full key so the next run is a plain hit.
      await storeCache(deps.stateDir, key, artifact, bytes, provenanceOf(rawHit.entry));
      return finishFromCache(artifact, rawHit.entry);
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

  const slots = Array.from({ length: count }, (_, index) => index);
  const outcome = await mapWithConcurrency(slots, deps.concurrency ?? 2, async (index) => {
    // The budget starts HERE, not when the command was typed. The spec is explicit
    // that the timeout begins after slot acquisition, and mapWithConcurrency calls
    // this worker only once a permit is held. Each image gets its own deadline:
    // one shared deadline would charge image four for images one through three.
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
    // Read off THIS worker's result, never off a shared variable. Task 20 puts a
    // fallback chain behind `provider`, and a sibling worker that falls back to
    // exec while this one is awaiting sharp would otherwise relabel this image.
    const backend = result.backend ?? "codex-http";

    if (result.quota) {
      await saveQuota(join(deps.stateDir, "quota.json"), result.quota);
      if (shouldWarn(result.quota)) {
        warnAlways(formatQuota(result.quota));
      }
    }

    const raw = result.images[0];
    if (!raw) throw new OutputError("The backend returned no image data.");

    // Bank the paid bytes IMMEDIATELY, before any local step that can fail.

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
        { model: result.model, backend, effectivePrompt: result.effectivePrompt },
      ).catch((err: unknown) => {
        logger.debug(`Could not bank the raw bytes: ${String(err)}`);
      });
    }

    const bytes = await postProcess(raw, request, warnAlways);

    const artifact = await withDimensions(
      await writeImage(destinationFor(index), bytes, writeOptions),
      bytes,
    );
    await writeManifest(artifact.path, {
      prompt: request.prompt,
      effectivePrompt: result.effectivePrompt,
      model: result.model,
      backend,
      size: request.size,
      exactSize: request.exactSize,
      cacheKey: key,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      format: artifact.format,
    });

    // Only a single-image request has an unambiguous cache entry.
    //
    // Best effort, exactly like the raw bank above, and for a stronger reason: by
    // this line the image and its manifest are already on disk. An awaited throw
    // here would reject the worker and a one-image run would never print the path
    // to a file that exists — the caller loses an artifact they paid for because an
    // optimisation failed. It is also reachable by configuration rather than by
    // accident: cache blobs always publish with `overwrite: false`, which needs a
    // hard link, so a state directory on a filesystem without them fails here on
    // every single run. `--overwrite` does not help, because it applies to the
    // image, not to the blob.
    if (count === 1 && mayPublish) {
      await storeCache(deps.stateDir, key, artifact, bytes, {
        model: result.model,
        backend,
        effectivePrompt: result.effectivePrompt,
      }).catch((err: unknown) => {
        logger.warn(
          `The image was written, but it could not be added to the cache ` +
            `(${redact(err)}). The next identical request will regenerate it.`,
        );
      });
    }

    return { artifact, backend, model: result.model, effectivePrompt: result.effectivePrompt };
  });

  const produced = outcome.values;
  if (produced.length === 0) {
    // Nothing survived, so there is no partial result worth returning. Re-throw
    // the original error rather than inventing a generic one — the caller needs
    // to know whether this was ContentBlocked, a quota exhaustion, or a timeout.
    throw outcome.failure ?? new OutputError("The backend returned no image data.");
  }

  const failures = outcome.outcomes.flatMap((o) =>
    o.status === "rejected" ? [describeFailure(o.index, o.reason)] : [],
  );
  for (const failure of failures) {
    logger.warn(`Image ${failure.index + 1} of ${count} failed: ${failure.message}`);
  }

  const images: ImageArtifact[] = produced.map((p) => p.artifact);
  const backendUsed = produced[0]?.backend ?? "codex-http";
  const modelUsed = produced[0]?.model ?? resolved.slug;
  const effectivePrompt = produced[0]?.effectivePrompt ?? request.prompt;

  return {
    images,
    requested: count,
    ...(failures.length > 0 ? { failures } : {}),
    backend: backendUsed,
    model: modelUsed,
    cached: false,
    effectivePrompt,
    elapsedMs: Date.now() - startedAt,
  };
}

function describeFailure(index: number, reason: unknown): BatchFailure {
  return {
    index,
    kind: reason instanceof Error ? reason.constructor.name : "Error",
    // Redacted at the point the message stops being an exception and becomes data.
    // From here it travels into `--json` on stdout and onto stderr, and neither of
    // those goes through the logger, which is where redaction otherwise happens. An
    // upstream error body that echoed an Authorization header would be published
    // verbatim without this.
    message: redact(reason instanceof Error ? reason.message : reason),
  };
}
