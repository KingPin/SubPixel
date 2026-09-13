import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../core/logger.js";

export interface ReasoningLevel {
  effort: string;
  description?: string;
}

/**
 * One entry from ~/.codex/models_cache.json.
 *
 * `supported_reasoning_levels` holds objects, not strings. This was verified
 * against the live cache on 2026-09-12; a naive `includes("low")` silently
 * matches nothing.
 */
export interface ModelDescriptor {
  slug: string;
  visibility?: string;
  priority?: number;
  default_reasoning_level?: string;
  supported_reasoning_levels?: ReasoningLevel[];
}

export interface ModelCache {
  fetched_at?: string;
  etag?: string;
  client_version?: string;
  models: ModelDescriptor[];
}

/**
 * The last-resort list, used when no cache exists and the network is unavailable.
 * These slugs are only starting points — a wrong guess produces a ModelRejected
 * that the caller recovers from by advancing to the next candidate.
 */
export const BUNDLED_MODELS: ModelDescriptor[] = [
  { slug: "gpt-5.6-sol", visibility: "list", priority: 10, supported_reasoning_levels: [{ effort: "low" }] },
  { slug: "gpt-5.6-terra", visibility: "list", priority: 20, supported_reasoning_levels: [{ effort: "low" }] },
  { slug: "gpt-5.5", visibility: "list", priority: 40, supported_reasoning_levels: [{ effort: "low" }] },
];

export function modelCachePath(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const codexHome = env.CODEX_HOME;
  if (codexHome) return join(codexHome, "models_cache.json");
  return join(env.HOME ?? homedir(), ".codex", "models_cache.json");
}

/** Total by construction: `loadModelCache` rejects a descriptor whose levels are not
 * a list of objects, and `BUNDLED_MODELS` is a literal. */
function supportsLow(model: ModelDescriptor): boolean {
  return (model.supported_reasoning_levels ?? []).some((level) => level.effort === "low");
}

/**
 * Rank the models we are willing to drive the image tool with.
 *
 * Low reasoning effort is preferred because the driver model's only job is to call
 * the image tool. Extra deliberation costs latency and quota without improving the
 * picture.
 */
export function orderCandidates(models: ModelDescriptor[]): ModelDescriptor[] {
  return models
    .filter((model) => model.visibility === "list")
    .slice()
    .sort((a, b) => {
      const lowDelta = Number(supportsLow(b)) - Number(supportsLow(a));
      if (lowDelta !== 0) return lowDelta;
      return (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER);
    });
}

/**
 * A descriptor we can actually sort and send.
 *
 * This file is written by another program. "Valid JSON with a non-empty `models`
 * array" says nothing about what is IN the array, and a cast does not check: an
 * entry of `null` reaches `orderCandidates()` and throws `TypeError` on
 * `.visibility`, and a `supported_reasoning_levels` that is not an array — or that
 * holds a `null` — throws inside the sort comparator. That exception escapes
 * `resolveModel()`, which every one of `generate`, `doctor`, `models`, and
 * `--dry-run` calls, so one malformed line in someone else's cache file takes out
 * the whole tool instead of falling back to the bundled list it promises.
 *
 * Every field the ordering touches is checked here, so `orderCandidates` and
 * `supportsLow` can stay total.
 */
function isUsableDescriptor(value: unknown): value is ModelDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const model = value as Record<string, unknown>;
  if (typeof model.slug !== "string" || model.slug.length === 0) return false;
  if (model.priority !== undefined && typeof model.priority !== "number") return false;
  const levels = model.supported_reasoning_levels;
  if (levels === undefined) return true;
  return (
    Array.isArray(levels) &&
    levels.every((level) => typeof level === "object" && level !== null)
  );
}

export async function loadModelCache(
  path: string = modelCachePath(),
): Promise<ModelCache | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  // Drop the bad entries rather than the whole file: one unreadable descriptor
  // among ten good ones is not a reason to ignore the other nine. If nothing
  // usable survives, this is a miss and the caller reaches the bundled list.
  const cache = parsed as Partial<ModelCache>;
  const models = Array.isArray(cache.models) ? cache.models.filter(isUsableDescriptor) : [];
  if (models.length === 0) return undefined;
  return { ...cache, models };
}

export interface ResolveModelOptions {
  /** An explicit --model flag or config pin. Wins over everything. */
  override?: string;
  cachePath?: string;
  /** Cache entries older than this are used but reported as stale. Default 24h. */
  maxAgeMs?: number;
  logger?: Logger;
}

export interface ResolvedModel {
  slug: string;
  source: "override" | "cache" | "stale-cache" | "bundled";
  /** The ordered fallback list, so a ModelUnavailable can advance to the next entry. */
  candidates: ModelDescriptor[];
  fetchedAt?: string;
  /** True when the on-disk cache is older than `maxAgeMs`. Surfaced by `spx doctor`. */
  stale: boolean;
}

/** 24 hours, matching the design spec's refresh interval. */
export const MODEL_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isCacheStale(fetchedAt: string | undefined, maxAgeMs: number): boolean {
  if (!fetchedAt) return true;
  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) return true;
  return Date.now() - at > maxAgeMs;
}

/**
 * Pick a driver model. This never prompts. Interactive selection belongs to
 * `spx init` alone.
 *
 * **Two layers, not three.** The design spec describes a middle layer that refreshes
 * a stale cache with `GET /models` and an `If-None-Match` header. That endpoint's URL
 * and response schema are open item 1 in the spec: they need one live capture, which
 * has not happened. Implementing a guess would be worse than not implementing it —
 * a wrong URL turns every stale cache into an extra failed round-trip before falling
 * back to the bundled list anyway.
 *
 * So M0-M3 ship the on-disk cache and the bundled list, and staleness is *reported*
 * rather than acted on: `resolveModel` marks the result stale, `spx doctor` tells the
 * user to run any `codex` command to let the CLI refresh its own cache, and
 * `spx models` shows the cache age. Wiring the refresh is a follow-on task gated on
 * that capture. Do not silently present this as implemented.
 */
export async function resolveModel(options: ResolveModelOptions = {}): Promise<ResolvedModel> {
  if (options.override) {
    return {
      slug: options.override,
      source: "override",
      candidates: [{ slug: options.override, visibility: "list", priority: 0 }],
      stale: false,
    };
  }

  const maxAgeMs = options.maxAgeMs ?? MODEL_CACHE_MAX_AGE_MS;
  const cache = await loadModelCache(options.cachePath ?? modelCachePath());
  if (cache) {
    const candidates = orderCandidates(cache.models);
    const first = candidates[0];
    if (first) {
      const stale = isCacheStale(cache.fetched_at, maxAgeMs);
      if (stale) {
        options.logger?.debug(
          `The Codex model cache was written ${cache.fetched_at ?? "at an unknown time"} and ` +
            "is older than 24h. Using it anyway; run any `codex` command to let the CLI " +
            "refresh it.",
        );
      }
      return {
        slug: first.slug,
        source: stale ? "stale-cache" : "cache",
        candidates,
        fetchedAt: cache.fetched_at,
        stale,
      };
    }
  }

  const candidates = orderCandidates(BUNDLED_MODELS);
  const first = candidates[0] ?? BUNDLED_MODELS[0]!;
  return { slug: first.slug, source: "bundled", candidates, stale: true };
}

/** The next candidate after `slug`, for advance-and-warn recovery from a ModelUnavailable. */
export function advancePast(
  candidates: ModelDescriptor[],
  slug: string,
): ModelDescriptor | undefined {
  const index = candidates.findIndex((model) => model.slug === slug);
  if (index < 0) return undefined;
  return candidates[index + 1];
}
