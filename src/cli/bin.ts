#!/usr/bin/env node
import { main } from "./index.js";

// No guard. This file exists only to be executed, so there is no condition here
// that could wrongly decide not to run. See Task 8's note on entry-point guards.
main().catch((err: unknown) => {
  process.stderr.write(`spx: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
