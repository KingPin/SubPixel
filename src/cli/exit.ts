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
