import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorReport } from "../../src/cli/doctor.js";

const collectDoctorReport = vi.fn();
vi.mock("../../src/cli/doctor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/cli/doctor.js")>()),
  collectDoctorReport,
}));

const { TOOLS, HANDLERS, callTool, validateArgs } = await import("../../src/mcp/tools.js");
const { buildProgram } = await import("../../src/cli/index.js");
const { createJob, completeJob, jobsDirFor } = await import("../../src/mcp/jobs.js");
const { ConfigError } = await import("../../src/core/errors.js");

const REPORT: DoctorReport = {
  ok: true,
  node: "v24.0.0",
  codexBinary: "/usr/bin/codex",
  sharp: true,
  auth: { path: "/home/tester/.codex/auth.json", present: true, mode: "chatgpt" },
  model: { slug: "gpt-5.6-sol", source: "cache" },
  config: { styles: 0 },
  quota: { summary: "no reading yet", warn: false, stale: true },
  notice: "a notice",
};

/** Run a `--json` command and parse exactly what it printed on stdout. */
async function cliJson(...argv: string[]): Promise<unknown> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  const previousExit = process.exitCode;
  try {
    await (await buildProgram()).parseAsync(["node", "spx", ...argv]);
  } finally {
    spy.mockRestore();
    process.exitCode = previousExit;
  }
  return JSON.parse(chunks.join("")) as unknown;
}

let dir: string;
let previousCwd: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "subpixel-tools-"));
  previousCwd = process.cwd();
  collectDoctorReport.mockReset();
  collectDoctorReport.mockResolvedValue(REPORT);
});

afterEach(() => {
  process.chdir(previousCwd);
});

describe("the tool schemas", () => {
  it("declares all seven spec tools", () => {
    expect(TOOLS.map((tool) => tool.name).sort()).toEqual([
      "doctor",
      "edit_image",
      "generate_image",
      "get_image_job",
      "list_models",
      "list_styles",
      "sync_assets",
    ]);
  });

  it("never offers the paid api backend as a value a host can pick", () => {
    for (const tool of TOOLS) {
      const backend = tool.inputSchema.properties.backend;
      if (!backend) continue;
      expect(backend.enum).toEqual(["codex-http", "codex-exec", "auto"]);
    }
    expect(() => validateArgs("generate_image", { prompt: "a fox", backend: "api" })).toThrow(
      /must be one of codex-http, codex-exec, auto/,
    );
    expect(() => validateArgs("sync_assets", { backend: "api" })).toThrow(ConfigError);
  });

  it("tells a host the worst case and forbids a retry", () => {
    const generate = TOOLS.find((tool) => tool.name === "generate_image");
    expect(generate?.description).toContain("6 minutes");
    expect(generate?.description).toContain("poll get_image_job");
    expect(generate?.description).toContain("Do not retry");
  });

  it.each([
    ["generate_image", { prompt: "a red fox", size: "1024x1024", variants: [400, 800] }],
    ["edit_image", { image: "fox.png", instruction: "make it night", quality: "high" }],
    ["list_styles", { name: "brand" }],
    ["list_models", { model: "gpt-5.6-sol" }],
    ["sync_assets", { check: true }],
    ["get_image_job", { job_id: "abc" }],
    ["doctor", {}],
  ])("accepts the happy path for %s", (name, args) => {
    expect(validateArgs(name, args)).toEqual(args);
  });

  it.each([
    ["generate_image", {}, /requires "prompt"/],
    ["edit_image", { image: "fox.png" }, /requires "instruction"/],
    ["list_styles", { name: 7 }, /must be a string/],
    ["list_models", { models: "x" }, /no argument "models"/],
    ["sync_assets", { check: "yes" }, /must be a boolean/],
    ["get_image_job", { job_id: 12 }, /must be a string/],
    ["doctor", { verbose: true }, /no argument "verbose"/],
  ])("rejects a malformed argument set for %s", (name, args, message) => {
    expect(() => validateArgs(name, args)).toThrow(message);
  });

  it("refuses more than one image, because every image is money", () => {
    expect(validateArgs("generate_image", { prompt: "a fox", n: 1 }).n).toBe(1);
    expect(() => validateArgs("generate_image", { prompt: "a fox", n: 2 })).toThrow(/at most 1/);
  });

  it("exposes no cache-bypass argument on either generating tool", () => {
    for (const name of ["generate_image", "edit_image"]) {
      const keys = Object.keys(TOOLS.find((tool) => tool.name === name)!.inputSchema.properties);
      expect(keys).not.toContain("no_cache");
      expect(keys).not.toContain("force");
    }
  });

  it("checks the element type inside an array argument", () => {
    expect(() => validateArgs("generate_image", { prompt: "a fox", variants: [400, "800"] })).toThrow(
      /variants\[1\]" must be a whole number/,
    );
  });
});

describe("the read-only tools", () => {
  it("returns exactly what doctor --json prints", async () => {
    expect(await callTool("doctor", {})).toEqual(await cliJson("doctor", "--json"));
  });

  it("returns exactly what models --json prints", async () => {
    expect(await callTool("list_models", {})).toEqual(await cliJson("models", "--json"));
    expect(await callTool("list_models", { model: "gpt-image-1.5" })).toEqual(
      await cliJson("models", "--json", "--model", "gpt-image-1.5"),
    );
  });

  it("returns exactly what styles --json prints", async () => {
    await writeFile(
      join(dir, "subpixel.config.json"),
      JSON.stringify({
        styles: {
          brand: { palette: "deep navy, warm amber", modifiers: "flat vector" },
          sketch: { subject: "pencil lines" },
        },
      }),
    );
    process.chdir(dir);

    const viaTool = await callTool("list_styles", {}, { cwd: dir });
    expect(viaTool).toEqual(await cliJson("styles", "--json"));
    expect((viaTool as { styles: Array<{ name: string }> }).styles.map((s) => s.name)).toEqual([
      "brand",
      "sketch",
    ]);

    expect(await callTool("list_styles", { name: "brand" }, { cwd: dir })).toEqual(
      await cliJson("styles", "--json", "brand"),
    );
  });

  it("reads back a job record", async () => {
    const jobsDir = jobsDirFor(join(dir, ".subpixel"));
    const job = await createJob(jobsDir, "generate_image");
    await completeJob(jobsDir, job.id, { images: [{ path: "fox.png" }] });

    const record = await callTool("get_image_job", { job_id: job.id }, { jobsDir });

    expect(record).toMatchObject({ id: job.id, tool: "generate_image", status: "done" });
  });

  it("explains a job id it cannot find rather than returning nothing", async () => {
    await expect(
      callTool("get_image_job", { job_id: "no-such-job" }, { jobsDir: jobsDirFor(dir) }),
    ).rejects.toThrow(/No job "no-such-job"/);
  });

  it("masks credential material on the way out, whichever handler ran", async () => {
    // Synthetic value. A doctor report carries whatever the auth file held, and the
    // masking has to happen once at the boundary rather than per report field.
    collectDoctorReport.mockResolvedValue({
      ...REPORT,
      auth: { ...REPORT.auth, problem: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl is stale" },
    });

    const result = await callTool("doctor", {});

    expect(JSON.stringify(result)).not.toContain("c2lnbmF0dXJl");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
    expect((result as { ok: boolean }).ok).toBe(true);
  });
});

describe("the tool dispatcher", () => {
  it("names the tools it has when asked for one it does not", async () => {
    await expect(callTool("draw_me_a_sheep", {})).rejects.toThrow(/Unknown tool/);
  });

  it("can run every tool it declares", () => {
    // A tool in the list with no handler is a tool a host will call and be told
    // does not exist, which is worse than never advertising it.
    expect(TOOLS.map((tool) => tool.name).sort()).toEqual(Object.keys(HANDLERS).sort());
  });
});
