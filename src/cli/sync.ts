import { resolve } from "node:path";
import { ASSETS_FILENAME, loadAssets } from "../assets/load.js";
import { syncAssets, type SyncOutcome } from "../assets/sync.js";
import { logLevelFor } from "./generate.js";
import { createLogger } from "../core/logger.js";
import { redact } from "../core/redact.js";
import { ConfigError, DriftDetected } from "../core/errors.js";
import { parseBackend, parseCount } from "./options.js";
import { diskProbe, hasDrift, planAssets, type AssetProbe, type AssetStatus } from "../assets/plan.js";
import type { ProviderFn } from "../engine/generate.js";
import type { LoadedAssets } from "../assets/load.js";

export interface SyncOptions {
  file?: string;
  force?: boolean;
  dryRun?: boolean;
  concurrency?: string;
  backend?: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  check?: boolean;
  /** Test seam only. The CLI never sets this; `--check` must never read it. */
  provider?: ProviderFn;
}

export function formatDriftReport(statuses: readonly AssetStatus[]): string {
  return statuses
    .filter((status) => status.state !== "current")
    .map((status) => `${status.state}: ${status.id} — ${status.reason}`)
    .join("\n");
}

/**
 * The CI gate. Reads the manifests and compares. It does NOT throw on drift.
 *
 * There is no provider parameter and no generation deps anywhere in this function.
 * That absence is the feature: a build running this on every pull request must not
 * be able to spend a developer's subscription quota, and the cheapest way to
 * guarantee that is to give the code path nothing to spend it with.
 */
export async function checkAssets(
  loaded: LoadedAssets,
  probe: AssetProbe = diskProbe,
): Promise<AssetStatus[]> {
  // `verify` here and nowhere else. A check's whole output is the word "current",
  // so it is the run that has to have read the files back.
  return planAssets(loaded.assets, probe, { verify: true });
}

/**
 * The error for a drifted result, or `undefined` when everything is current.
 *
 * Separate from `checkAssets` so the caller can write the report FIRST and throw
 * second. Throwing from inside the check is what made `--check --json` emit
 * nothing at all on drift: the JSON document is written after the check returns,
 * and on the only run where a CI job needs to read it, the check never returned.
 * An exit code says that something is wrong; the document says what.
 */
export function driftError(statuses: readonly AssetStatus[]): DriftDetected | undefined {
  if (!hasDrift(statuses)) return undefined;
  const drifted = statuses.filter((status) => status.state !== "current");
  // Every `reason` was redacted by the planner, so the joined message is safe to
  // print into a public CI log.
  return new DriftDetected(
    `${drifted.length} of ${statuses.length} assets are out of date. Run \`spx sync\`.\n${formatDriftReport(statuses)}`,
  );
}

export async function runSync(options: SyncOptions): Promise<void> {
  const path = resolve(options.file ?? ASSETS_FILENAME);
  const warn = (message: string) => process.stderr.write(`spx: ${message}\n`);
  const loaded = await loadAssets(path, warn);

  if (options.check === true) {
    if (options.force === true) {
      throw new ConfigError("--check reports drift and --force regenerates. Pass one or the other.");
    }
    const statuses = await checkAssets(loaded);
    const drift = driftError(statuses);

    // Report first, on BOTH paths. stdout carries the machine-readable answer;
    // stderr carries the human one, so `--json` leaves stdout holding exactly one
    // document whether or not anything drifted.
    if (options.json === true) {
      process.stdout.write(
        redact(`${JSON.stringify({ drift: drift !== undefined, statuses }, null, 2)}\n`),
      );
      if (drift) warn(formatDriftReport(statuses));
    } else if (drift) {
      warn(formatDriftReport(statuses));
    } else if (options.quiet !== true) {
      process.stdout.write(`${statuses.length} assets are up to date.\n`);
    }

    // And only now the exit code.
    if (drift) throw drift;
    return;
  }

  const concurrency = parseCount(options.concurrency, "--concurrency");
  const backend = parseBackend(options.backend);

  const outcome = await syncAssets(loaded, {
    force: options.force === true,
    dryRun: options.dryRun === true,
    // Parsed with the same helpers `generate` uses, not read raw. `Number("1.5")`
    // reaches the semaphore and admits two workers while `active < 1.5`, and the
    // literal "auto" is a truthy string the runner registry has no entry for.
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(backend ? { backend } : {}),
    // Same three-way rule `runGenerate` uses. `logLevelFor` takes only `quiet` and
    // `verbose`, so it reads `SyncOptions` without a cast.
    logger: createLogger({ level: logLevelFor(options) }),
    // --json must leave stdout holding exactly one JSON document, so progress goes
    // to stderr in that mode rather than being suppressed.
    log: options.json === true ? warn : options.quiet === true ? undefined : (line) => process.stdout.write(`${line}\n`),
    ...(options.provider ? { provider: options.provider } : {}),
    warnAlways: warn,
  });

  emitSync(outcome, options.json === true);

  // After the report, never instead of it. `syncAssets` returns the failure rather
  // than throwing precisely so this order is possible: the JSON document and the
  // per-asset lines are the output the user asked for, and the exit code is a
  // separate promise made to the shell. Throwing the ORIGINAL error is what keeps
  // `bin.ts`'s taxonomy working — a wrapper would turn every sync failure into 1.
  if (outcome.failure !== undefined) throw outcome.failure;
}

/**
 * Write the run's result, in whichever form was asked for.
 *
 * `failure` is dropped: it is an Error instance, not data, and its message is
 * already in `failures` — redacted, which an Error's own `message` is not.
 *
 * The whole document goes through `redact()`, not just the prompts. Statuses carry
 * `out` paths and `key` hashes, and a path is a string a user composed: an output
 * directory under `/home/someone/work/client-acme/` or a filename a credential was
 * pasted into is exactly the kind of thing that must not be published to a CI log
 * because this particular field was not on the list of fields we remembered to
 * redact. Redacting the serialised document redacts every field there will ever be.
 */
function emitSync(outcome: SyncOutcome, json: boolean): void {
  if (!json) return;
  const { failure: _failure, ...report } = outcome;
  process.stdout.write(redact(`${JSON.stringify(report, null, 2)}\n`));
}
