import { ConfigError } from "../core/errors.js";

export type Release = () => void;

export interface Semaphore {
  acquire(): Promise<Release>;
  inFlight(): number;
}

/**
 * A minimal counting semaphore.
 *
 * Each release closure is single-use. Without that guard a caller that releases
 * twice permanently raises the effective limit, which surfaces much later as an
 * unexplained burst of concurrent requests against the subscription endpoint.
 */
export function createSemaphore(limit: number): Semaphore {
  if (!Number.isFinite(limit) || limit < 1) {
    throw new ConfigError(`Concurrency limit must be at least 1, received ${limit}.`);
  }

  let active = 0;
  const waiters: Array<(release: Release) => void> = [];

  function makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next) {
        // Hand the permit straight over; active stays the same.
        next(makeRelease());
        return;
      }
      active -= 1;
    };
  }

  return {
    acquire(): Promise<Release> {
      if (active < limit) {
        active += 1;
        return Promise.resolve(makeRelease());
      }
      return new Promise<Release>((resolve) => {
        waiters.push(resolve);
      });
    },
    inFlight(): number {
      return active;
    },
  };
}

/** What happened to one input item. */
export type Outcome<R> =
  | { readonly status: "fulfilled"; readonly index: number; readonly value: R }
  | { readonly status: "rejected"; readonly index: number; readonly reason: unknown }
  | { readonly status: "skipped"; readonly index: number };

export interface MapOutcome<R> {
  /** One entry per input, in input order. */
  readonly outcomes: readonly Outcome<R>[];
  /** The fulfilled values, in input order. Shorter than `outcomes` after a failure. */
  readonly values: readonly R[];
  /** The first rejection to occur, or `undefined` when every item succeeded. */
  readonly failure: unknown;
}

export interface MapOptions {
  /**
   * Stop calling the worker once any item has failed. Default true.
   *
   * Set false only when the items are independent and cheap. For image generation
   * they are neither: each one spends subscription quota, so a batch that has
   * already failed should not keep spending.
   */
  stopOnError?: boolean;
}

/**
 * Run `worker` over `items` with at most `limit` calls in flight.
 *
 * This deliberately does not use `Promise.all`'s reject-early behaviour. That
 * combination is actively harmful here: the rejection escapes immediately while
 * the failed task's own `release()` admits the next queued task, so the caller
 * sees an error *and* the batch keeps spending quota in the background, with
 * every already-generated image thrown away.
 *
 * Instead each task resolves to an `Outcome`, so the returned promise settles only
 * after every started worker has settled, and the caller gets the partial results.
 * The failure gate is checked after the permit is granted rather than before the
 * task is created: a queued task that wakes up into a failed batch never calls the
 * worker at all.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: MapOptions = {},
): Promise<MapOutcome<R>> {
  // Validate before the empty-input shortcut. Otherwise a bad --concurrency stays
  // invisible until the first run that actually has work to do.
  const sem = createSemaphore(limit);
  if (items.length === 0) return { outcomes: [], values: [], failure: undefined };

  const stopOnError = options.stopOnError !== false;
  let failed = false;
  let failure: unknown;

  const outcomes = await Promise.all(
    items.map(async (item, index): Promise<Outcome<R>> => {
      const release = await sem.acquire();
      try {
        if (failed && stopOnError) return { status: "skipped", index };
        return { status: "fulfilled", index, value: await worker(item, index) };
      } catch (err) {
        if (!failed) {
          failed = true;
          failure = err;
        }
        return { status: "rejected", index, reason: err };
      } finally {
        // Runs after the catch above, so the next waiter observes the gate.
        release();
      }
    }),
  );

  const values = outcomes.flatMap((o) => (o.status === "fulfilled" ? [o.value] : []));
  return { outcomes, values, failure };
}
