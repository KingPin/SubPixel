import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { atomicWrite, ownerIsDead } from "../core/fsx.js";
import { redact } from "../core/redact.js";
import { SubpixelError } from "../core/errors.js";

/**
 * Exactly the three values the spec's `get_image_job` contract names.
 *
 * There is deliberately no `queued` and no `cancelled`. A host polls this to decide
 * whether to wait, and a fourth value it has never seen is a value it will guess
 * about.
 */
export type JobStatus = "running" | "done" | "failed";

export interface JobRecord {
  id: string;
  /** The tool that created the job, e.g. `generate_image`. */
  tool: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  /**
   * The process that owns this record, and the host it runs on.
   *
   * A `running` record is a promise about a process that may already be dead — the
   * MCP host starts and kills the stdio server at will. These two fields are what
   * let `reapOrphans` tell "still generating" from "the server exited".
   */
  pid: number;
  host: string;
  /** The tool result, present only when `status` is `done`. */
  result?: unknown;
  /** The failure, present only when `status` is `failed`. Never a stack. */
  error?: { code: string; message: string };
}

export function jobsDirFor(stateDir: string): string {
  return join(stateDir, "jobs");
}

function pathFor(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/**
 * Write a record.
 *
 * Redaction runs over the SERIALISED document for the same reason it does in the
 * sidecar manifest: a job record holds a tool result built from user content, and
 * naming the fields that need masking is a list that goes stale. The mask contains
 * no quote or backslash, so the document stays parseable.
 */
async function write(dir: string, record: JobRecord): Promise<JobRecord> {
  await atomicWrite(pathFor(dir, record.id), redact(`${JSON.stringify(record, null, 2)}\n`));
  return record;
}

export async function createJob(dir: string, tool: string): Promise<JobRecord> {
  const now = new Date().toISOString();
  return write(dir, {
    id: randomUUID(),
    tool,
    status: "running",
    createdAt: now,
    updatedAt: now,
    pid: process.pid,
    host: hostname(),
  });
}

function isJobRecord(value: unknown): value is JobRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.tool === "string" &&
    (record.status === "running" || record.status === "done" || record.status === "failed") &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    typeof record.pid === "number" &&
    typeof record.host === "string"
  );
}

export async function readJob(dir: string, id: string): Promise<JobRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(pathFor(dir, id), "utf8"));
    return isJobRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function completeJob(dir: string, id: string, result: unknown): Promise<void> {
  const record = await readJob(dir, id);
  if (!record) return;
  await write(dir, { ...record, status: "done", updatedAt: new Date().toISOString(), result });
}

/**
 * Fail a job with the taxonomy code and the message, and nothing else.
 *
 * A stack trace names absolute paths on the machine the server runs on, and this
 * record is read back by a host that logs it.
 */
export async function failJob(dir: string, id: string, reason: unknown): Promise<void> {
  const record = await readJob(dir, id);
  if (!record) return;
  await write(dir, {
    ...record,
    status: "failed",
    updatedAt: new Date().toISOString(),
    error: {
      code: reason instanceof SubpixelError ? reason.code : "UNKNOWN",
      message: redact(reason instanceof Error ? reason.message : reason),
    },
  });
}

export interface ListJobsOptions {
  /**
   * Delete finished records older than this before listing.
   *
   * Pruning belongs here rather than in a timer: the server touches this directory
   * only when a tool call arrives, and a directory that grows without bound is the
   * predictable end state of a store nothing ever sweeps. `running` records are
   * never pruned by age — `reapOrphans` decides their fate, and only then do they
   * become eligible.
   */
  maxAgeMs?: number;
}

export async function listJobs(
  dir: string,
  options: ListJobsOptions = {},
): Promise<JobRecord[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const records: JobRecord[] = [];
  const cutoff = options.maxAgeMs === undefined ? undefined : Date.now() - options.maxAgeMs;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = await readJob(dir, name.slice(0, -".json".length));
    if (!record) continue;
    if (
      cutoff !== undefined &&
      record.status !== "running" &&
      Date.parse(record.updatedAt) < cutoff
    ) {
      await rm(pathFor(dir, record.id), { force: true }).catch(() => {});
      continue;
    }
    records.push(record);
  }
  return records;
}

/**
 * Fail every `running` record whose owning process is gone.
 *
 * It does NOT resubmit. The first attempt may already have been billed, and a
 * record on disk is no evidence either way — so the honest answer to the host is
 * that the work stopped, not a second purchase made on its behalf.
 *
 * An uncertain answer leaves the record alone: a pid from another host cannot be
 * probed, and a reused pid reads as alive. Both keep the job `running`, which is
 * merely stale rather than wrong.
 */
export async function reapOrphans(dir: string): Promise<number> {
  let reaped = 0;
  for (const record of await listJobs(dir)) {
    if (record.status !== "running") continue;
    if (!ownerIsDead(record.pid, record.host)) continue;
    await write(dir, {
      ...record,
      status: "failed",
      updatedAt: new Date().toISOString(),
      error: { code: "SERVER_EXITED", message: "server exited during generation" },
    });
    reaped += 1;
  }
  return reaped;
}
