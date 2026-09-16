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
 * `absent`, `conflict`, and `unsupported` are all "nothing was written", but they
 * are different answers and a user acts on them differently: `absent` means the
 * harness is not installed, `conflict` means it is and we refused to guess at its
 * config, and `unsupported` means `--global` was asked for a target that only exists
 * inside a project.
 */
export type TargetState =
  | "created"
  | "updated"
  | "unchanged"
  | "absent"
  | "conflict"
  | "unsupported";

export interface TargetPlan {
  id: string;
  title: string;
  scope: Scope;
  path: string;
  state: TargetState;
  /** The file exactly as it would be written. Absent when nothing would be. */
  content?: string;
  /** Why nothing was written. Present for `absent`, `conflict`, and `unsupported`. */
  reason?: string;
}

export interface InitOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Replace a target we could not parse, instead of reporting it and skipping. */
  force?: boolean;
  /** The bundled skill text. Read from the package when absent. */
  skill?: string;
  /** Writer ids to plan, in place of every writer. Absent or empty means all of them. */
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
 */
function selectWriters(only: string[] | undefined): Writer[] {
  if (only === undefined || only.length === 0) return WRITERS;
  const known = WRITERS.map((writer) => writer.id);
  const unknown = only.filter((id) => !known.includes(id));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown init target${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
        `Known targets: ${known.join(", ")}.`,
    );
  }
  return WRITERS.filter((writer) => only.includes(writer.id));
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
  }

  if (content === existing) return { ...base, state: "unchanged", content };
  return { ...base, state: existing === undefined ? "created" : "updated", content };
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

/** Write the targets that need writing. Returns the ones that were written. */
export async function applyInit(plan: TargetPlan[]): Promise<TargetPlan[]> {
  const pending = plan.filter(
    (target) => target.state === "created" || target.state === "updated",
  );
  for (const target of pending) {
    await atomicWrite(target.path, target.content!);
  }
  return pending;
}

const VERBS: Record<TargetState, string> = {
  created: "create",
  updated: "update",
  unchanged: "already current",
  absent: "not installed",
  conflict: "CONFLICT",
  unsupported: "project only",
};

/**
 * Render the plan for a human.
 *
 * A dry run prints each changed file in full rather than a line diff. The files are
 * a few lines of JSON, so the whole thing fits on a screen, and a merged config is
 * exactly the kind of output where a diff hides the one line that matters — the
 * launch command — inside context the reader skims.
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

  if (dryRun) {
    for (const target of plan) {
      if (target.state !== "created" && target.state !== "updated") continue;
      lines.push("", `--- ${target.path}`, target.content!.replace(/\n$/, ""));
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
