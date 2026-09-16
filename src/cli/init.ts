import { applyInit, formatInitPlan, planInit } from "../install/init.js";

export interface InitCliOptions {
  dryRun?: boolean;
  force?: boolean;
  global?: boolean;
  only?: string;
}

/**
 * `--only claude-mcp,cursor` — a comma list, because commander gives us one string.
 *
 * An absent flag and an empty one are different answers and must stay that way.
 * `undefined` is "you did not choose", `[]` is "you chose nothing" — and `--only ''`
 * or `--only ,` collapsing into the default set would widen the run to every target
 * on the strength of a typo.
 */
function parseOnly(only: string | undefined): string[] | undefined {
  if (only === undefined) return undefined;
  return only
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
}

export async function runInit(options: InitCliOptions = {}): Promise<void> {
  const plan = await planInit({
    force: options.force,
    global: options.global,
    only: parseOnly(options.only),
  });
  if (!options.dryRun) await applyInit(plan);
  process.stdout.write(`${formatInitPlan(plan, options.dryRun === true)}\n`);
  // A conflict and a stale target are the outcomes that need the user to do something
  // — clear the file, or run again — so they are the ones that must not exit 0 into a
  // script that assumes success. Every other state is a finished answer.
  if (plan.some((target) => target.state === "conflict" || target.state === "stale")) {
    process.exitCode = 2;
  }
}
