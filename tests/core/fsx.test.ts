import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  atomicPublish,
  atomicWrite,
  ensureDir,
  findOnPath,
  LockLostError,
  withFileLock,
} from "../../src/core/fsx.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "subpixel-fsx-"));
});

afterEach(async () => {
  // Leave the temp dir; the OS reclaims it. Deleting risks masking a real leak.
});

describe("atomicWrite", () => {
  it("writes the file contents", async () => {
    const target = join(dir, "out.txt");
    await atomicWrite(target, "hello");
    expect(await readFile(target, "utf8")).toBe("hello");
  });

  it("applies the requested mode", async () => {
    const target = join(dir, "secret.json");
    await atomicWrite(target, "{}", { mode: 0o600 });
    const info = await stat(target);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("leaves no temp files behind on success", async () => {
    const target = join(dir, "clean.txt");
    await atomicWrite(target, "x");
    const entries = await readdir(dir);
    expect(entries).toEqual(["clean.txt"]);
  });

  it("overwrites an existing file", async () => {
    const target = join(dir, "over.txt");
    await writeFile(target, "old");
    await atomicWrite(target, "new");
    expect(await readFile(target, "utf8")).toBe("new");
  });

  it("writes binary buffers", async () => {
    const target = join(dir, "img.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await atomicWrite(target, bytes);
    expect(await readFile(target)).toEqual(bytes);
  });
});

describe("atomicPublish", () => {
  it("publishes when the target is absent", async () => {
    const target = join(dir, "new.png");
    expect(await atomicPublish(target, "bytes")).toBe(true);
    expect(await readFile(target, "utf8")).toBe("bytes");
  });

  it("refuses an existing target instead of replacing it", async () => {
    const target = join(dir, "existing.png");
    await writeFile(target, "original");
    expect(await atomicPublish(target, "replacement")).toBe(false);
    expect(await readFile(target, "utf8")).toBe("original");
  });

  it("replaces the target when overwrite is explicitly granted", async () => {
    const target = join(dir, "forced.png");
    await writeFile(target, "original");
    expect(await atomicPublish(target, "replacement", { overwrite: true })).toBe(true);
    expect(await readFile(target, "utf8")).toBe("replacement");
  });

  it("lets exactly one of many simultaneous publishers win", async () => {
    const target = join(dir, "contended.png");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => atomicPublish(target, `writer-${i}`)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    // The surviving file is one writer's complete output, never a blend of two.
    expect(await readFile(target, "utf8")).toMatch(/^writer-\d$/);
  });

  it("leaves no temp file behind when it refuses", async () => {
    const target = join(dir, "refused.png");
    await writeFile(target, "original");
    await atomicPublish(target, "replacement");
    expect(await readdir(dir)).toEqual(["refused.png"]);
  });

});

describe("ensureDir", () => {
  it("creates nested directories", async () => {
    const nested = join(dir, "a", "b", "c");
    await ensureDir(nested);
    expect((await stat(nested)).isDirectory()).toBe(true);
  });

  it("is idempotent", async () => {
    const nested = join(dir, "a");
    await ensureDir(nested);
    await ensureDir(nested);
    expect((await stat(nested)).isDirectory()).toBe(true);
  });
});

describe("withFileLock", () => {
  it("serialises concurrent callers", async () => {
    const lockPath = join(dir, "run.lock");
    const events: string[] = [];
    const slow = withFileLock(lockPath, async () => {
      events.push("a-start");
      await new Promise((r) => setTimeout(r, 60));
      events.push("a-end");
    });
    const fast = withFileLock(lockPath, async () => {
      events.push("b-start");
      events.push("b-end");
    });
    await Promise.all([slow, fast]);
    expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("releases the lock when the callback throws", async () => {
    const lockPath = join(dir, "throw.lock");
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const result = await withFileLock(lockPath, async () => "ok");
    expect(result).toBe("ok");
  });

  it("breaks a lock whose owner is a dead pid on this host", async () => {
    const lockPath = join(dir, "dead.lock");
    // 2^22 + 1 is above every default pid_max, so it can never be live.
    await writeFile(
      lockPath,
      JSON.stringify({ id: "ghost", pid: 4_194_305, host: hostname(), startedAt: "x" }),
    );
    const result = await withFileLock(lockPath, async () => "recovered", {
      timeoutMs: 2_000,
    });
    expect(result).toBe("recovered");
  });

  it("does NOT break a lock whose owner is alive, however old it looks", async () => {
    // The refresh-stampede regression. There is no staleness clock to outrun any
    // more: an mtime from last week and a live owner still means "wait".
    const lockPath = join(dir, "live.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ id: "busy", pid: process.pid, host: hostname(), startedAt: "x" }),
    );
    const ancient = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await utimes(lockPath, ancient, ancient);

    await expect(
      withFileLock(lockPath, async () => "stolen", { timeoutMs: 200, pollMs: 20 }),
    ).rejects.toThrow(/Timed out waiting for lock/);
    // The message has to tell the user what to do about it.
    await expect(
      withFileLock(lockPath, async () => "stolen", { timeoutMs: 200, pollMs: 20 }),
    ).rejects.toThrow(/delete the file/);
  });

  it("does NOT break a lock recorded on another host", async () => {
    // The pid is meaningless off-box, so it is never probed.
    const lockPath = join(dir, "remote.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ id: "far", pid: 4_194_305, host: "some-other-box", startedAt: "x" }),
    );
    await expect(
      withFileLock(lockPath, async () => "stolen", { timeoutMs: 200, pollMs: 20 }),
    ).rejects.toThrow(/some-other-box/);
  });

  it("serialises a long critical section against a waiter", async () => {
    const lockPath = join(dir, "long.lock");
    const order: string[] = [];

    const owner = withFileLock(lockPath, async () => {
      order.push("owner-start");
      await new Promise((r) => setTimeout(r, 400));
      order.push("owner-end");
    });

    await new Promise((r) => setTimeout(r, 50));
    const waiter = withFileLock(lockPath, async () => order.push("waiter"), {
      timeoutMs: 5_000,
    });

    await Promise.all([owner, waiter]);
    expect(order).toEqual(["owner-start", "owner-end", "waiter"]);
  });

  it("releases only its own lock", async () => {
    const lockPath = join(dir, "owned.lock");
    let lost = false;

    await withFileLock(
      lockPath,
      async () => {
        // Simulate a steal: someone else replaced the lock file while we worked.
        await writeFile(lockPath, JSON.stringify({ id: "someone-else", pid: 1 }));
      },
      { onLockLost: () => void (lost = true) },
    );

    expect(lost).toBe(true);
    // The other owner's lock file survives; we must not delete what we do not hold.
    const surviving = JSON.parse(await readFile(lockPath, "utf8")) as { id: string };
    expect(surviving.id).toBe("someone-else");
  });

  it("reports the loss at the NEXT assertHeld, with no interval to wait for", async () => {
    // The regression this exists for, twice over. A notification delivered in
    // `finally` is a post-mortem. A notification delivered by a heartbeat is up to
    // one interval late, and the write it was meant to stop happens inside that
    // interval. So: no sleep anywhere in this test.
    const lockPath = join(dir, "midflight.lock");
    const events: string[] = [];

    await withFileLock(
      lockPath,
      async (lock) => {
        await lock.assertHeld(); // Held: the record is still ours.
        await writeFile(lockPath, JSON.stringify({ id: "someone-else", pid: 1 }));
        await expect(lock.assertHeld()).rejects.toThrow(LockLostError);
        events.push(lock.held ? "still-held" : "loss-seen");
        events.push("callback-end");
      },
      { onLockLost: () => events.push("notified") },
    );

    // Order is the whole assertion. The notification precedes the point where the
    // callback would have written, with nothing sleeping to make room for it.
    expect(events).toEqual(["notified", "loss-seen", "callback-end"]);
  });

  it("two waiters on the same dead lock both run, and clean up the break marker", async () => {
    const lockPath = join(dir, "contested.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ id: "dead", pid: 4_194_305, host: hostname(), startedAt: "x" }),
    );

    // Both break-eligible. Exactly one breaks; neither may delete the other's
    // freshly created lock, so both callbacks must run.
    const seen: string[] = [];
    await Promise.all([
      withFileLock(lockPath, async () => void seen.push("a"), { timeoutMs: 5_000 }),
      withFileLock(lockPath, async () => void seen.push("b"), { timeoutMs: 5_000 }),
    ]);

    expect(seen.sort()).toEqual(["a", "b"]);
    // No break markers or lock files left behind.
    expect((await readdir(dir)).filter((f) => f.includes("contested"))).toEqual([]);
  });

  it("returns the callback value", async () => {
    const lockPath = join(dir, "value.lock");
    expect(await withFileLock(lockPath, async () => 42)).toBe(42);
  });
});

describe("findOnPath", () => {
  it("finds an executable on PATH", async () => {
    const bin = join(dir, "fake-tool");
    await writeFile(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(await findOnPath("fake-tool", { PATH: dir })).toBe(bin);
  });

  it("returns undefined when the name is absent", async () => {
    expect(await findOnPath("definitely-not-installed", { PATH: dir })).toBeUndefined();
  });

  it("ignores a non-executable file of the same name", async () => {
    await writeFile(join(dir, "not-exec"), "data", { mode: 0o644 });
    expect(await findOnPath("not-exec", { PATH: dir })).toBeUndefined();
  });

  it("tolerates an empty or missing PATH", async () => {
    expect(await findOnPath("anything", {})).toBeUndefined();
    expect(await findOnPath("anything", { PATH: "" })).toBeUndefined();
  });
});
