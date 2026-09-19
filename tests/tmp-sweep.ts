import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapWithConcurrency } from "../src/engine/semaphore.js";

/**
 * The prefix every temp directory in this suite is created with.
 *
 * 31 test files call `mkdtemp(join(tmpdir(), "subpixel-<something>-"))`. The
 * shared `subpixel-` head is what makes one sweep possible, so a new test file
 * that invents its own prefix leaks again — name it `subpixel-` too.
 */
const PREFIX = "subpixel-";

/**
 * Delete the temp directories the suite created, and report how many went.
 *
 * `mkdtemp` has no owner and no lifetime: whoever makes the directory has to
 * remove it, and almost none of the 31 callers here do. Left alone the suite
 * writes hundreds of megabytes per run into `/tmp` and never takes any of it
 * back — on a tmpfs that is RAM, and a day of runs filled a 14 GB `/tmp`
 * completely, at which point every process on the machine that wanted a temp
 * file started failing.
 *
 * Sweeping once at the end beats an `afterEach` in each file: it is one place
 * instead of 31, and it cannot be forgotten by the next test file added. It also
 * sweeps by name rather than by what this run made, so the leftovers of a run
 * that was killed before its teardown are collected by the run after it.
 *
 * Only directories are removed, and only ones sitting directly in `root` whose
 * name starts with the prefix. A symlink is not a directory by this test, so a
 * planted `subpixel-` link is skipped rather than followed.
 *
 * ponytail: a second suite running against the same `/tmp` at the same time
 * would have its directories swept out from under it. Give the prefix a
 * per-run suffix if concurrent local runs ever become a real workflow.
 */
export async function sweepTempDirs(root: string = tmpdir()): Promise<number> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // No temp root, or not readable. There is nothing to clean and failing the
    // whole run over the cleanup step would be worse than leaking.
    return 0;
  }

  const stale = entries.filter((e) => e.isDirectory() && e.name.startsWith(PREFIX));

  // stopOnError: false, because the directories are independent. One that
  // cannot be removed — a race with a still-exiting worker, a permission
  // oddity — must not leave the other few thousand on disk.
  const { values } = await mapWithConcurrency(
    stale,
    16,
    async (entry) => {
      await rm(join(root, entry.name), { recursive: true, force: true });
    },
    { stopOnError: false },
  );

  return values.length;
}

/**
 * Vitest's global teardown hook, wired up in `vitest.config.ts`.
 *
 * Vitest has no `globalTeardown` option; the `teardown` export of a
 * `globalSetup` file is the hook, which is why this file is listed there and
 * exports no `setup`.
 */
export async function teardown(): Promise<void> {
  await sweepTempDirs();
}
