import { applyInit, formatInitPlan, planInit } from "../install/init.js";

export interface InitCliOptions {
  dryRun?: boolean;
  force?: boolean;
}

export async function runInit(options: InitCliOptions = {}): Promise<void> {
  const plan = await planInit({ force: options.force });
  if (!options.dryRun) await applyInit(plan);
  process.stdout.write(`${formatInitPlan(plan, options.dryRun === true)}\n`);
  // A conflict is the one outcome that needs the user to do something, so it is the
  // one outcome that must not exit 0 into a script that assumes success.
  if (plan.some((target) => target.state === "conflict")) process.exitCode = 2;
}
