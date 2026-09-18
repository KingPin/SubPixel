import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  collectDoctorReport,
  formatDoctorReport,
  publicDoctorReport,
  type DoctorReport,
} from "../../src/cli/doctor.js";
import { applyInit, planInit } from "../../src/install/init.js";

let home: string;

function makeJwt(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ exp: expSeconds })}.sig`;
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "subpixel-doctor-"));
});

async function seedAuth(mode = "chatgpt"): Promise<string> {
  const path = join(home, "auth.json");
  await writeFile(
    path,
    JSON.stringify({
      auth_mode: mode,
      tokens: {
        access_token: makeJwt(FUTURE),
        refresh_token: "rt_secret_value_here",
        account_id: "acct_123",
      },
    }),
  );
  return path;
}

describe("collectDoctorReport", () => {
  it("reports healthy when auth is usable", async () => {
    const report = await collectDoctorReport({
      authPath: await seedAuth(),
      cachePath: join(home, "missing.json"),
    });
    expect(report.ok).toBe(true);
    expect(report.auth.present).toBe(true);
    expect(report.auth.mode).toBe("chatgpt");
    expect(report.auth.expired).toBe(false);
    expect(report.model.slug).toBeTruthy();
    expect(report.model.source).toBe("bundled");
  });

  it("reports unhealthy when auth is missing", async () => {
    const report = await collectDoctorReport({
      authPath: join(home, "nope.json"),
      cachePath: join(home, "missing.json"),
    });
    expect(report.ok).toBe(false);
    expect(report.auth.present).toBe(false);
    expect(report.auth.problem).toContain("codex login");
  });

  it("reports unhealthy for an apikey login", async () => {
    const report = await collectDoctorReport({
      authPath: await seedAuth("apikey"),
      cachePath: join(home, "missing.json"),
    });
    expect(report.ok).toBe(false);
  });

  it("includes the node version and the ToS notice", async () => {
    const report = await collectDoctorReport({
      authPath: await seedAuth(),
      cachePath: join(home, "missing.json"),
    });
    expect(report.node).toBe(process.version);
    expect(report.notice).toContain("undocumented");
  });

  it("never includes a token value", async () => {
    const report = await collectDoctorReport({
      authPath: await seedAuth(),
      cachePath: join(home, "missing.json"),
    });
    expect(JSON.stringify(report)).not.toContain("rt_secret_value_here");
  });
});

describe("formatDoctorReport", () => {
  it("renders human-readable lines", async () => {
    const report = await collectDoctorReport({
      authPath: await seedAuth(),
      cachePath: join(home, "missing.json"),
    });
    const text = formatDoctorReport(report);
    expect(text).toContain("Node");
    expect(text).toContain("Auth");
    expect(text).toContain("Model");
    expect(text).not.toContain("rt_secret_value_here");
  });
});

describe("collectDoctorReport quota reporting", () => {
  async function baseOptions(quotaPath: string) {
    return { authPath: await seedAuth(), cachePath: join(home, "missing.json"), quotaPath };
  }

  it("reports the last recorded quota reading", async () => {
    const quotaPath = join(home, "quota.json");
    await writeFile(
      quotaPath,
      JSON.stringify({
        planType: "plus",
        observedAt: new Date().toISOString(),
        windows: [{ usedPercent: 96, windowMinutes: 300 }],
      }),
    );
    const report = await collectDoctorReport(await baseOptions(quotaPath));
    expect(report.quota.warn).toBe(true);
    expect(report.quota.stale).toBe(false);
    expect(report.quota.observedAt).toBeDefined();
    // A nearly-spent allowance is a warning, not a broken environment.
    expect(report.ok).toBe(true);
    expect(formatDoctorReport(report)).toMatch(/96% of the 5h window used/);
  });

  it("labels an old reading stale", async () => {
    const quotaPath = join(home, "quota.json");
    await writeFile(
      quotaPath,
      JSON.stringify({
        planType: "plus",
        observedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
        windows: [{ usedPercent: 10, windowMinutes: 300 }],
      }),
    );
    const report = await collectDoctorReport(await baseOptions(quotaPath));
    expect(report.quota.stale).toBe(true);
    expect(report.quota.summary).toContain("(stale)");
  });

  it("reports an unknown quota without failing the report", async () => {
    const report = await collectDoctorReport(await baseOptions(join(home, "absent.json")));
    expect(report.quota.warn).toBe(false);
    expect(report.quota.summary).toContain("unknown");
  });

  it("reads the quota of the project, not of the process", async () => {
    // `spx generate` writes the reading to `<cwd>/.subpixel/quota.json` for the project
    // it was pointed at. Under MCP the server's own directory is somewhere else
    // entirely, so a doctor that defaulted to `process.cwd()` would report an allowance
    // belonging to a different project -- usually none at all.
    const tree = await mkdtemp(join(tmpdir(), "subpixel-doctor-quota-"));
    await mkdir(join(tree, ".subpixel"), { recursive: true });
    await writeFile(
      join(tree, ".subpixel", "quota.json"),
      JSON.stringify({
        planType: "plus",
        observedAt: new Date().toISOString(),
        windows: [{ usedPercent: 96, windowMinutes: 300 }],
      }),
    );
    const report = await collectDoctorReport({
      cwd: tree,
      home,
      env: {},
      authPath: await seedAuth(),
      cachePath: join(home, "missing.json"),
    });
    expect(report.quota.warn).toBe(true);
    expect(report.quota.stale).toBe(false);
  });

  it("survives a corrupt quota file", async () => {
    const quotaPath = join(home, "quota.json");
    await writeFile(quotaPath, "{ not json");
    const report = await collectDoctorReport(await baseOptions(quotaPath));
    expect(report.quota.summary).toContain("unknown");
    expect(report.ok).toBe(true);
  });
});

describe("the install section", () => {
  /** `home` is a fresh temp dir, so no optional harness is detected. */
  async function report(cwd: string) {
    return collectDoctorReport({
      cwd,
      home,
      env: {},
      authPath: await seedAuth(),
      cachePath: join(home, "missing.json"),
      quotaPath: join(home, "absent.json"),
    });
  }

  it("names the harnesses still waiting for `spx init`", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "subpixel-doctor-init-"));
    const result = await report(fresh);
    expect(result.install.ok).toBe(false);
    expect(result.install.pending).toContain("claude-skill");
    // An absent harness is not pending. Nagging about Windsurf on a machine without
    // Windsurf is how a FAIL line stops being read.
    expect(result.install.pending).not.toContain("windsurf");
    // Nor is an opt-in target. `doctor` reports what a plain `spx init` would do.
    expect(result.install.pending).not.toContain("claude-mcp");
    expect(formatDoctorReport(result)).toContain("run `spx init` for");
  });

  it("goes quiet once init has been run", async () => {
    const tree = await mkdtemp(join(tmpdir(), "subpixel-doctor-init-"));
    await applyInit(await planInit({ cwd: tree, home, env: {} }));
    const result = await report(tree);
    expect(result.install.ok).toBe(true);
    expect(result.install.pending).toEqual([]);
    expect(result.install.configured).toContain("claude-skill");
  });

  it("does not let a missing harness config fail the whole report", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "subpixel-doctor-init-"));
    // `ok` means "can this machine generate an image", and an unconfigured editor
    // cannot stop that. Only the install line goes red.
    expect((await report(fresh)).ok).toBe(true);
  });

  it("counts the tools `spx mcp` declares", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "subpixel-doctor-init-"));
    expect((await report(fresh)).mcp.tools).toBeGreaterThan(0);
  });
});

describe("publicDoctorReport", () => {
  const REPORT: DoctorReport = {
    ok: false,
    node: "v24.0.0",
    codexBinary: undefined,
    sharp: true,
    auth: { path: "/home/tester/.codex/auth.json", present: false },
    model: { slug: "gpt-5.6-sol", source: "cache" },
    config: { styles: 0 },
    quota: { summary: "no reading yet", warn: false, stale: true },
    install: { ok: false, configured: [], pending: [], conflicts: [] },
    mcp: { tools: 1 },
    notice: "a notice",
  };

  const withProblem = (problem: string): string | undefined =>
    publicDoctorReport({ ...REPORT, install: { ...REPORT.install, problem } }).install.problem;

  // `install.problem` is whatever `planInit` threw, so the path in it belongs to
  // whichever machine and package manager put subpixel there. Each message below is
  // one Node writes, and the name inside it is what the projection exists to
  // withhold. The posix-with-a-space case is the one a stop-at-whitespace pattern
  // gets wrong: it publishes the first name and drops the rest.
  it.each([
    ["a posix path", "open '/home/tester/.local/share/subpixel/SKILL.md'", "tester"],
    ["a posix path with a space", "open '/Users/Jane Doe/.local/subpixel/SKILL.md'", "Jane"],
    ["a windows drive path", "open 'C:\\Users\\Jane Doe\\AppData\\subpixel\\SKILL.md'", "Jane"],
    ["a UNC path", "open '//nas/team share/subpixel/SKILL.md'", "nas"],
  ])("reduces %s to its filename", (_name, message, secret) => {
    const problem = withProblem(`ENOENT: no such file or directory, ${message}`);
    expect(problem).toBe("ENOENT: no such file or directory, open 'SKILL.md'");
    expect(problem).not.toContain(secret);
  });

  it("leaves a message with no path in it alone", () => {
    expect(withProblem("the bundled skill is empty")).toBe("the bundled skill is empty");
  });

  it("withholds the account id and the disk from every field at once", () => {
    const masked = publicDoctorReport({
      ...REPORT,
      codexBinary: "/home/tester/.local/bin/codex",
      auth: { ...REPORT.auth, accountId: "acct-1a2b3c4d" },
      config: { path: "/home/tester/work/acme/subpixel.config.json", styles: 2 },
    });
    expect(JSON.stringify(masked)).not.toContain("/home/tester");
    expect(JSON.stringify(masked)).not.toContain("acct-1a2b3c4d");
    expect(masked.codexBinary).toBe("codex");
  });
});
