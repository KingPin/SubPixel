import { basename, join, posix, win32 } from "node:path";
import { authPath, decodeJwtExp, isExpired, readAuth } from "../auth/read.js";
import { findOnPath } from "../core/fsx.js";
import { modelCachePath, resolveModel } from "../providers/models.js";
import { formatQuota, isQuotaStale, loadQuota, shouldWarn } from "../providers/quota.js";
import { sharpAvailable } from "../engine/sharpx.js";
import { loadConfig } from "../config/load.js";
import { initIsCurrent, planInit, type TargetPlan } from "../install/init.js";
import { TOOLS } from "../mcp/tools.js";

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
  config: {
    /** The config file in force, or undefined when the project has none. */
    path?: string;
    styles: number;
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
  /**
   * Which agent harnesses on this machine have been pointed at subpixel.
   *
   * Derived from the same pure writers `spx init` uses: a target is configured when
   * re-running its writer would change nothing. That is the only definition that
   * cannot drift from what `init` actually writes.
   */
  install: {
    ok: boolean;
    configured: string[];
    pending: string[];
    conflicts: string[];
    problem?: string;
  };
  mcp: {
    /** How many tools `spx mcp` declares. Zero means the server did not build. */
    tools: number;
  };
  notice: string;
}

export interface DoctorOptions {
  cwd?: string;
  authPath?: string;
  cachePath?: string;
  quotaPath?: string;
  env?: NodeJS.ProcessEnv;
  /** The home directory the user-scoped harness configs are looked for under. */
  home?: string;
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

  const loaded = await loadConfig({ cwd: options.cwd });

  // Never throws. `planInit` reads the bundled skill and stats a handful of
  // directories; a package installed without its skills directory is worth naming in
  // the report, and is not worth turning the whole report into an exception.
  let plan: TargetPlan[] = [];
  let installProblem: string | undefined;
  try {
    plan = await planInit({
      cwd: options.cwd,
      ...(options.home !== undefined ? { home: options.home } : {}),
      env,
    });
  } catch (err) {
    installProblem = (err as Error).message;
  }

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
    config: { path: loaded.path, styles: Object.keys(loaded.config.styles ?? {}).length },
    install: {
      ok: installProblem === undefined && initIsCurrent(plan),
      configured: plan.filter((t) => t.state === "unchanged").map((t) => t.id),
      pending: plan.filter((t) => t.state === "created" || t.state === "updated").map((t) => t.id),
      conflicts: plan.filter((t) => t.state === "conflict").map((t) => t.id),
      ...(installProblem !== undefined ? { problem: installProblem } : {}),
    },
    mcp: { tools: TOOLS.length },
    quota: {
      summary: formatQuota(quotaReading),
      warn: shouldWarn(quotaReading),
      stale: isQuotaStale(quotaReading),
      observedAt: quotaReading?.observedAt,
    },
    notice: TOS_NOTICE,
  };
}

/**
 * Drop the directories from one known path wherever it appears in free text.
 *
 * A literal split/join rather than a pattern. The path is known exactly at every
 * call site here, and the alternative is a regex over prose that has to guess
 * where a path ends.
 */
function shorten(text: string, path: string): string {
  return text.split(path).join(basename(path));
}

/**
 * The last segment of one path, whichever platform spelled it.
 *
 * `basename` is this platform's, and the text being scrubbed is not necessarily
 * from this platform: a Windows error names `C:\Users\...` and `posix.basename`
 * would hand back the whole thing as one segment. Dispatch on the root, not on the
 * separators inside, because a backslash is a legal character in a POSIX filename.
 */
function pathLeaf(path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) return win32.basename(path);
  return posix.basename(path);
}

/**
 * Drop the directories from every absolute path in free text.
 *
 * `shorten` cannot do this one: the paths are not known at the call site. A
 * `planInit` failure names whatever file it could not read -- a bundled asset
 * inside the installed package, or a writer target under the user's home -- and
 * which one it is depends on how subpixel was installed.
 *
 * Quoted forms first, because a path is the one thing in these messages that can
 * contain a space: Node quotes the whole path in an ENOENT, and stopping at the
 * first space in `/Users/Jane Doe/...` would publish the half that names the user.
 * The unquoted alternatives run second and cover the POSIX, drive-letter and UNC
 * roots.
 *
 * None of these can backtrack. Every alternative is a literal root followed by one
 * `+` over a character class that excludes its own terminator, so each has exactly
 * one way to match at a given position.
 *
 * ponytail: an UNQUOTED path with a space still leaks the segment the space splits.
 * `/Users/Jane Doe/x` becomes `Jane Doex`, which is the first name -- the exact
 * thing this function exists to withhold. Every message that reaches
 * `install.problem` is a Node fs error, and those quote the path they name, so the
 * shape is unreached rather than handled. The fix if one ever turns up is to
 * replace the home directory with `~` before matching, which needs a `home` this
 * pure function is not given.
 */
function shortenPaths(text: string): string {
  return text
    .replace(/(['"])(\/[^'"\r\n]+|[A-Za-z]:[\\/][^'"\r\n]+|\\\\[^'"\r\n]+)\1/g, (_match, quote, path) => {
      return `${quote}${pathLeaf(path)}${quote}`;
    })
    .replace(/\/[^\s'"]+|[A-Za-z]:[\\/][^\s'"]+|\\\\[^\s'"]+/g, (path) => pathLeaf(path));
}

/**
 * The doctor report as a model is allowed to see it.
 *
 * `spx doctor` is written for a person looking at their own machine, so it names
 * absolute paths and the ChatGPT account behind the subscription. Over MCP the
 * same object goes to whatever model the host happens to run, through whatever
 * provider it happens to use. None of it is a credential, but `accountId` is a
 * stable identifier for a paying account, and an absolute path carries the user's
 * name and the shape of their disk.
 *
 * Neither is needed to act on the report. Every decision doctor drives is "is this
 * present, is it expired, is it current", and a basename keeps the half that
 * answers it: "auth.json is not valid JSON" is still the whole diagnosis. Only the
 * address is withheld.
 */
export function publicDoctorReport(report: DoctorReport): DoctorReport {
  const { accountId: _accountId, ...auth } = report.auth;
  return {
    ...report,
    codexBinary: report.codexBinary === undefined ? undefined : basename(report.codexBinary),
    auth: {
      ...auth,
      path: basename(report.auth.path),
      // readAuth builds its messages out of the same path, so masking the field
      // alone would leave the path in the sentence beside it.
      ...(auth.problem !== undefined ? { problem: shorten(auth.problem, report.auth.path) } : {}),
    },
    config: {
      ...report.config,
      ...(report.config.path !== undefined ? { path: basename(report.config.path) } : {}),
    },
    install: {
      ...report.install,
      // The other free-text field, and the other one built out of a path. A package
      // installed without its skills directory puts the absolute path of the missing
      // file here, which the spread above would otherwise copy out verbatim.
      ...(report.install.problem !== undefined
        ? { problem: shortenPaths(report.install.problem) }
        : {}),
    },
  };
}

function describeInstall(install: DoctorReport["install"]): string {
  if (install.problem !== undefined) return install.problem;
  const parts: string[] = [];
  if (install.configured.length > 0) parts.push(`configured: ${install.configured.join(", ")}`);
  if (install.pending.length > 0) parts.push(`run \`spx init\` for: ${install.pending.join(", ")}`);
  if (install.conflicts.length > 0) parts.push(`conflicts: ${install.conflicts.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : "no agent harness detected";
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
  lines.push(
    `${mark(true)} config    ${report.config.path ?? "none"}${report.config.styles > 0 ? ` (${report.config.styles} styles)` : ""}`,
  );
  lines.push(`${mark(report.mcp.tools > 0)} mcp       ${report.mcp.tools} tools on \`spx mcp\``);
  lines.push(`${mark(report.install.ok)} init      ${describeInstall(report.install)}`);
  // `mark` is inverted here on purpose. Every other line marks "is this present and
  // usable"; this one marks "is there room left". A reading above the threshold is the
  // one thing in the report the user can act on before it bites, so it gets the FAIL
  // column even though nothing is broken. `report.ok` is deliberately unaffected.
  lines.push(`${mark(!report.quota.warn)} ${report.quota.summary}`);
  lines.push("");
  lines.push(report.notice);
  return lines.join("\n");
}
