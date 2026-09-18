#!/usr/bin/env node
import { exitCodeFor, ignoreEpipe, messageFor } from "./exit.js";
import { main } from "./index.js";

// Before anything writes. `spx ... | head -1` closes the pipe under us, and the
// handler has to already be attached when the write that notices lands.
//
// Both streams, deliberately. `spx generate ... 2>&1 | head -1` is one pipe wearing
// two file descriptors, so when `head` leaves, the progress lines on stderr raise
// EPIPE exactly as the path on stdout does -- and an unguarded stderr turns a run
// that finished into a stack trace and exit 1. Guarding stdout alone silences the
// half that was never the loud one. Nor is anything lost by guarding stderr: EPIPE
// there means the reader of our diagnostics has already gone, so the crash reports
// the failure to nobody and corrupts the exit code on the way.
ignoreEpipe(process.stdout);
ignoreEpipe(process.stderr);

// No guard. This file exists only to be executed, so there is no condition here
// that could wrongly decide not to run — and because it always runs, nothing may
// import it. Everything a test needs is in ./exit.js.
main().catch((err: unknown) => {
  process.stderr.write(`spx: ${messageFor(err)}\n`);
  process.exitCode = exitCodeFor(err);
});
