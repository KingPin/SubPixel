import { resolve } from "node:path";
import { ASSETS_FILENAME, loadAssets } from "../assets/load.js";
import { syncAssets, type SyncOutcome } from "../assets/sync.js";
import { logLevelFor } from "./generate.js";
import { createLogger } from "../core/logger.js";
import { redact } from "../core/redact.js";
import type { BackendName } from "../core/types.js";

export interface SyncOptions {
  file?: string;
  force?: boolean;
  dryRun?: boolean;
  concurrency?: string;
  backend?: BackendName;
  allowPaid?: boolean;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

export async function runSync(options: SyncOptions): Promise<void> {
  const path = resolve(options.file ?? ASSETS_FILENAME);
  const warn = (message: string) => process.stderr.write(`spx: ${message}\n`);
  const loaded = await loadAssets(path, warn);

  const outcome = await syncAssets(loaded, {
    force: options.force === true,
    dryRun: options.dryRun === true,
    ...(options.concurrency ? { concurrency: Number(options.concurrency) } : {}),
    ...(options.backend ? { backend: options.backend } : {}),
    ...(options.allowPaid === true ? { allowPaid: true } : {}),
    // Same three-way rule `runGenerate` uses. `logLevelFor` takes only `quiet` and
    // `verbose`, so it reads `SyncOptions` without a cast.
    logger: createLogger({ level: logLevelFor(options) }),
    // --json must leave stdout holding exactly one JSON document, so progress goes
    // to stderr in that mode rather than being suppressed.
    log: options.json === true ? warn : options.quiet === true ? undefined : (line) => process.stdout.write(`${line}\n`),
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
