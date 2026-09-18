import { SubpixelError } from "../core/errors.js";
import { redact } from "../core/redact.js";

/**
 * The spec's taxonomy table, read off the error itself.
 *
 * `{ exitCode: 99 }` from a library that is not ours must NOT be trusted — the
 * instanceof check is what makes this a taxonomy rather than a duck-typed contract
 * any dependency could reach into.
 */
export function exitCodeFor(err: unknown): number {
  return err instanceof SubpixelError ? err.exitCode : 1;
}

export function messageFor(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}

/**
 * Let a reader that stopped reading end this process quietly.
 *
 * `spx generate ... | head -1` closes the pipe as soon as `head` has its line. The
 * next write raises an `error` event on the stream, and an `error` event with no
 * listener is an uncaught exception: a stack trace on stderr and exit 1, for a run
 * that had already written the image and printed its path. The downstream `head` is
 * not this process's failure.
 *
 * Only EPIPE. Anything else on the stream is still ours, and re-throwing it here
 * leaves it exactly as loud as it was before this function existed.
 */
export function ignoreEpipe(stream: NodeJS.EventEmitter): void {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") throw err;
  });
}
