#!/usr/bin/env node
import { exitCodeFor, ignoreEpipe, messageFor } from "./exit.js";
import { main } from "./index.js";

// Before anything writes. `spx ... | head -1` closes the pipe under us, and the
// handler has to already be attached when the write that notices lands.
ignoreEpipe(process.stdout);
ignoreEpipe(process.stderr);

// No guard. This file exists only to be executed, so there is no condition here
// that could wrongly decide not to run — and because it always runs, nothing may
// import it. Everything a test needs is in ./exit.js.
main().catch((err: unknown) => {
  process.stderr.write(`spx: ${messageFor(err)}\n`);
  process.exitCode = exitCodeFor(err);
});
