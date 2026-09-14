import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/errors.js";
import { createSemaphore, mapWithConcurrency } from "../../src/engine/semaphore.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSemaphore", () => {
  it("rejects a limit below 1", () => {
    expect(() => createSemaphore(0)).toThrow(ConfigError);
    expect(() => createSemaphore(-1)).toThrow(ConfigError);
  });

  it("admits up to the limit immediately", async () => {
    const sem = createSemaphore(2);
    const a = await sem.acquire();
    const b = await sem.acquire();
    expect(sem.inFlight()).toBe(2);
    a();
    b();
    expect(sem.inFlight()).toBe(0);
  });

  it("queues the next caller until a permit is released", async () => {
    const sem = createSemaphore(1);
    const first = await sem.acquire();
    let admitted = false;
    const second = sem.acquire().then((release) => {
      admitted = true;
      return release;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    first();
    (await second)();
    expect(admitted).toBe(true);
  });

  it("ignores a double release", async () => {
    const sem = createSemaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.inFlight()).toBe(0);
    // A permit leak would let two callers in at once.
    const a = await sem.acquire();
    let second = false;
    void sem.acquire().then(() => {
      second = true;
    });
    await Promise.resolve();
    expect(second).toBe(false);
    a();
  });
});

describe("mapWithConcurrency", () => {
  it("never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active -= 1;
      return item;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("preserves input order", async () => {
    const slowFirst = deferred<void>();
    const promise = mapWithConcurrency([0, 1], 2, async (item) => {
      if (item === 0) await slowFirst.promise;
      return `item-${item}`;
    });
    slowFirst.resolve();
    const outcome = await promise;
    expect(outcome.values).toEqual(["item-0", "item-1"]);
    expect(outcome.failure).toBeUndefined();
  });

  it("records a rejection instead of rejecting", async () => {
    const outcome = await mapWithConcurrency([0, 1], 2, async (item) => {
      if (item === 1) throw new Error("boom");
      return item;
    });
    expect(outcome.outcomes[0]).toEqual({ status: "fulfilled", index: 0, value: 0 });
    expect(outcome.outcomes[1]?.status).toBe("rejected");
    expect(outcome.failure).toBeInstanceOf(Error);
    expect((outcome.failure as Error).message).toBe("boom");
    // The one that worked is still returned. Its bytes were already paid for.
    expect(outcome.values).toEqual([0]);
  });

  it("admits no new work after a fatal failure", async () => {
    const called: number[] = [];
    // Limit 1 forces strict sequencing, so items 1 and 2 are still queued when
    // item 0 throws. Neither worker may run.
    const outcome = await mapWithConcurrency([0, 1, 2], 1, async (item) => {
      called.push(item);
      if (item === 0) throw new Error("boom");
      return item;
    });
    expect(called).toEqual([0]);
    expect(outcome.outcomes.map((o) => o.status)).toEqual(["rejected", "skipped", "skipped"]);
    expect(outcome.values).toEqual([]);
  });

  it("awaits work already in flight before resolving", async () => {
    const slow = deferred<void>();
    let slowFinished = false;
    const promise = mapWithConcurrency([0, 1], 2, async (item) => {
      if (item === 0) throw new Error("boom");
      await slow.promise;
      slowFinished = true;
      return item;
    });
    // Item 1 started before item 0 failed, so its quota is already committed.
    // Abandoning it would lose the image without saving anything.
    await Promise.resolve();
    slow.resolve();
    const outcome = await promise;
    expect(slowFinished).toBe(true);
    expect(outcome.values).toEqual([1]);
    expect(outcome.outcomes[1]).toEqual({ status: "fulfilled", index: 1, value: 1 });
  });

  it("runs every item when stopOnError is false", async () => {
    const called: number[] = [];
    const outcome = await mapWithConcurrency(
      [0, 1, 2],
      1,
      async (item) => {
        called.push(item);
        if (item !== 2) throw new Error(`boom-${item}`);
        return item;
      },
      { stopOnError: false },
    );
    expect(called).toEqual([0, 1, 2]);
    expect(outcome.outcomes.map((o) => o.status)).toEqual(["rejected", "rejected", "fulfilled"]);
    expect((outcome.failure as Error).message).toBe("boom-0");
    expect(outcome.values).toEqual([2]);
  });

  it("does not leak permits when a worker throws", async () => {
    const sem = createSemaphore(1);
    await expect(
      (async () => {
        const release = await sem.acquire();
        try {
          throw new Error("boom");
        } finally {
          release();
        }
      })(),
    ).rejects.toThrow("boom");
    expect(sem.inFlight()).toBe(0);
  });

  it("handles an empty input", async () => {
    const outcome = await mapWithConcurrency([], 2, async () => 1);
    expect(outcome.outcomes).toEqual([]);
    expect(outcome.values).toEqual([]);
    expect(outcome.failure).toBeUndefined();
  });

  it("rejects an invalid limit even when the input is empty", async () => {
    // Validating only on the non-empty path hides a bad --concurrency until the
    // first multi-image run.
    await expect(mapWithConcurrency([], 0, async () => 1)).rejects.toThrow(ConfigError);
  });
});
