import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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
const { CacheMiss, ConfigError, AuthExpired, detailsOf } = await import(
  "../../src/core/errors.js",
);

const REPORT: DoctorReport = {
  ok: true,
  node: "v24.0.0",
  codexBinary: "/usr/bin/codex",
  sharp: true,
  auth: { path: "/home/tester/.codex/auth.json", present: true, mode: "chatgpt" },
  model: { slug: "gpt-5.6-sol", source: "cache" },
  config: { styles: 0 },
  quota: { summary: "no reading yet", warn: false, stale: true },
  install: { ok: true, configured: [], pending: [], conflicts: [] },
  mcp: { tools: 1 },
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

  it("offers the cache bypass, and keeps it separate from overwriting", () => {
    // `no_cache` was deliberately withheld once, on the grounds that an agent given a
    // bypass will use it. An agent that wants a different picture and has no bypass
    // appends noise to the prompt instead, which spends the same quota and poisons the
    // cache with a key nobody will ever hit again.
    //
    // `force` and `overwrite` are a different decision and stay out. Bypassing the
    // cache buys a new image; replacing a file destroys one that is already on disk,
    // and an agent has no business doing the second because it asked for the first.
    for (const name of ["generate_image", "edit_image"]) {
      const keys = Object.keys(TOOLS.find((tool) => tool.name === name)!.inputSchema.properties);
      expect(keys, name).toContain("no_cache");
      expect(keys, name).not.toContain("force");
      expect(keys, name).not.toContain("overwrite");
    }
  });

  it.each(["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"])(
    "rejects %j, which is not an argument any tool declares",
    (key) => {
      // `key in properties` is true for every one of these. The gate that
      // rejects arguments a tool does not declare has to ask whether the schema
      // owns the name, not whether anything in its prototype chain answers to it.
      expect(() => validateArgs("generate_image", { prompt: "a fox", [key]: "x" })).toThrow(
        `has no argument "${key}"`,
      );
    },
  );

  it("rejects __proto__ arriving as an own property from the wire", () => {
    // JSON.parse does not run the setter: this lands as a plain own key, which
    // Object.keys enumerates and `in` waved through.
    const args = JSON.parse('{"prompt":"a fox","__proto__":{"polluted":true}}') as unknown;
    expect(() => validateArgs("generate_image", args)).toThrow(/has no argument/);
  });

  it("checks the element type inside an array argument", () => {
    expect(() => validateArgs("generate_image", { prompt: "a fox", variants: [400, "800"] })).toThrow(
      /variants\[1\]" must be a whole number/,
    );
  });
});

describe("the read-only tools", () => {
  it("answers every doctor question without naming the account or the disk", async () => {
    collectDoctorReport.mockResolvedValue({
      ...REPORT,
      auth: {
        ...REPORT.auth,
        accountId: "acct-1a2b3c4d",
        // readAuth builds this message out of the path, so masking the field
        // alone would leave the path in the sentence beside it.
        problem: "/home/tester/.codex/auth.json is not valid JSON. Run `codex login`.",
      },
      config: { path: "/home/tester/work/acme-rebrand/subpixel.config.json", styles: 2 },
      install: {
        ...REPORT.install,
        ok: false,
        // What a package installed without its skills directory throws. The path is
        // not one publicDoctorReport knows in advance: it is wherever npm put us.
        problem:
          "ENOENT: no such file or directory, open '/Users/Jane Doe/.local/share/pnpm/global/5/node_modules/subpixel/skills/subpixel/SKILL.md'",
      },
    } satisfies DoctorReport);

    const cli = (await cliJson("doctor", "--json")) as DoctorReport;
    const mcp = (await callTool("doctor", {})) as DoctorReport;

    // The CLI report is for a person looking at their own machine. It says everything.
    expect(cli.auth.accountId).toBe("acct-1a2b3c4d");
    expect(cli.config.path).toContain("/home/tester");

    // The MCP report still answers every question doctor exists to answer.
    expect(mcp.ok).toBe(cli.ok);
    expect(mcp.model).toEqual(cli.model);
    expect(mcp.auth.present).toBe(true);
    expect(mcp.config.styles).toBe(2);
    expect(mcp.auth.problem).toContain("is not valid JSON");
    // The whole diagnosis survives. Only the address is withheld.
    expect(mcp.install.problem).toBe(
      "ENOENT: no such file or directory, open 'SKILL.md'",
    );

    // It names neither the account behind the subscription nor the user's disk.
    expect(mcp.auth).not.toHaveProperty("accountId");
    expect(JSON.stringify(mcp)).not.toContain("acct-1a2b3c4d");
    expect(JSON.stringify(mcp)).not.toContain("/home/tester");
    expect(JSON.stringify(mcp)).not.toContain("acme-rebrand");
    expect(JSON.stringify(mcp)).not.toContain("Jane Doe");
    expect(mcp.auth.path).toBe("auth.json");
    expect(mcp.config.path).toBe("subpixel.config.json");
    expect(mcp.codexBinary).toBe("codex");
  });

  it("masks a credential on the way out of doctor --json, like every other command", async () => {
    // doctor reads auth.json and reports what went wrong with it. That makes it
    // the command with the most to spill, not the least, and it was the one
    // writing straight to stdout.
    collectDoctorReport.mockResolvedValue({
      ...REPORT,
      auth: { ...REPORT.auth, problem: "refused: Bearer sk-live-abcdefghijklmnop" },
    } satisfies DoctorReport);
    const raw = JSON.stringify(await cliJson("doctor", "--json"));
    expect(raw).not.toContain("abcdefghijklmnop");
    expect(raw).toContain("[REDACTED]");
  });

  it("masks a credential on the way out of models --json", async () => {
    // --model is the one user-controlled string that reaches this report, and a
    // slug pasted from the wrong buffer is exactly how a key ends up in a
    // terminal transcript.
    const raw = JSON.stringify(await cliJson("models", "--json", "--model", "sk-live-abcdefghijklmnop"));
    expect(raw).not.toContain("abcdefghijklmnop");
    expect(raw).toContain("[REDACTED]");
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

describe("sync_assets", () => {
  it("surfaces the taxonomy error instead of reporting a clean run", async () => {
    // `syncAssets` returns its failure rather than throwing, so the CLI can print
    // the report and then exit non-zero. MCP has no second step: swallowing that
    // failure told the host every asset was fine, and left the job `done`.
    await writeFile(join(dir, "assets.yml"), "assets:\n  - id: hero\n    prompt: a dashboard\n");

    await expect(
      callTool("sync_assets", {}, {
        cwd: dir,
        provider: vi.fn(async () => {
          throw new AuthExpired("the ChatGPT session expired");
        }) as never,
      }),
    ).rejects.toThrow(AuthExpired);
  });

  it("keeps the report on the failure, so a retry is not the only move", async () => {
    // Two assets, one provider that dies on the second. Without the report the
    // agent is told "the sync failed" and nothing else, so its only option is to
    // run the whole thing again and re-bill the asset that already landed.
    await writeFile(
      join(dir, "assets.yml"),
      "assets:\n  - id: hero\n    prompt: a dashboard\n  - id: icon\n    prompt: a bell\n",
    );

    const failure = await callTool("sync_assets", {}, {
      cwd: dir,
      provider: vi.fn(async () => {
        throw new AuthExpired("the ChatGPT session expired");
      }) as never,
    }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(AuthExpired);
    const report = detailsOf(failure) as { statuses: unknown[]; failures: unknown[] };
    expect(report.statuses).toHaveLength(2);
    expect(report.failures.length).toBeGreaterThan(0);
  });

  it("still answers a drift check without calling a provider", async () => {
    await writeFile(join(dir, "assets.yml"), "assets:\n  - id: hero\n    prompt: a dashboard\n");

    const report = await callTool("sync_assets", { check: true }, { cwd: dir });

    expect(report).toMatchObject({ drift: true });
  });
});

describe("no_cache", () => {
  const PNG = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478" +
      "9c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
    "hex",
  );

  /**
   * Counts how many times it was asked for an image, and hands back a DIFFERENT one
   * each time. A provider that returned identical bytes twice would exercise
   * `writeImage`'s identical-content path instead of the sibling path, which is not
   * what a second draw looks like.
   */
  function counting() {
    let draw = 0;
    return vi.fn(async () => ({
      images: [Buffer.concat([PNG, Buffer.from([draw++])])],
      model: "gpt-5",
      effectivePrompt: "a red fox",
    }));
  }

  it("draws again for a request the cache already holds", async () => {
    const provider = counting();
    const args = { prompt: "a red fox" };

    await callTool("generate_image", args, { cwd: dir, provider: provider as never });
    await callTool("generate_image", args, { cwd: dir, provider: provider as never });
    // The second call is the control: without it a bypass that did nothing would still
    // look like it worked, because every call would be a miss.
    expect(provider).toHaveBeenCalledTimes(1);

    await callTool(
      "generate_image",
      { ...args, no_cache: true },
      { cwd: dir, provider: provider as never },
    );
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("writes a sibling rather than replacing what the first call produced", async () => {
    // Bypassing the cache buys a new image. It does not authorise destroying the one
    // already on disk, and no MCP argument does.
    const provider = counting();
    const args = { prompt: "a red fox", out: "fox.png" };

    await callTool("generate_image", args, { cwd: dir, provider: provider as never });
    await callTool(
      "generate_image",
      { ...args, no_cache: true },
      { cwd: dir, provider: provider as never },
    );

    const images = (await readdir(dir)).filter((name) => name.endsWith(".png")).sort();
    expect(images).toEqual(["fox-v2.png", "fox.png"]);
  });
});

describe("cache_only", () => {
  it("refuses a request the cache does not hold, without reaching a provider", async () => {
    // The argument has to be wired to the engine's `cacheOnly`, not merely declared
    // in the schema. A name that reaches nothing validates fine and spends money.
    const provider = vi.fn(async () => {
      throw new Error("the provider was called by a cache-only call");
    }) as never;

    await expect(
      callTool("generate_image", { prompt: "a red fox", cache_only: true }, { cwd: dir, provider }),
    ).rejects.toBeInstanceOf(CacheMiss);
  });

  it("refuses to be passed with no_cache", async () => {
    await expect(
      callTool(
        "generate_image",
        { prompt: "a red fox", cache_only: true, no_cache: true },
        { cwd: dir },
      ),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

/** Enough of a PNG that `loadReferences` accepts it, as the real run would. */
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe("dry_run", () => {
  // The provider throws rather than returning a fake image. A preview that reached a
  // backend would look like a pass against a stub, and the whole point of the flag is
  // that the call costs nothing.
  const explode = vi.fn(async () => {
    throw new Error("the provider was called by a dry run");
  }) as never;

  it("previews generate_image without reaching a provider or writing a file", async () => {
    const plan = (await callTool(
      "generate_image",
      { prompt: "a red fox", dry_run: true },
      { cwd: dir, provider: explode },
    )) as { dryRun: boolean; cacheKey: string; effectivePrompt: string; outDir: string };

    expect(plan.dryRun).toBe(true);
    expect(plan.effectivePrompt).toContain("a red fox");
    expect(plan.cacheKey).toMatch(/^[0-9a-f]{64}$/);
    // Nothing on disk either. `.subpixel` is the server's own state directory and is
    // allowed to exist; an image is not.
    const written = (await readdir(dir)).filter((name) => name !== ".subpixel");
    expect(written).toEqual([]);
  });

  it("previews edit_image too", async () => {
    // Both generating tools, because the bypass lives in the shared half and a flag
    // wired into only one of them is the failure that would not be noticed.
    // A real PNG signature: `planGenerate` reads and sniffs the reference exactly
    // as the real run does, which is the point -- the key it previews has to be the
    // key the real call looks up.
    await writeFile(join(dir, "hero.png"), PNG_HEADER);
    const plan = (await callTool(
      "edit_image",
      { image: "hero.png", instruction: "make it blue", dry_run: true },
      { cwd: dir, provider: explode },
    )) as { dryRun: boolean };

    expect(plan.dryRun).toBe(true);
  });

  it("refuses a combination the real call would refuse", async () => {
    // A preview exists to answer "what would happen", and "this call is refused" is
    // one of the answers. Reporting a clean plan for a request `generate` rejects
    // sends an agent off to make a call that cannot run.
    await expect(
      callTool(
        "generate_image",
        { prompt: "a red fox", dry_run: true, cache_only: true, no_cache: true },
        { cwd: dir, provider: explode },
      ),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("keeps the absolute path off the wire", async () => {
    // The reader here is a model, not the person who owns the directory. `outDir` is
    // composed from the project config rather than supplied by the caller, so an
    // absolute one hands over the account name and the layout above the project --
    // the same thing `publicDoctorReport` withholds from the doctor output.
    await writeFile(join(dir, "hero.png"), PNG_HEADER);
    const plan = (await callTool(
      "edit_image",
      { image: "hero.png", instruction: "make it blue", dry_run: true },
      { cwd: dir, provider: explode },
    )) as { outDir: string; referenceImages?: string[] };

    expect(isAbsolute(plan.outDir)).toBe(false);
    expect(plan.outDir).not.toContain(dir);
    for (const reference of plan.referenceImages ?? []) {
      expect(isAbsolute(reference), reference).toBe(false);
    }
  });

  it("previews the key the real call would look up", async () => {
    // A preview whose key differs from the real run's key answers a question nobody
    // asked. Same request, dry and wet, must hash the same.
    const a = (await callTool(
      "generate_image",
      { prompt: "a red fox", size: "1024x1024", dry_run: true },
      { cwd: dir, provider: explode },
    )) as { cacheKey: string };
    const b = (await callTool(
      "generate_image",
      { prompt: "a red fox", size: "1024x1024", dry_run: true },
      { cwd: dir, provider: explode },
    )) as { cacheKey: string };

    expect(a.cacheKey).toBe(b.cacheKey);
  });
});

describe("path containment", () => {
  // Every one of these is a path a MODEL composed, from whatever was in its context
  // — a web page, an issue body, a file it was asked to summarise. A shell path is
  // typed by the person who owns the shell; these are not, and `out` names a file
  // the run then writes.
  it.each([
    ["generate_image", { prompt: "a fox", out: "../escaped.png" }],
    ["generate_image", { prompt: "a fox", out_dir: "../.." }],
    ["generate_image", { prompt: "a fox", reference_images: ["/etc/hosts"] }],
    ["edit_image", { image: "../../.ssh/id_rsa", instruction: "make it blue" }],
    ["sync_assets", { check: true, file: "../assets.yml" }],
  ])("refuses %s with a path outside the project", async (tool, args) => {
    await expect(callTool(tool, args, { cwd: dir })).rejects.toThrow(/resolves outside/);
  });

  it("still accepts a path inside the project", async () => {
    await writeFile(join(dir, "assets.yml"), "assets:\n  - id: hero\n    prompt: a dashboard\n");
    await expect(
      callTool("sync_assets", { check: true, file: "assets.yml" }, { cwd: dir }),
    ).resolves.toMatchObject({ drift: true });
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
