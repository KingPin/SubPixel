import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { collectDoctorReport, formatDoctorReport } from "../../src/cli/doctor.js";

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
