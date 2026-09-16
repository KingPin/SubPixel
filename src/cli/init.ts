import { applyInit, formatInitPlan, planInit } from "../install/init.js";

export interface InitCliOptions {
  dryRun?: boolean;
  force?: boolean;
  global?: boolean;
  only?: string;
}

/** `--only claude-mcp,cursor` — a comma list, because commander gives us one string. */
function parseOnly(only: string | undefined): string[] {
  return (only ?? "")
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
  // A conflict is the one outcome that needs the user to do something, so it is the
  // one outcome that must not exit 0 into a script that assumes success.
  if (plan.some((target) => target.state === "conflict")) process.exitCode = 2;
}
