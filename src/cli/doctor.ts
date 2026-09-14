import { join } from "node:path";
import { authPath, decodeJwtExp, isExpired, readAuth } from "../auth/read.js";
import { findOnPath } from "../core/fsx.js";
import { modelCachePath, resolveModel } from "../providers/models.js";
import { formatQuota, isQuotaStale, loadQuota, shouldWarn } from "../providers/quota.js";
import { sharpAvailable } from "../engine/output.js";

export const TOS_NOTICE =
  "subpixel drives the undocumented chatgpt.com/backend-api/codex endpoint using your " +
  "personal ChatGPT subscription. Do not use it to power a public-facing service.";

export interface DoctorReport {
  ok: boolean;
  node: string;
  codexBinary: string | undefined;
  sharp: boolean;
  auth: {
    path: string;
    present: boolean;
    mode?: string;
    expired?: boolean;
    expiresIn?: string;
    accountId?: string;
    problem?: string;
  };
  model: {
    slug: string;
    source: string;
    fetchedAt?: string;
    cacheAgeHours?: number;
  };
  quota: {
    /** The one-line human summary, already marked "(stale)" when the reading is old. */
    summary: string;
    /** True when the last reading was at or above the warning threshold. */
    warn: boolean;
    /** True when no reading exists, or the one on disk is older than QUOTA_STALE_MS. */
    stale: boolean;
    /** When the reading was taken. Absent when no reading has ever been recorded. */
    observedAt?: string;
  };
  notice: string;
}

export interface DoctorOptions {
  authPath?: string;
  cachePath?: string;
  quotaPath?: string;
  env?: NodeJS.ProcessEnv;
}

function humanizeDelta(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 0) return `${Math.abs(minutes)}m ago`;
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${Math.round(minutes / 60)}h`;
}

export async function collectDoctorReport(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const resolvedAuthPath = options.authPath ?? authPath(env);

  const auth: DoctorReport["auth"] = { path: resolvedAuthPath, present: false };
  try {
    const credentials = await readAuth(resolvedAuthPath);
    auth.present = true;
    auth.mode = "chatgpt";
    auth.accountId = credentials.accountId;
    auth.expired = isExpired(credentials.accessToken);
    const exp = decodeJwtExp(credentials.accessToken);
    if (exp !== undefined) auth.expiresIn = humanizeDelta(exp - Date.now());
  } catch (err) {
    auth.problem = (err as Error).message;
  }

  const model = await resolveModel({ cachePath: options.cachePath ?? modelCachePath(env) });
  const cacheAgeHours = model.fetchedAt
    ? (Date.now() - Date.parse(model.fetchedAt)) / 3_600_000
    : undefined;

  const sharp = await sharpAvailable();

  // Never throws: `loadQuota` degrades a missing, truncated, or hand-edited file to
  // undefined, and an unknown allowance must not turn a healthy environment into a FAIL.
  const quotaReading = await loadQuota(
    options.quotaPath ?? join(process.cwd(), ".subpixel", "quota.json"),
  );

  return {
    // Expired credentials are still "ok": the engine refreshes them on demand.
    ok: auth.present && auth.problem === undefined,
    node: process.version,
    codexBinary: await findOnPath("codex", env),
    sharp,
    auth,
    model: {
      slug: model.slug,
      source: model.source,
      fetchedAt: model.fetchedAt,
      cacheAgeHours: cacheAgeHours === undefined ? undefined : Math.round(cacheAgeHours * 10) / 10,
    },
    quota: {
      summary: formatQuota(quotaReading),
      warn: shouldWarn(quotaReading),
      stale: isQuotaStale(quotaReading),
      observedAt: quotaReading?.observedAt,
    },
    notice: TOS_NOTICE,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  const mark = (ok: boolean) => (ok ? "ok  " : "FAIL");

  lines.push(`${mark(true)} Node      ${report.node}`);
  lines.push(
    `${mark(report.codexBinary !== undefined)} codex     ${report.codexBinary ?? "not found on PATH (codex-exec fallback unavailable)"}`,
  );
  if (report.auth.present) {
    const expiry = report.auth.expired
      ? `expired ${report.auth.expiresIn ?? ""} (will refresh automatically)`
      : `valid, expires ${report.auth.expiresIn ?? "unknown"}`;
    lines.push(`${mark(true)} Auth      chatgpt login at ${report.auth.path}; ${expiry}`);
  } else {
    lines.push(`${mark(false)} Auth      ${report.auth.problem ?? "unavailable"}`);
  }
  lines.push(
    `${mark(true)} Model     ${report.model.slug} (source: ${report.model.source}` +
      (report.model.cacheAgeHours === undefined ? ")" : `, cache ${report.model.cacheAgeHours}h old)`),
  );
  lines.push(
    `${mark(true)} sharp     ${report.sharp ? "available (--exact-size enabled)" : "not installed (--exact-size unavailable)"}`,
  );
  // `mark` is inverted here on purpose. Every other line marks "is this present and
  // usable"; this one marks "is there room left". A reading above the threshold is the
  // one thing in the report the user can act on before it bites, so it gets the FAIL
  // column even though nothing is broken. `report.ok` is deliberately unaffected.
  lines.push(`${mark(!report.quota.warn)} ${report.quota.summary}`);
  lines.push("");
  lines.push(report.notice);
  return lines.join("\n");
}
