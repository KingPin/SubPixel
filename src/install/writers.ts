import { join } from "node:path";
import { ConfigError } from "../core/errors.js";

/**
 * Everything a writer needs to render its target, and nothing it could read itself.
 *
 * Writers are pure. They take the existing file text and return the new file text;
 * `init.ts` does the reading, the diffing, and the writing. That is what makes
 * `--dry-run` the same code path minus the write, and the tests table-driven.
 */
export interface InitContext {
  /** The project directory. Project-scoped destinations are resolved against it. */
  cwd: string;
  /** The user's home directory. User-scoped destinations are resolved against it. */
  home: string;
  /** `XDG_CONFIG_HOME`, when the environment sets it. Only Kilo Code honours it. */
  xdgConfigHome?: string;
  /** The text of the bundled `skills/subpixel/SKILL.md`, read once by `init.ts`. */
  skill: string;
  /**
   * The file this writer is about to render, resolved by `init.ts`.
   *
   * Writers use it to name themselves in an error. They cannot derive it, because
   * `--global` sends the same writer to a different file than `path()` returns.
   */
  dest: string;
}

/**
 * Where the host runs the server from decides which project it edits.
 *
 * The launched process inherits the host's working directory, and that directory is
 * what selects the `subpixel.config.*`, the `assets.yml`, and the `.subpixel/jobs/`
 * the server uses. A project-scoped config therefore needs no `cwd` override: the
 * host is already in the project. A user-scoped config has no project to be in, so
 * the server runs wherever the host runs and a single entry serves every project the
 * user opens.
 */
export type Scope = "project" | "user";

export interface Writer {
  /** Stable id, named by `--only` and printed by the report. */
  id: string;
  /** One line for the report, naming the harness a human would recognise. */
  title: string;
  scope: Scope;
  /** Absolute destination path for this context. */
  path(ctx: InitContext): string;
  /**
   * A path whose existence means this harness is installed.
   *
   * `init` skips a target whose marker is missing, because a config written for a
   * harness the user does not have is a file they never asked for in a directory
   * they do not recognise. Writers with no marker are the baseline every project
   * gets: they live in the project itself and cost nothing to carry.
   *
   * The marker is a path rather than a predicate so that writers stay pure — the
   * filesystem is `init.ts`'s job.
   */
  marker?(ctx: InitContext): string;
  /**
   * Where `--global` writes this target, and the directory that proves the harness
   * is installed.
   *
   * Only for a project-scoped writer whose harness ALSO documents a user-scoped
   * config. Absent means the harness has no user-scoped form, and `--global` reports
   * the target as unsupported rather than quietly writing the project file — a
   * global run that silently edits the working directory is the one outcome the flag
   * must never produce.
   *
   * A user-scoped writer needs none of this: it is already global, and `--global`
   * leaves it exactly where it was.
   */
  globalTarget?(ctx: InitContext): { path: string; marker: string };
  /**
   * Keep this target out of a default run. `--only` is the only way to ask for it.
   *
   * For a target that buys its harness nothing it cannot already do. An MCP server
   * costs its tool schemas in the model's context on every single turn, so a harness
   * that can read the skill and run the CLI from its own shell is better off without
   * one — and a config written by default is a cost the user never chose to pay.
   */
  optIn?: boolean;
  /**
   * Merge our entry into `existing` and return the whole file.
   *
   * `existing` is `undefined` when the file is absent — and also when the caller
   * passed `--force`, which is how force is expressed: regenerate from nothing
   * rather than merge into content we could not parse.
   *
   * Throws `ConfigError` when the file exists but cannot be parsed. That is the
   * conflict `--force` exists to resolve; merging into a guess would write a config
   * the harness silently ignores.
   */
  write(existing: string | undefined, ctx: InitContext): string;
}

/**
 * The launch command, identical for every MCP target.
 *
 * `npx -y subpixel mcp` rather than a bare `subpixel`: the harness spawns the server
 * with its own PATH, which on a GUI-launched editor frequently lacks the user's node
 * version manager shims. `-y` stops npx pausing for an install prompt on a stdio
 * transport that has no terminal to prompt on.
 */
export const MCP_COMMAND = "npx";
export const MCP_ARGS = ["-y", "subpixel", "mcp"];

function parseJsonObject(existing: string | undefined, target: string): Record<string, unknown> {
  if (existing === undefined || existing.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (err) {
    throw new ConfigError(
      `${target} is not valid JSON (${(err as Error).message}). Fix it, or re-run with --force to replace it.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      `${target} does not contain a JSON object. Fix it, or re-run with --force to replace it.`,
    );
  }
  return parsed as Record<string, unknown>;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Merge a `subpixel` entry into the object a host keeps its servers in.
 *
 * Parse, merge, write — never truncate. Unrelated servers survive because the whole
 * document is spread back out, and keys a user added to OUR entry (`disabled`, an
 * `env` block, a `timeout`) survive because the existing entry is spread under the
 * new one. Re-running is byte-identical: the second pass merges the same fields over
 * themselves and the key order is already settled by the first.
 *
 * `key` is a parameter because Kilo Code is the one harness that does not call the
 * container `mcpServers`.
 */
function mergeServerEntry(
  existing: string | undefined,
  target: string,
  key: string,
  entry: Record<string, unknown>,
): string {
  const doc = parseJsonObject(existing, target);
  const servers = asObject(doc[key]);
  return `${JSON.stringify(
    { ...doc, [key]: { ...servers, subpixel: { ...asObject(servers.subpixel), ...entry } } },
    null,
    2,
  )}\n`;
}

const AGENTS_BEGIN = "<!-- subpixel:begin -->";
const AGENTS_END = "<!-- subpixel:end -->";

const AGENTS_BLOCK = `${AGENTS_BEGIN}
## Images with subpixel

This repository generates its images with \`subpixel\`. Do not draw an image by hand,
do not download a stock photo, and do not leave a placeholder.

- Generate: \`npx subpixel generate "a wide hero banner, flat vector, teal" --out public/hero.png\`
- Edit an existing image: \`npx subpixel edit public/hero.png "make the sky darker"\`
- Declared assets: \`npx subpixel sync\` generates everything in \`assets.yml\` that is
  missing or out of date. \`npx subpixel sync --check\` exits 6 if any asset drifted and
  makes no network calls.
- Before the first run: \`npx subpixel doctor\`. It exits 1 and names the problem when
  the ChatGPT credentials are missing or expired.

Generation takes about 30 seconds, and up to 6 minutes on the codex-exec backend.
Set the command timeout to the maximum your tooling allows and wait. Never re-run a
command that appears to have hung — the first request may already have been billed.
Every run writes a manifest beside the image (\`hero.png\` gets a \`hero.png.json\`);
read the image path back from stdout rather than guessing it.
${AGENTS_END}`;

export const WRITERS: Writer[] = [
  {
    // Destination: .claude/skills/subpixel/SKILL.md (project-scoped)
    // Syntax:      Markdown with YAML frontmatter
    // Launch:      n/a — a skill is instructions, not a server
    id: "claude-skill",
    title: "Claude Code skill",
    scope: "project",
    path: (ctx) => join(ctx.cwd, ".claude", "skills", "subpixel", "SKILL.md"),
    // A user skill is the same file under ~/.claude, and Claude Code reads it in
    // every project.
    globalTarget: (ctx) => ({
      path: join(ctx.home, ".claude", "skills", "subpixel", "SKILL.md"),
      marker: join(ctx.home, ".claude"),
    }),
    // The whole directory is ours, so the bundled text is written wholesale rather
    // than merged. Idempotent by construction, and an upgrade replaces a stale copy.
    write: (_existing, ctx) => ctx.skill,
  },
  {
    // Destination: .mcp.json (project-scoped, checked in and shared with the team)
    // Syntax:      { "mcpServers": { "<name>": { "command", "args" } } }
    // Launch:      npx -y subpixel mcp
    // No `type`: Claude Code documents an entry without one as stdio, and its own
    // examples omit it.
    // Opt-in: Claude Code gets the skill, which loads only when an image is actually
    // wanted and drives the same CLI through the shell it already has. Its Bash
    // timeout is long enough for a 6 minute codex-exec run, so the dual-path
    // streaming contract the server exists for buys it nothing either.
    id: "claude-mcp",
    title: "Claude Code MCP server",
    scope: "project",
    optIn: true,
    path: (ctx) => join(ctx.cwd, ".mcp.json"),
    // ~/.claude.json is where `claude mcp add --scope user` puts a server, under the
    // same `mcpServers` key. It also holds Claude Code's own session state, which the
    // merge preserves — every key we did not write is spread back out untouched.
    globalTarget: (ctx) => ({
      path: join(ctx.home, ".claude.json"),
      marker: join(ctx.home, ".claude"),
    }),
    write: (existing, ctx) =>
      mergeServerEntry(existing, ctx.dest, "mcpServers", {
        command: MCP_COMMAND,
        args: MCP_ARGS,
      }),
  },
  {
    // Destination: .cursor/mcp.json (project-scoped)
    // Syntax:      { "mcpServers": { "<name>": { "type": "stdio", "command", "args" } } }
    // Launch:      npx -y subpixel mcp
    // Cursor is the one harness whose field table marks `type` required for stdio.
    // Its examples omit it, so it is tolerated either way — write what the contract asks for.
    id: "cursor",
    marker: (ctx) => join(ctx.home, ".cursor"),
    title: "Cursor MCP server",
    scope: "project",
    path: (ctx) => join(ctx.cwd, ".cursor", "mcp.json"),
    globalTarget: (ctx) => ({
      path: join(ctx.home, ".cursor", "mcp.json"),
      marker: join(ctx.home, ".cursor"),
    }),
    write: (existing, ctx) =>
      mergeServerEntry(existing, ctx.dest, "mcpServers", {
        type: "stdio",
        command: MCP_COMMAND,
        args: MCP_ARGS,
      }),
  },
  {
    // Destination: ~/.codeium/windsurf/mcp_config.json (USER-scoped)
    // Syntax:      { "mcpServers": { "<name>": { "command", "args" } } }
    // Launch:      npx -y subpixel mcp
    // Windsurf documents no project-scoped MCP file and has no `type` field at all.
    id: "windsurf",
    marker: (ctx) => join(ctx.home, ".codeium", "windsurf"),
    title: "Windsurf MCP server",
    scope: "user",
    path: (ctx) => join(ctx.home, ".codeium", "windsurf", "mcp_config.json"),
    write: (existing, ctx) =>
      mergeServerEntry(existing, ctx.dest, "mcpServers", {
        command: MCP_COMMAND,
        args: MCP_ARGS,
      }),
  },
  {
    // Destination: ~/.cline/data/settings/cline_mcp_settings.json (USER-scoped)
    // Syntax:      { "mcpServers": { "<name>": { "command", "args" } } }
    // Launch:      npx -y subpixel mcp
    // NOT the VS Code globalStorage file. Cline v4 unified the IDE, CLI, and SDK
    // config under ~/.cline/, and the globalStorage copy is now only a migration
    // source. The path is homedir-based, so it is the same on every platform.
    id: "cline",
    marker: (ctx) => join(ctx.home, ".cline"),
    title: "Cline MCP server",
    scope: "user",
    path: (ctx) => join(ctx.home, ".cline", "data", "settings", "cline_mcp_settings.json"),
    write: (existing, ctx) =>
      mergeServerEntry(existing, ctx.dest, "mcpServers", {
        command: MCP_COMMAND,
        args: MCP_ARGS,
        disabled: false,
      }),
  },
  {
    // Destination: ${XDG_CONFIG_HOME:-~/.config}/kilo/kilo.jsonc (USER-scoped)
    // Syntax:      { "mcp": { "<name>": { "type": "local", "command": [argv...] } } }
    // Launch:      npx -y subpixel mcp, as a single argv array
    // Kilo Code v7 moved MCP into the main config file and renamed everything on the
    // way: the container is `mcp`, not `mcpServers`; the transport is "local", not
    // "stdio"; and `command` is the whole argv, with no separate `args`. A
    // command/args entry under `mcpServers` here is read by nothing.
    //
    // The file is JSONC by extension. A file carrying comments fails to parse and is
    // reported as a conflict rather than merged, which is the right answer: writing
    // it back as plain JSON would delete the comments.
    id: "kilo",
    marker: (ctx) => join(ctx.xdgConfigHome ?? join(ctx.home, ".config"), "kilo"),
    title: "Kilo Code MCP server",
    scope: "user",
    path: (ctx) => join(ctx.xdgConfigHome ?? join(ctx.home, ".config"), "kilo", "kilo.jsonc"),
    write: (existing, ctx) =>
      mergeServerEntry(existing, ctx.dest, "mcp", {
        type: "local",
        command: [MCP_COMMAND, ...MCP_ARGS],
        enabled: true,
      }),
  },
  {
    // Destination: AGENTS.md (project-scoped)
    // Syntax:      Markdown, fenced by HTML comment markers so a re-run replaces
    //              exactly our block and nothing a human wrote around it
    // Launch:      n/a — the CLI, for harnesses with no MCP support
    id: "agents-md",
    title: "AGENTS.md instructions",
    scope: "project",
    path: (ctx) => join(ctx.cwd, "AGENTS.md"),
    write: (existing) => {
      if (existing === undefined || existing.trim() === "") return `${AGENTS_BLOCK}\n`;
      const start = existing.indexOf(AGENTS_BEGIN);
      const end = existing.indexOf(AGENTS_END);
      if (start !== -1 && end > start) {
        return existing.slice(0, start) + AGENTS_BLOCK + existing.slice(end + AGENTS_END.length);
      }
      // No marker: append. Appending beats rewriting a file whose prose we did not
      // write and cannot safely reorder.
      return `${existing.replace(/\n+$/, "")}\n\n${AGENTS_BLOCK}\n`;
    },
  },
];
