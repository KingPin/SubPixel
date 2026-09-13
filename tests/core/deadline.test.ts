import { describe, expect, it } from "vitest";
import { createDeadline, DeadlineExceeded } from "../../src/core/deadline.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createDeadline", () => {
  it("does not charge queue time against a deadline that has not started", async () => {
    // The point of autoStart:false. Waiting for a concurrency slot on a busy
    // machine must not manufacture a timeout before the request is even made.
    const deadline = createDeadline(100, { autoStart: false });
    await sleep(60);
    expect(deadline.remainingMs).toBe(100);
    expect(deadline.expired).toBe(false);

    deadline.start();
    await sleep(40);
    expect(deadline.remainingMs).toBeLessThan(100);
    expect(deadline.remainingMs).toBeGreaterThan(0);
    deadline.dispose();
  });

  it("ignores a second start()", async () => {
    const deadline = createDeadline(200);
    await sleep(50);
    const before = deadline.remainingMs;
    deadline.start();
    expect(deadline.remainingMs).toBeLessThanOrEqual(before);
    deadline.dispose();
  });

  it("aborts its signal at the deadline, with a DeadlineExceeded reason", async () => {
    const deadline = createDeadline(30, { label: "generating" });
    expect(deadline.signal.aborted).toBe(false);
    await sleep(60);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBeInstanceOf(DeadlineExceeded);
    expect((deadline.signal.reason as DeadlineExceeded).label).toBe("generating");
    expect(deadline.expired).toBe(true);
    expect(deadline.remainingMs).toBe(0);
    deadline.dispose();
  });

  it("race() rejects when the work never settles", async () => {
    const deadline = createDeadline(30);
    const never = new Promise<string>(() => {});
    await expect(deadline.race(never, "streaming the response")).rejects.toThrow(DeadlineExceeded);
    await expect(deadline.race(never, "streaming the response")).rejects.toThrow(
      /streaming the response/,
    );
    deadline.dispose();
  });

  it("race() resolves normally and leaves no abort listener behind", async () => {
    const deadline = createDeadline(1_000);
    expect(await deadline.race(Promise.resolve("ok"), "x")).toBe("ok");
    // A leaked listener per call would accumulate across a long stream.
    expect(deadline.signal.listenerCount?.("abort") ?? 0).toBe(0);
    deadline.dispose();
  });

  it("race() propagates the work's own rejection unchanged", async () => {
    const deadline = createDeadline(1_000);
    await expect(deadline.race(Promise.reject(new Error("boom")), "x")).rejects.toThrow("boom");
    deadline.dispose();
  });

  it("race() rejects immediately once the deadline has already passed", async () => {
    const deadline = createDeadline(10);
    await sleep(30);
    await expect(deadline.race(Promise.resolve("ok"), "late")).rejects.toThrow(DeadlineExceeded);
    deadline.dispose();
  });

  it("child() is clamped to what is left of the parent", async () => {
    const parent = createDeadline(100);
    await sleep(60);
    const child = parent.child(10_000);
    expect(child.totalMs).toBeLessThanOrEqual(parent.remainingMs + 5);
    expect(child.totalMs).toBeLessThan(10_000);
    child.dispose();
    parent.dispose();
  });

  it("child() aborts when the parent aborts, even with budget left", async () => {
    const parent = createDeadline(30);
    const child = parent.child(10_000);
    expect(child.expired).toBe(false);
    await sleep(60);
    expect(parent.expired).toBe(true);
    expect(child.expired).toBe(true);
    child.dispose();
    parent.dispose();
  });

  it("child() of an already-expired parent is born expired", async () => {
    const parent = createDeadline(10);
    await sleep(30);
    const child = parent.child(1_000);
    expect(child.expired).toBe(true);
    child.dispose();
    parent.dispose();
  });
});
