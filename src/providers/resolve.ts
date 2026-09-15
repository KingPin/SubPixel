import { ConfigError, SubpixelError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { BackendName, GenerateRequest } from "../core/types.js";
import type { ProviderResult } from "./codex-http.js";

export const DEFAULT_CHAIN: BackendName[] = ["codex-http", "codex-exec"];

export interface ChainOptions {
  hasCodexBinary: boolean;
  requested?: BackendName;
}

/**
 * Decide which backends may run, in order.
 *
 * "api" is the paid OpenAI API. No provider implements it yet, so it is
 * refused here rather than further down, where a missing runner reads as an
 * internal bug. This function is the one chokepoint every caller routes
 * through — CLI, project config, sync and the library — so the refusal cannot
 * be walked around by setting a config key.
 */
export function resolveChain(options: ChainOptions): BackendName[] {
  if (options.requested) {
    if (options.requested === "api") {
      throw new ConfigError(
        "The api backend is not implemented yet. Use codex-http or codex-exec.",
      );
    }
    if (options.requested === "codex-exec" && !options.hasCodexBinary) {
      throw new ConfigError(
        "The codex-exec backend needs the codex binary on PATH. Install Codex CLI or use --backend codex-http.",
      );
    }
    return [options.requested];
  }

  return DEFAULT_CHAIN.filter((name) => name !== "codex-exec" || options.hasCodexBinary);
}

export type BackendRunner = (request: GenerateRequest) => Promise<ProviderResult>;
export type BackendRunners = Partial<Record<BackendName, BackendRunner>>;

export interface ResolvedRun extends ProviderResult {
  backend: BackendName;
}

/**
 * Run the chain, stopping at the first success.
 *
 * The fallback gate is `error.canFallback`, and nothing else. That getter is
 * derived, not hand-set: it is true only when `submission === "not-submitted"`
 * AND another backend could plausibly do better. So the question it answers is
 * "did this failure provably happen before the request reached the model?", and
 * a retry can never be charged twice.
 *
 * Three classes are worth naming. StreamAborted is `"submitted"` — it may have
 * already produced a billed image. SubmissionUncertain is `"uncertain"`, and it
 * is what `classifyFetchError` returns for any transport failure it does not
 * recognise as pre-submit; uncertain is treated exactly like submitted here,
 * because guessing in the user's disfavour is the only safe guess. RateLimited
 * is not-submitted but sets `fallbackUseful` to false: the next backend shares
 * the same subscription, so it will only fail again.
 *
 * An error that is not a SubpixelError is a bug in this program, not a backend
 * condition. It is rethrown untouched so it stays visible.
 *
 * **Which error escapes when every backend fails.** The LAST one, not the first.
 * This is a safety property, not a cosmetic choice. The caller above this function
 * is `callWithModelRecovery`, which re-runs this entire chain on the next model
 * when it catches `ModelUnavailable`. If HTTP fails with `ModelUnavailable` and
 * exec then fails with `SubmissionUncertain`, reporting the FIRST error hands the
 * recovery loop a not-submitted verdict that the second backend has already
 * disproved — and the loop runs exec again on model B, submitting twice.
 *
 * The last error is the only one describing the state the process actually ended
 * in. `mergeAttempts` keeps the earlier messages in `cause` so no diagnosis is
 * lost; only the retry verdict changes.
 */
export async function runWithFallback(
  chain: readonly BackendName[],
  runners: BackendRunners,
  logger: Logger,
  request: GenerateRequest = { prompt: "" },
): Promise<ResolvedRun> {
  if (chain.length === 0) {
    throw new ConfigError("No usable backend. Run `spx doctor` to see what is missing.");
  }

  const attempts: { backend: BackendName; error: unknown }[] = [];

  for (let index = 0; index < chain.length; index += 1) {
    const name = chain[index]!;
    const runner = runners[name];
    if (!runner) {
      throw new ConfigError(`No runner registered for backend "${name}".`);
    }

    try {
      const result = await runner(request);
      return { ...result, backend: name };
    } catch (error) {
      attempts.push({ backend: name, error });

      if (!(error instanceof SubpixelError)) throw error;
      if (!error.canFallback) throw error;

      const next = chain[index + 1];
      if (!next) break;
      logger.warn(
        `Backend "${name}" failed before the request was submitted (${error.code}). Trying "${next}".`,
      );
    }
  }

  throw mergeAttempts(attempts);
}

/**
 * Report the final state of the chain, keeping the earlier ones as `cause`.
 *
 * The returned error is the LAST attempt's, so its `submission` describes where
 * the process actually stopped. Chaining the earlier attempts through `cause`
 * means `spx --verbose` can still print why each backend was abandoned.
 */
function mergeAttempts(attempts: readonly { backend: BackendName; error: unknown }[]): unknown {
  const last = attempts.at(-1);
  if (!last) {
    return new ConfigError("No usable backend. Run `spx doctor` to see what is missing.");
  }
  if (attempts.length === 1 || !(last.error instanceof SubpixelError)) return last.error;

  const trail = attempts
    .slice(0, -1)
    .map((a) => `${a.backend}: ${a.error instanceof Error ? a.error.message : String(a.error)}`)
    .join("; ");
  // Attach, do not replace. Overwriting an existing cause would hide the real
  // transport failure underneath a summary string.
  if (last.error.cause === undefined) {
    Object.defineProperty(last.error, "cause", {
      value: new Error(`Earlier backends also failed — ${trail}`),
      configurable: true,
      writable: true,
    });
  }
  return last.error;
}
