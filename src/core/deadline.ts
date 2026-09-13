export class DeadlineExceeded extends Error {
  constructor(readonly label: string, readonly totalMs: number) {
    super(`Timed out after ${totalMs} ms while ${label}.`);
    this.name = "DeadlineExceeded";
  }
}

export interface Deadline {
  /** Abort signal wired to the deadline. Pass this to every fetch. */
  readonly signal: AbortSignal;
  /** Total budget in milliseconds. */
  readonly totalMs: number;
  /** Milliseconds left, floored at zero. */
  readonly remainingMs: number;
  readonly expired: boolean;
  /** Begin counting. Idempotent; a second call is ignored. */
  start(): void;
  /** Reject with DeadlineExceeded when the budget runs out first. */
  race<T>(work: Promise<T>, label: string): Promise<T>;
  /** A tighter sub-budget that can never outlive this one. */
  child(ms: number, label?: string): Deadline;
  /** Release the underlying timer. Safe to call more than once. */
  dispose(): void;
}

export interface DeadlineOptions {
  /**
   * When false, the clock does not run until start() is called. Use this to
   * create the budget before queueing for a concurrency slot and start it after
   * the slot is acquired, so a busy machine does not manufacture timeouts.
   */
  autoStart?: boolean;
  label?: string;
  /** Aborting this also aborts the deadline. Used by child(). */
  parent?: AbortSignal;
}

export function createDeadline(totalMs: number, options: DeadlineOptions = {}): Deadline {
  const controller = new AbortController();
  const label = options.label ?? "waiting";
  let startedAt: number | undefined;
  let timer: NodeJS.Timeout | undefined;
  let expired = false;

  const fire = (): void => {
    expired = true;
    controller.abort(new DeadlineExceeded(label, totalMs));
  };

  const start = (): void => {
    if (startedAt !== undefined) return;
    startedAt = Date.now();
    timer = setTimeout(fire, totalMs);
    timer.unref?.();
  };

  if (options.parent) {
    if (options.parent.aborted) fire();
    else options.parent.addEventListener("abort", fire, { once: true });
  }

  if (options.autoStart !== false) start();

  const deadline: Deadline = {
    signal: controller.signal,
    totalMs,
    get remainingMs() {
      if (startedAt === undefined) return totalMs;
      return Math.max(0, totalMs - (Date.now() - startedAt));
    },
    get expired() {
      return expired || controller.signal.aborted;
    },
    start,
    async race<T>(work: Promise<T>, raceLabel: string): Promise<T> {
      if (deadline.expired) throw new DeadlineExceeded(raceLabel, totalMs);
      return await new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(new DeadlineExceeded(raceLabel, totalMs));
        if (controller.signal.aborted) {
          onAbort();
          return;
        }
        controller.signal.addEventListener("abort", onAbort, { once: true });
        work.then(resolve, reject).finally(() => {
          controller.signal.removeEventListener("abort", onAbort);
        });
      });
    },
    child(ms: number, childLabel?: string): Deadline {
      // Never longer than what is left of the parent.
      return createDeadline(Math.min(ms, deadline.remainingMs), {
        label: childLabel ?? label,
        parent: controller.signal,
      });
    },
    dispose(): void {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };

  return deadline;
}
