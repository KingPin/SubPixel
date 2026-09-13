import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  link,
  mkdir,
  open,
  readFile as readFileAsync,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { OutputError } from "./errors.js";

export interface AtomicWriteOptions {
  /** File mode applied before the rename, so the file is never briefly readable. */
  mode?: number;
}

/**
 * Write a file atomically.
 *
 * The temp file lives in the same directory as the target, because rename() is
 * only atomic within a single filesystem. Writing to the OS temp dir and renaming
 * across a mount boundary would silently degrade to a copy.
 */
export async function atomicWrite(
  target: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const dir = dirname(target);
  await ensureDir(dir);
  const temp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);

  let handle;
  try {
    handle = await open(temp, "wx", options.mode ?? 0o644);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.mode !== undefined) {
      await chmod(temp, options.mode);
    }
    await rename(temp, target);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export interface PublishOptions extends AtomicWriteOptions {
  /**
   * Permission to replace an existing file. Defaults to false.
   *
   * This is deliberately NOT the same thing as bypassing the cache. A user who
   * wants a fresh generation has not thereby asked to destroy an asset that is
   * already checked in somewhere. Task 14 threads the two separately.
   */
  overwrite?: boolean;
}

/**
 * Publish bytes to `target` without clobbering an existing file.
 *
 * Returns true when the file was published, false when it was refused because the
 * target already exists and `overwrite` was not granted. Every other failure throws.
 *
 * The no-clobber path uses `link()` rather than `rename()`, because `rename()`
 * replaces the destination silently and there is no atomic "rename if absent" on
 * POSIX. `link()` fails with EEXIST if the target exists, and the check-and-create
 * is a single kernel operation, so two processes racing for the same path cannot
 * both win. A `stat()` guard before `rename()` would not be equivalent: the window
 * between the two calls is exactly where the loss happens.
 *
 * ## When hard links are unavailable
 *
 * Some filesystems refuse `link()` — exFAT, some SMB and FUSE mounts, some Windows
 * configurations. There, this function FAILS rather than publishing. It does not
 * degrade.
 *
 * Two earlier drafts degraded, and both broke the contract this function exists to
 * keep. Writing the bytes straight into `target` under `"wx"` exposed a
 * half-written image and left the partial file behind on failure. Reserving the
 * name with `open(target, "wx")` and renaming the temp file over it was better,
 * but still exposed a ZERO-BYTE file at `target` until the rename, and a crash in
 * that window left it there permanently: every later publish then saw EEXIST and
 * silently diverted the real image to a `-v2` sibling forever. "Not corrupt data"
 * is not the promise. The promise is that interruption never leaves a broken final
 * file, and no portable sequence delivers that without `link()`.
 *
 * So the caller is told, and gets a working alternative in the same sentence:
 * `overwrite: true` needs only `rename()`, which every filesystem has and which is
 * atomic on all of them. Refusing loudly on the rare filesystem is better than
 * quietly weakening the guarantee for everyone.
 */
export async function atomicPublish(
  target: string,
  data: string | Uint8Array,
  options: PublishOptions = {},
): Promise<boolean> {
  const dir = dirname(target);
  await ensureDir(dir);
  const temp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);

  try {
    await writeTempFile(temp, data, options.mode);

    if (options.overwrite) {
      await rename(temp, target);
      return true;
    }

    try {
      await link(temp, target);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      // No hard links here, so there is no way to claim the name and fill it in
      // one visible step. Fail with the fix in the message rather than publish
      // something that breaks the guarantee.
      if (code === "EPERM" || code === "ENOSYS" || code === "EXDEV" || code === "EOPNOTSUPP") {
        throw new OutputError(
          `${dir} is on a filesystem that does not support hard links (${code}), so ` +
            `${basename(target)} cannot be created without briefly exposing an ` +
            "incomplete file. Pass --overwrite to write it with a plain rename, or " +
            "choose an output directory on a filesystem that supports hard links.",
          err,
        );
      }
      throw err;
    }
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

async function writeTempFile(
  temp: string,
  data: string | Uint8Array,
  mode?: number,
): Promise<void> {
  const handle = await open(temp, "wx", mode ?? 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (mode !== undefined) await chmod(temp, mode);
}

export interface FileLockOptions {
  /** Give up waiting after this long. */
  timeoutMs?: number;
  /** Delay between acquisition attempts. */
  pollMs?: number;
  /**
   * Called the first time an ownership check finds a foreign or missing record —
   * from `assertHeld()` during the callback, or from the release path if the
   * callback never checked. The callback's work may have overlapped another
   * owner's, so callers that mutate shared state must treat this as a failure of
   * their own operation.
   */
  onLockLost?: (lockPath: string) => void;
}

/**
 * The handle the callback uses to ask whether it still owns the lock.
 *
 * `withFileLock` passes one to `fn`. Any callback that mutates shared state, or
 * that spends money, must `await lock.assertHeld()` immediately before doing so,
 * not only at the start: the gap between "I checked" and "I acted" is the entire
 * bug class this exists for.
 *
 * `assertHeld()` is async because it re-reads the record. A cached boolean
 * refreshed on a timer answers a question about the past — it can report "held"
 * for as long as the timer interval after the lock was replaced, which is exactly
 * the interval in which the mutation happens.
 */
export interface LockHandle {
  /** Last known ownership. Set false by a failed check, and never true again. */
  readonly held: boolean;
  /**
   * Re-reads the record and answers for right now. False once ownership is gone,
   * and never true again. For decisions that have an alternative — "publish into
   * the shared cache, or skip it and keep the local file".
   */
  check(): Promise<boolean>;
  /** `check()`, but rejects with `LockLostError` instead of returning false. */
  assertHeld(): Promise<void>;
}

export class LockLostError extends Error {
  constructor(readonly lockPath: string) {
    super(
      `Lost the lock on ${lockPath} while working. Another process now owns it, ` +
        "so this operation was abandoned rather than allowed to overwrite theirs.",
    );
    this.name = "LockLostError";
  }
}

interface LockRecord {
  id: string;
  pid: number;
  host: string;
  startedAt: string;
}

async function readLockRecord(lockPath: string): Promise<LockRecord | undefined> {
  try {
    const raw = await readFileAsync(lockPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as LockRecord).id === "string") {
      return parsed as LockRecord;
    }
  } catch {
    // Missing, truncated, or written by an older version. Treat as unidentified.
  }
  return undefined;
}

/**
 * Run `fn` while holding an exclusive lock.
 *
 * The lock is an `O_EXCL` file carrying an owner token. Two properties matter:
 *
 * 1. **No lock is ever stolen on a timer.** Elapsed time cannot tell a crashed
 *    owner from a slow one, and a wrong guess puts two live writers in the same
 *    critical section. The only lock this breaks is one whose recorded owner is a
 *    process on this host that no longer exists — see `tryBreakDeadLock`. A lock
 *    from another host, or one whose owner is still alive, is waited for and then
 *    reported.
 * 2. **Ownership is verified at the point of use, not on a schedule.** `fn`
 *    receives a `LockHandle` and must `await lock.assertHeld()` immediately before
 *    each shared mutation or paid submission. That check re-reads the record, so
 *    it answers for the present moment. A background heartbeat answers for
 *    whenever it last ran.
 *
 * Dropping the heartbeat is what removes the whole "detected the loss 3 seconds
 * late" class of failure: there is no longer a staleness clock for a heartbeat to
 * hold off, so the heartbeat has no job left.
 *
 * ## What this is NOT
 *
 * POSIX gives no atomic compare-and-swap over file CONTENT. Release reads the
 * token, then unlinks; between the two the record could in principle be replaced,
 * and we would unlink a lock we no longer own. That window is genuinely
 * microseconds and cannot admit a second *writer* — it can only cost the next
 * waiter one extra acquisition round.
 *
 * Everything else that used to carry a residual window is gone: nothing renames a
 * live lock aside, and nothing removes a lock whose owner might still be working.
 *
 * It is stated here so no caller builds a stronger guarantee on top of it — see
 * Task 6, which needs a real read-modify-write check and does not rely on this
 * lock for correctness.
 *
 * Scope note: this is cooperative. It serialises `spx` processes with each other.
 * It does NOT serialise `spx` against the Codex CLI, which knows nothing about
 * this file. See Task 6 for how the auth path stays safe without that assumption.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: (lock: LockHandle) => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 25;

  await ensureDir(dirname(lockPath));
  const deadline = Date.now() + timeoutMs;
  const token: LockRecord = {
    id: randomUUID(),
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
  };

  for (;;) {
    try {
      const handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await handle.writeFile(JSON.stringify(token));
      await handle.sync();
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      await tryBreakDeadLock(lockPath);
      if (Date.now() > deadline) {
        const holder = await readLockRecord(lockPath);
        const who = holder
          ? ` (held by pid ${holder.pid} on ${holder.host} since ${holder.startedAt})`
          : "";
        // Actionable, because nothing here steals the lock for the user. A lock
        // left by a crash on another machine, or by a killed process whose pid has
        // since been reused, can only be cleared by a human.
        throw new Error(
          `Timed out waiting for lock: ${lockPath}${who}. ` +
            `If that process is gone, delete the file to clear it.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  let held = true;
  const lose = () => {
    if (!held) return; // Notify once. `held` never returns to true.
    held = false;
    options.onLockLost?.(lockPath);
  };

  // The read is the check. One `readFile` of a ~120-byte file per mutation point is
  // cheaper than any of the outcomes it prevents.
  const check = async (): Promise<boolean> => {
    if (held) {
      const current = await readLockRecord(lockPath);
      if (current?.id !== token.id) lose();
    }
    return held;
  };

  const handle: LockHandle = {
    get held() {
      return held;
    },
    check,
    async assertHeld() {
      if (!(await check())) throw new LockLostError(lockPath);
    },
  };

  try {
    return await fn(handle);
  } finally {
    const current = await readLockRecord(lockPath);
    if (current?.id === token.id) {
      // Residual window: another process could replace the record between this
      // read and the unlink. See the "What this is NOT" note above.
      await unlink(lockPath).catch(() => {});
    } else {
      // Either someone replaced our record or someone deleted it. Both mean the
      // section we just ran was not exclusive, and a callback that never called
      // `assertHeld()` would otherwise never hear about it.
      lose();
    }
  }
}

/**
 * Remove a lock whose recorded owner is a process on this host that no longer
 * exists.
 *
 * Two rules make this safe, and the protocol is worthless without either:
 *
 * 1. **Only a provably dead owner is broken.** Elapsed time proves nothing — a
 *    refresh waiting on a slow token endpoint looks exactly like a crashed one,
 *    and breaking it puts two live writers in one critical section. `kill(pid, 0)`
 *    on the same host does prove it: a process that does not exist cannot be
 *    mid-write, so removing its lock can never admit a second writer to work that
 *    is still running. Anything else — another host, a live pid, a pid that may
 *    have been reused — is left alone, and the waiter times out with a message
 *    naming the holder.
 * 2. **Breaking is itself exclusive**, via `<lockPath>.break` created with
 *    `O_EXCL`. Without it two breakers interleave: one unlinks the corpse, a third
 *    process legitimately acquires, and the second breaker unlinks *that* live
 *    lock. Holding the break lock means nothing can replace the record between the
 *    read below and the unlink: the corpse's owner is dead and no other breaker is
 *    running.
 *
 * Note the ordering — the record is read AFTER the break lock is held, never
 * before. A record read earlier could describe a lock that has since been released
 * and re-acquired by someone alive.
 *
 * A breaker killed mid-break leaves `<lockPath>.break` behind, and the lock then
 * has to be cleared by hand. That is the deliberate trade: no failure mode here
 * ends with two owners, and the manual path is the one the timeout message
 * describes.
 */
async function tryBreakDeadLock(lockPath: string): Promise<void> {
  const breakPath = `${lockPath}.break`;
  let breaker;
  try {
    breaker = await open(
      breakPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
  } catch {
    // Another breaker is working, or a crashed one left the marker. Either way
    // this is not ours to break.
    return;
  }
  try {
    const record = await readLockRecord(lockPath);
    if (!record || !isOwnerDead(record)) return;
    await unlink(lockPath).catch(() => {});
  } finally {
    await breaker.close().catch(() => {});
    await rm(breakPath, { force: true }).catch(() => {});
  }
}

/**
 * True only when the record names a process on THIS host that is gone.
 *
 * Every uncertain answer is `false`. A pid from another host cannot be probed. A
 * pid that has been reused by an unrelated process reads as alive, so the lock is
 * kept rather than broken. `EPERM` means the process exists and belongs to someone
 * else; only `ESRCH` proves death.
 */
function isOwnerDead(record: LockRecord): boolean {
  if (record.host !== hostname()) return false;
  if (!Number.isInteger(record.pid) || record.pid <= 0) return false;
  if (record.pid === process.pid) return false; // Ourselves. Alive by definition.
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Write JSON atomically with a trailing newline. */
export async function atomicWriteJson(
  target: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await atomicWrite(target, `${JSON.stringify(value, null, 2)}\n`, options);
}

/** Read a file, returning undefined when it does not exist. */
export async function readIfExists(path: string): Promise<Buffer | undefined> {
  try {
    return await readFileAsync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Locate an executable on PATH.
 *
 * This lives beside the other filesystem probes rather than in the CLI, because
 * both `spx doctor` and the codex-exec provider need it, and a provider must
 * never import from `src/cli/`.
 */
export async function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here. Keep looking.
    }
  }
  return undefined;
}

// Referenced by tests that assert temp-file cleanup.
export const __internal = { writeFile };
