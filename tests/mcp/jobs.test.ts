import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  completeJob,
  createJob,
  failJob,
  jobsDirFor,
  listJobs,
  readJob,
  reapOrphans,
} from "../../src/mcp/jobs.js";
import { ContentBlocked } from "../../src/core/errors.js";

let dir: string;

beforeEach(async () => {
  dir = jobsDirFor(await mkdtemp(join(tmpdir(), "subpixel-jobs-")));
});

describe("the job store", () => {
  it("round-trips a job from running to done", async () => {
    const job = await createJob(dir, "generate_image");
    expect(job.status).toBe("running");
    expect(job.pid).toBe(process.pid);

    await completeJob(dir, job.id, { images: [{ path: "fox.png" }] });

    const done = await readJob(dir, job.id);
    expect(done?.status).toBe("done");
    expect(done?.result).toEqual({ images: [{ path: "fox.png" }] });
    expect(Date.parse(done!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(job.createdAt));
  });

  it("stores a failure's taxonomy code and message, never a stack", async () => {
    const job = await createJob(dir, "generate_image");
    await failJob(dir, job.id, new ContentBlocked("the prompt was refused"));

    const failed = await readJob(dir, job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error?.code).toBe("CONTENT_BLOCKED");
    expect(failed?.error?.message).toBe("the prompt was refused");
    expect(JSON.stringify(failed)).not.toContain("jobs.test.ts");
  });

  it("is readable by a separate process while the job is still running", async () => {
    // This proves the RECORD persists across process boundaries, which is what lets
    // a host poll. It is not a promise that the work continues: a job dies with the
    // server that owns it, and `reapOrphans` below is the other half of that.
    const job = await createJob(dir, "generate_image");
    const seen = execFileSync(
      process.execPath,
      ["-e", `process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))`, join(dir, `${job.id}.json`)],
      { encoding: "utf8" },
    );
    expect(JSON.parse(seen).status).toBe("running");
  });

  it("keeps no credential material on disk", async () => {
    // Synthetic value. A tool result is built from user content and lands here
    // verbatim, so the whole document is masked rather than a list of fields.
    const job = await createJob(dir, "doctor");
    await completeJob(dir, job.id, {
      auth: { access_token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVl" },
    });
    const raw = await readFile(join(dir, `${job.id}.json`), "utf8");
    expect(raw).not.toContain("c2lnbmF0dXJlLXZhbHVl");
    expect(raw).toContain("[REDACTED]");
    expect(JSON.parse(raw).status).toBe("done");
  });

  it("fails an orphaned running record and leaves finished ones alone", async () => {
    const orphan = await createJob(dir, "generate_image");
    // A pid that is certainly gone, on this host, so the probe can answer.
    const dead = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    });
    await writeFile(
      join(dir, `${orphan.id}.json`),
      JSON.stringify({ ...orphan, pid: Number(dead), host: hostname() }, null, 2),
    );

    const mine = await createJob(dir, "generate_image");
    const finished = await createJob(dir, "sync_assets");
    await completeJob(dir, finished.id, { ok: true });

    expect(await reapOrphans(dir)).toBe(1);

    const reaped = await readJob(dir, orphan.id);
    expect(reaped?.status).toBe("failed");
    expect(reaped?.error?.message).toBe("server exited during generation");
    // This process is alive, so its own record is untouched.
    expect((await readJob(dir, mine.id))?.status).toBe("running");
    expect((await readJob(dir, finished.id))?.status).toBe("done");
  });

  it("prunes finished records by age and keeps running ones", async () => {
    const old = await createJob(dir, "generate_image");
    await completeJob(dir, old.id, { ok: true });
    const stale = await readJob(dir, old.id);
    await writeFile(
      join(dir, `${old.id}.json`),
      JSON.stringify({ ...stale, updatedAt: new Date(Date.now() - 86_400_000).toISOString() }, null, 2),
    );
    const running = await createJob(dir, "generate_image");

    const listed = await listJobs(dir, { maxAgeMs: 60_000 });

    expect(listed.map((record) => record.id)).toEqual([running.id]);
    expect(await readJob(dir, old.id)).toBeUndefined();
  });

  it("ignores a directory that does not exist yet", async () => {
    expect(await listJobs(join(dir, "absent"))).toEqual([]);
    expect(await readJob(dir, "no-such-job")).toBeUndefined();
  });
});
