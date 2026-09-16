import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "../core/fsx.js";
import { ConfigError, SubpixelError } from "../core/errors.js";
import { WRITERS, type InitContext, type Scope, type Writer } from "./writers.js";

/**
 * What `init` decided about one target.
 *
 * `absent`, `conflict`, `unsupported`, and `stale` are all "nothing was written", but
 * they are different answers and a user acts on them differently: `absent` means the
 * harness is not installed, `conflict` means it is and we refused to guess at its
 * config, `unsupported` means `--global` was asked for a target that only exists
 * inside a project, and `stale` means the file moved under us between the plan and
 * the write.
 */
export type TargetState =
  | "created"
  | "updated"
  | "unchanged"
  | "absent"
  | "conflict"
  | "unsupported"
  | "stale";

export interface TargetPlan {
  id: string;
  title: string;
  scope: Scope;
  path: string;
  state: TargetState;
  /** The file exactly as it would be written. Absent when nothing would be. */
  content?: string;
  /**
   * A note printed beside the target. Usually why nothing was written — `absent`,
   * `conflict`, `unsupported` and `stale` each carry one — and for a forced write,
   * where the contents it replaces were kept.
   */
  reason?: string;
  /**
   * `--force` rebuilt this file from scratch instead of merging into it.
   *
   * The merge is what keeps everything in a file that is not ours, and a file we could
   * not parse gets no merge, so a forced write is the one write that drops content.
   * `~/.claude.json` is the case that matters: it holds Claude Code's session state
   * rather than an MCP config we own. `applyInit` keeps the old bytes beside the file
   * so the choice is not between a working harness and that history.
   */
  discarded?: boolean;
  /**
   * What was in the file when the plan read it, as a hash.
   *
   * `applyInit` writes a whole file built by merging into what `planInit` read, so
   * anything written to that file in between is inside what we are about to
   * overwrite. `~/.claude.json` is the case that matters: Claude Code writes it while
   * it runs, which is exactly when a user runs `spx init --global` from inside it.
   *
   * A hash rather than the bytes, because a state file's contents are not ours to
   * hold in memory for longer than the merge needs them.
   */
  observed?: string;
}

export interface InitOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Replace a target we could not parse, instead of reporting it and skipping. */
  force?: boolean;
  /** The bundled skill text. Read from the package when absent. */
  skill?: string;
  /**
   * Writer ids to plan, in place of the default set.
   *
   * Absent means the default set, which is every writer that is not `optIn`. An empty
   * list is a caller who meant to name something and named nothing, so it throws
   * rather than silently becoming the default set — the one wrong answer here is the
   * one that writes MORE than was asked for.
   */
  only?: string[];
  /**
   * Write each harness its user-scoped config, so every project gets subpixel.
   *
   * It only moves the targets that HAVE a user-scoped form. The ones already user
   * scoped do not move, and `AGENTS.md` — which is a file in a repository and
   * nothing else — is reported as unsupported.
   */
  global?: boolean;
}

/**
 * Resolve `--only` to the writers it names.
 *
 * An unknown id throws rather than being ignored, because the alternative is a run
 * that reports "nothing to do" for a typo and leaves the user believing the harness
 * they asked for is configured.
 *
 * Naming an opt-in writer is how it gets planned at all. Every id is nameable; only
 * the default set is narrower than the table.
 */
function selectWriters(only: string[] | undefined): Writer[] {
  if (only === undefined) return WRITERS.filter((w) => w.optIn !== true);
  const known = WRITERS.map((writer) => writer.id);
  // Naming nothing is not the same as naming no preference. `--only ''` and `--only ,`
  // both arrive here as `[]`, and treating that as the default set turns a malformed
  // flag into a run that writes every target the user was trying to narrow away from.
  if (only.length === 0) {
    throw new ConfigError(`No init target was named. Known targets: ${known.join(", ")}.`);
  }
  const unknown = only.filter((id) => !known.includes(id));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown init target${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
        `Known targets: ${known.join(", ")}.`,
    );
  }
  return WRITERS.filter((writer) => only.includes(writer.id));
}

/** `TargetPlan.observed`. A file that is not there is a state worth recognising too. */
/** Where a forced write leaves what it replaced. */
function backupPath(path: string): string {
  return `${path}.bak`;
}

function fingerprint(existing: string | undefined): string {
  if (existing === undefined) return "absent";
  return createHash("sha256").update(existing).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The `skills/subpixel/SKILL.md` shipped in the package, beside `dist/`. */
export async function bundledSkill(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFile(join(here, "..", "..", "skills", "subpixel", "SKILL.md"), "utf8");
}

async function planTarget(
  writer: Writer,
  ctx: InitContext,
  options: { force: boolean; global: boolean },
): Promise<TargetPlan> {
  // A user-scoped writer is already global, so `--global` only redirects the
  // project-scoped ones.
  const global = options.global && writer.scope === "project";
  const target = global ? writer.globalTarget?.(ctx) : undefined;
  const base = {
    id: writer.id,
    title: writer.title,
    scope: global ? ("user" as const) : writer.scope,
    path: target?.path ?? writer.path(ctx),
  };

  if (global && target === undefined) {
    return {
      ...base,
      scope: writer.scope,
      state: "unsupported",
      reason: "this target only exists inside a project; run without --global",
    };
  }

  const marker = target?.marker ?? writer.marker?.(ctx);
  if (marker !== undefined && !(await pathExists(marker))) {
    return { ...base, state: "absent", reason: `${marker} does not exist` };
  }

  // A read failure is treated as "no file". The only reason to distinguish an
  // unreadable file from a missing one here is to report it, and the write that
  // follows will report it far more precisely than a guess at this point could.
  const existing = await readFile(base.path, "utf8").catch(() => undefined);
  const writeCtx: InitContext = { ...ctx, dest: base.path };

  let content: string;
  let discarded = false;
  try {
    content = writer.write(existing, writeCtx);
  } catch (err) {
    if (!(err instanceof SubpixelError)) throw err;
    // --force is expressed as "there is nothing there", which is the whole of what
    // force means: regenerate from scratch rather than merge into content we could
    // not parse. It is deliberately NOT a second code path.
    //
    // And it applies ONLY once the merge has actually failed. Forcing before the
    // attempt made `--force` mean "rewrite every target from scratch", which drops
    // unrelated servers from a perfectly parseable `.mcp.json` and replaces hand
    // written `AGENTS.md` prose — neither of which the flag promises.
    if (!options.force) return { ...base, state: "conflict", reason: err.message };
    content = writer.write(undefined, writeCtx);
    discarded = existing !== undefined;
  }

  if (content === existing) return { ...base, state: "unchanged", content };
  return {
    ...base,
    state: existing === undefined ? "created" : "updated",
    content,
    observed: fingerprint(existing),
    ...(discarded
      ? {
          discarded,
          reason: `could not be parsed; --force rebuilds it and keeps the old file as ${backupPath(base.path)}`,
        }
      : {}),
  };
}

/** Decide what every target needs. Reads the filesystem; writes nothing. */
export async function planInit(options: InitOptions = {}): Promise<TargetPlan[]> {
  const env = options.env ?? process.env;
  const ctx: InitContext = {
    cwd: options.cwd ?? process.cwd(),
    home: options.home ?? homedir(),
    skill: options.skill ?? (await bundledSkill()),
    // Replaced per target by `planTarget`; a writer never renders against this one.
    dest: "",
    ...(env.XDG_CONFIG_HOME ? { xdgConfigHome: env.XDG_CONFIG_HOME } : {}),
  };
  const flags = { force: options.force === true, global: options.global === true };
  return Promise.all(selectWriters(options.only).map((writer) => planTarget(writer, ctx, flags)));
}

/**
 * The mode to write a target with.
 *
 * `atomicWrite` renames a fresh file over the target, so the new inode carries the
 * mode we hand it and not the one the old file had. Left to the default, updating a
 * `0600` `~/.claude.json` would hand it back at `0644` — readable by every other
 * account on the machine — and nothing in the output would say so. So an existing
 * file keeps its own mode, whatever the user set it to.
 *
 * A file we create under `$HOME` gets `0600` rather than the default, because a
 * user-scoped config is one user's business and the umask that would otherwise decide
 * this is not something the user chose per file. Project-scoped files keep the default:
 * they are checked in and shared with the team, which is the whole point of them.
 */
async function writeMode(target: TargetPlan): Promise<number | undefined> {
  const existing = await stat(target.path).catch(() => undefined);
  if (existing !== undefined) return existing.mode & 0o777;
  return target.scope === "user" ? 0o600 : undefined;
}

/**
 * Write the targets that need writing. Returns the ones that were written.
 *
 * Each write is a whole file built out of what `planInit` read, so a target that
 * changed in between is a target whose change is inside what we would overwrite. The
 * write is refused and the plan entry is marked `stale`; re-running merges into what
 * is there now, which is the answer the user wants anyway.
 *
 * This narrows the window rather than closing it — no lock is taken, and the harness
 * that owns the file would not be holding ours. What it rules out is the case we can
 * see: destroying a change we already know about.
 */
export async function applyInit(plan: TargetPlan[]): Promise<TargetPlan[]> {
  const pending = plan.filter(
    (target) => target.state === "created" || target.state === "updated",
  );
  const written: TargetPlan[] = [];
  for (const target of pending) {
    const current = await readFile(target.path, "utf8").catch(() => undefined);
    if (target.observed !== undefined && fingerprint(current) !== target.observed) {
      target.state = "stale";
      target.reason = "changed while init was reading it; run init again";
      continue;
    }
    const mode = await writeMode(target);
    const options = mode !== undefined ? { mode } : {};
    // The only write that is not a merge, so the only one that can lose something.
    // The copy goes next to the file, with the file's own mode, because a state file's
    // backup is as private as the state file.
    if (target.discarded === true && current !== undefined) {
      await atomicWrite(backupPath(target.path), current, options);
    }
    await atomicWrite(target.path, target.content!, options);
    written.push(target);
  }
  return written;
}

const VERBS: Record<TargetState, string> = {
  created: "create",
  updated: "update",
  unchanged: "already current",
  absent: "not installed",
  conflict: "CONFLICT",
  unsupported: "project only",
  stale: "CHANGED",
};

/**
 * A dry run prints a changed file in full only while "in full" is a screenful.
 *
 * The premise of printing the whole file is that these are a few lines of JSON and a
 * diff would hide the one line that matters. `~/.claude.json` breaks that premise: it
 * is Claude Code's state file, hundreds of kilobytes of session history that
 * `--global --only claude-mcp` merges a single entry into. Printing the merged result
 * would put that state on stdout, into scrollback, and into whatever log captured the
 * run.
 *
 * The limit is on size rather than on that one path, because the hazard belongs to
 * every file we merge into rather than write: any of them can be a state file on a
 * machine we have not seen.
 */
const DRY_RUN_FULL_PRINT_LIMIT = 16_384;

/**
 * Render the plan for a human.
 */
export function formatInitPlan(plan: TargetPlan[], dryRun: boolean): string {
  const lines: string[] = [];
  if (dryRun) lines.push("Dry run. Nothing was written.", "");

  for (const target of plan) {
    // The id is printed because it is the only place a user can read the vocabulary
    // `--only` expects, and a flag whose values are undiscoverable is a flag nobody uses.
    lines.push(
      `${VERBS[target.state].padEnd(14)} ${target.path}  (${target.id} — ${target.title})`,
    );
    if (target.reason !== undefined) lines.push(`               ${target.reason}`);
  }

  const conflicts = plan.filter((target) => target.state === "conflict");
  if (conflicts.length > 0) {
    lines.push("", "Nothing was written to the files above. Re-run with --force to replace them.");
  }

  // Deliberately not the --force advice above: forcing would hit the same check, and
  // the fix is a fresh read rather than a bigger hammer.
  const stale = plan.filter((target) => target.state === "stale");
  if (stale.length > 0) {
    lines.push(
      "",
      "The files above changed while init was running, so nothing was written to " +
        "them. Run init again to merge into what is there now.",
    );
  }

  // An opt-in target is absent from the report entirely, so the report has to say it
  // exists. A default nobody can discover is a default nobody can change.
  const planned = new Set(plan.map((target) => target.id));
  for (const writer of WRITERS) {
    if (writer.optIn !== true || planned.has(writer.id)) continue;
    lines.push("", `Not written by default: ${writer.title}. Add it with --only ${writer.id}.`);
  }

  if (dryRun) {
    for (const target of plan) {
      if (target.state !== "created" && target.state !== "updated") continue;
      const content = target.content!;
      if (content.length > DRY_RUN_FULL_PRINT_LIMIT) {
        lines.push(
          "",
          `--- ${target.path}`,
          `${content.length} bytes, not shown. A file this size is the harness's own ` +
            `state file; init merges its one entry into it and leaves every other key ` +
            `alone. Read the file itself if you need to see what is in there.`,
        );
        continue;
      }
      lines.push("", `--- ${target.path}`, content.replace(/\n$/, ""));
    }
  }

  // A user-scoped config has no project to belong to, so the server it launches runs
  // wherever the host runs. Said here because it is the one thing about `init` that
  // surprises people: the Windsurf entry is not "this project", it is "every project".
  if (plan.some((target) => target.scope === "user" && target.state !== "absent")) {
    lines.push(
      "",
      "The user-scoped entries above apply to every project you open in that harness.",
      "The server reads whichever subpixel.config.* and assets.yml sit in the directory the host runs from.",
    );
  }

  return lines.join("\n");
}

/** True when every target that could be configured already is. Used by `spx doctor`. */
export function initIsCurrent(plan: TargetPlan[]): boolean {
  return plan.every(
    (target) =>
      target.state === "unchanged" || target.state === "absent" || target.state === "unsupported",
  );
}
