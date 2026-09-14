import { dirname, join } from "node:path";
import { ConfigError, SubpixelError } from "../core/errors.js";
import { loadConfig } from "../config/load.js";
import { silentLogger, type Logger } from "../core/logger.js";
import { redact } from "../core/redact.js";
import type { BackendName } from "../core/types.js";
import type { SubpixelConfig } from "../config/schema.js";
import { generate, type ProviderFn } from "../engine/generate.js";
import { mapWithConcurrency } from "../engine/semaphore.js";
import { diskProbe, hasDrift, planAssets, type AssetProbe, type AssetStatus } from "./plan.js";
import type { LoadedAssets, ResolvedAsset } from "./load.js";

export interface SyncDeps {
  /** Regenerate everything, not only what drifted. */
  force?: boolean;
  /** Report the plan and stop. No provider call, no quota. */
  dryRun?: boolean;
  concurrency?: number;
  backend?: BackendName;
  allowPaid?: boolean;
  timeoutMs?: number;
  stallMs?: number;
  provider?: ProviderFn;
  probe?: AssetProbe;
  logger?: Logger;
  /**
   * Test seam. Left unset, the project config is discovered from the manifest's
   * directory, which is where the policy that governs this run actually lives.
   */
  configDir?: string;
  /** One line per event, for the human-readable report. */
  log?: (line: string) => void;
  warnAlways?: (message: string) => void;
}

export interface SyncFailure {
  id: string;
  message: string;
}

export interface SyncOutcome {
  statuses: AssetStatus[];
  /** Ids generated this run, in manifest order. */
  generated: string[];
  /** Ids that were already current. */
  skipped: string[];
  failures: SyncFailure[];
  drift: boolean;
  /**
   * The first real error object, when anything failed. NOT thrown from here.
   *
   * The caller needs both halves of a failed run: the structured report of what
   * did and did not happen, and the error whose `exitCode` the process must end
   * with. Throwing from this function gives up the first to deliver the second —
   * `--json` then writes nothing at all on exactly the runs a CI job most needs it
   * to write something. So the outcome is returned complete, and `runSync` prints
   * it and then throws this.
   *
   * Deliberately not part of the JSON document: it is an Error instance, and its
   * message is already in `failures`, redacted.
   */
  failure?: unknown;
}

const DEFAULT_CONCURRENCY = 2;

/**
 * Does this failure mean every remaining asset will fail the same way?
 *
 * An expired credential or a rate limit is a property of the account, not of the
 * prompt. Running the other forty assets into the same wall produces forty
 * identical errors and, for a rate limit, digs the hole deeper. A refused prompt
 * or a bad output path is per-asset, so the run continues.
 */
function isFatal(err: unknown): boolean {
  return err instanceof SubpixelError && (err.exitCode === 3 || err.exitCode === 4);
}

/** The flag, then the project config, and never the literal string "auto". */
function backendFor(deps: SyncDeps, config: SubpixelConfig): BackendName | undefined {
  if (deps.backend) return deps.backend;
  return config.backend && config.backend !== "auto" ? config.backend : undefined;
}

export async function syncAssets(loaded: LoadedAssets, deps: SyncDeps = {}): Promise<SyncOutcome> {
  const log = deps.log ?? (() => {});

  // Resolved ONCE, from the manifest's directory. `assets.yml` says what to
  // generate; `subpixel.config.json` says what this project is allowed to spend and
  // which backend it may spend it on. A sync that reads only the first obeys the
  // budget nowhere: `spx generate -n 5` is refused against `maxImagesPerRun: 2`
  // while `spx sync` on a forty-asset manifest sails straight past it.
  //
  // Discovery walks up from the manifest, not from the shell, for the same reason
  // the cache does: running `spx sync` from a subdirectory must not change policy.
  //
  // `spx sync --check` never reaches this function, so the zero-network, zero-read
  // guarantee of the check path is untouched.
  const { config } = await loadConfig({ cwd: deps.configDir ?? loaded.dir });

  const statuses = await planAssets(loaded.assets, deps.probe ?? diskProbe);
  const drift = hasDrift(statuses);

  const byId = new Map(loaded.assets.map((asset) => [asset.id, asset]));
  const pending: ResolvedAsset[] = [];
  const skipped: string[] = [];
  for (const status of statuses) {
    const asset = byId.get(status.id);
    if (!asset) continue;
    if (status.state === "current" && deps.force !== true) {
      skipped.push(status.id);
      continue;
    }
    pending.push(asset);
    log(redact(`${status.state === "missing" ? "missing" : "stale"}: ${status.id} → ${asset.out}`));
  }

  // Before the dry-run return, so `--dry-run` reports the refusal instead of
  // promising work that the real run would reject. And before any submission, which
  // is the only moment a spending limit can still do anything.
  const maxImages = config.budget?.maxImagesPerRun;
  if (maxImages !== undefined && pending.length > maxImages) {
    throw new ConfigError(
      `This sync would generate ${pending.length} images, which exceeds ` +
        `budget.maxImagesPerRun (${maxImages}) set in the project config. ` +
        "Raise the budget, or narrow the manifest.",
    );
  }

  if (deps.dryRun === true) {
    log(`${pending.length} to generate, ${skipped.length} up to date.`);
    return { statuses, generated: [], skipped, failures: [], drift };
  }

  // The cache lives beside the manifest, not beside the process working directory.
  // `spx sync` run from a subdirectory must hit the same cache as one run from the
  // repository root, or CI pays twice for the same picture.
  const stateDir = join(loaded.dir, ".subpixel");

  let fatal: unknown;
  const run = await mapWithConcurrency(
    pending,
    deps.concurrency ?? config.concurrency ?? DEFAULT_CONCURRENCY,
    async (asset) => {
      if (fatal !== undefined) throw fatal;
      try {
        await generate(asset.request, {
          outDir: dirname(asset.out),
          stateDir,
          logger: deps.logger ?? silentLogger,
          // The manifest declares this file as subpixel's. Writing a `-v2` sibling
          // here would leave the declared path holding a stale image forever, and
          // every template that references it would keep showing the old picture.
          overwrite: true,
          concurrency: 1,
          // `--force` means regenerate. Without this the forced run selects every
          // asset, calls the engine, and the engine serves the same cached bytes —
          // so the flag changes which assets are "processed" and nothing else.
          ...(deps.force === true ? { noCache: true } : {}),
          // Flag beats project config, exactly as in `runGenerate`. `config.backend`
          // may be "auto", which is the engine's own default, so it is passed only
          // when it names a real backend.
          ...(backendFor(deps, config) ? { backend: backendFor(deps, config)! } : {}),
          ...(deps.allowPaid === true || config.allowPaid === true ? { allowPaid: true } : {}),
          ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
          ...(deps.stallMs !== undefined ? { stallMs: deps.stallMs } : {}),
          ...(deps.provider ? { provider: deps.provider } : {}),
          ...(deps.warnAlways ? { warnAlways: deps.warnAlways } : {}),
        });
        log(redact(`wrote ${asset.out}`));
        return asset.id;
      } catch (err) {
        if (isFatal(err)) fatal = err;
        throw err;
      }
    },
    // Each asset is a different picture, so one refusal says nothing about the
    // next. `isFatal` handles the account-wide failures that DO say something.
    { stopOnError: false },
  );

  const generated: string[] = [];
  const failures: SyncFailure[] = [];
  for (const outcome of run.outcomes) {
    const asset = pending[outcome.index];
    if (!asset) continue;
    if (outcome.status === "fulfilled") generated.push(asset.id);
    else if (outcome.status === "rejected") {
      failures.push({
        id: asset.id,
        message: redact(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)),
      });
    }
  }

  if (run.failure !== undefined) {
    log(`${generated.length} generated, ${failures.length} failed, ${skipped.length} up to date.`);
    // Returned, not thrown. `run.failure` is the real error object — bin.ts reads
    // `exitCode` off it, and a wrapped Error would collapse every sync failure back
    // to exit 1 — but throwing it here would take the report down with it.
    return { statuses, generated, skipped, failures, drift, failure: run.failure };
  }

  log(`${generated.length} generated, ${skipped.length} up to date.`);
  return { statuses, generated, skipped, failures, drift };
}
