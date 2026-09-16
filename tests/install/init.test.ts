import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyInit, formatInitPlan, initIsCurrent, planInit } from "../../src/install/init.js";

let cwd: string;
let home: string;

/** An empty env, so an ambient XDG_CONFIG_HOME cannot move Kilo's path mid-test. */
const env: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "subpixel-init-cwd-"));
  home = await mkdtemp(join(tmpdir(), "subpixel-init-home-"));
});

function plan() {
  return planInit({ cwd, home, env });
}

/** The Claude Code MCP entry is opt-in, so every test about it has to ask for it. */
function planClaudeMcp(extra: { force?: boolean; global?: boolean } = {}) {
  return planInit({ cwd, home, env, only: ["claude-mcp"], ...extra });
}

/** Make every optional harness look installed. */
async function installEverything(): Promise<void> {
  for (const dir of [[".cursor"], [".codeium", "windsurf"], [".cline"], [".config", "kilo"]]) {
    await mkdir(join(home, ...dir), { recursive: true });
  }
}

async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath, entry.name));
  }
  return out.sort();
}

describe("planInit", () => {
  it("skips a harness that is not installed", async () => {
    const targets = await plan();
    const state = Object.fromEntries(targets.map((t) => [t.id, t.state]));
    // The three that live in the project itself are the baseline: they cost nothing
    // to carry and there is no directory to detect.
    expect(state).toMatchObject({
      "claude-skill": "created",
      "agents-md": "created",
      cursor: "absent",
      windsurf: "absent",
      cline: "absent",
      kilo: "absent",
    });
  });

  it("writes every harness once its config directory exists", async () => {
    await installEverything();
    for (const target of await plan()) {
      expect(target.state).toBe("created");
    }
  });

  it("leaves the Claude Code MCP entry out until --only asks for it", async () => {
    // Claude Code reads the skill and runs the CLI from its own shell. The server's
    // tool schemas would sit in its context on every turn and buy it nothing.
    const targets = await plan();
    expect(targets.map((t) => t.id)).not.toContain("claude-mcp");
    expect((await planClaudeMcp()).map((t) => t.id)).toEqual(["claude-mcp"]);
  });

  it("plans only the targets --only names", async () => {
    const targets = await planInit({
      cwd,
      home,
      env,
      only: ["claude-mcp", "agents-md"],
    });
    expect(targets.map((t) => t.id)).toEqual(["claude-mcp", "agents-md"]);
  });

  it("rejects an id no writer answers to", async () => {
    // Silently planning nothing for a typo leaves the user believing the harness they
    // asked for is configured.
    await expect(planInit({ cwd, home, env, only: ["cursed"] })).rejects.toThrow(/cursed/);
  });

  it("rejects an empty selection rather than widening it to the default set", async () => {
    // `--only ''` and `--only ,` both arrive as []. Reading that as "no preference"
    // makes a malformed flag write every default target — the opposite of narrowing.
    await expect(planInit({ cwd, home, env, only: [] })).rejects.toThrow(/No init target/);
  });

  it("sends a project target to its user-scoped file under --global", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".cursor"), { recursive: true });
    const targets = await planInit({ cwd, home, env, global: true });
    const path = Object.fromEntries(targets.map((t) => [t.id, t.path]));
    expect(path["claude-skill"]).toBe(join(home, ".claude", "skills", "subpixel", "SKILL.md"));
    expect(path["cursor"]).toBe(join(home, ".cursor", "mcp.json"));
    const [claudeMcp] = await planClaudeMcp({ global: true });
    expect(claudeMcp!.path).toBe(join(home, ".claude.json"));
    // Already user scoped, so --global leaves it where it was.
    expect(path["kilo"]).toBe(join(home, ".config", "kilo", "kilo.jsonc"));
    expect(targets.every((t) => t.state !== "created" || t.scope === "user")).toBe(true);
  });

  it("detects the harness before writing a global config for it", async () => {
    // Without ~/.claude, a global run must not create one: the project-scoped skill
    // and .mcp.json are written unconditionally only because they cost a project
    // nothing, and a stray directory in $HOME is not the same bargain.
    const targets = [
      ...(await planInit({ cwd, home, env, global: true })),
      ...(await planClaudeMcp({ global: true })),
    ];
    const state = Object.fromEntries(targets.map((t) => [t.id, t.state]));
    expect(state).toMatchObject({
      "claude-skill": "absent",
      "claude-mcp": "absent",
    });
  });

  it("reports a project-only target as unsupported instead of writing it", async () => {
    const targets = await planInit({
      cwd,
      home,
      env,
      global: true,
      only: ["agents-md"],
    });
    expect(targets[0]!.state).toBe("unsupported");
    await applyInit(targets);
    expect(await tree(cwd)).toEqual([]);
  });

  it("writes nothing", async () => {
    await plan();
    expect(await tree(cwd)).toEqual([]);
  });
});

describe("applyInit", () => {
  it("is idempotent end to end", async () => {
    await installEverything();

    const first = await plan();
    expect(await applyInit(first)).toHaveLength(first.length);

    const files = await tree(cwd);
    expect(files).toContain(join(cwd, "AGENTS.md"));
    expect(files).toContain(join(cwd, ".claude", "skills", "subpixel", "SKILL.md"));

    const before = await Promise.all(files.map((file) => readFile(file, "utf8")));

    const second = await plan();
    expect(initIsCurrent(second)).toBe(true);
    expect(await applyInit(second)).toEqual([]);
    expect(await Promise.all(files.map((file) => readFile(file, "utf8")))).toEqual(before);
  });

  it("writes only what --only planned", async () => {
    await applyInit(await planInit({ cwd, home, env, only: ["claude-mcp"] }));
    expect(await tree(cwd)).toEqual([join(cwd, ".mcp.json")]);
  });

  it("keeps the rest of ~/.claude.json when it adds the server", async () => {
    // That file is Claude Code's own state, not a config we own. Merging it wrong
    // costs the user their session history.
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        numStartups: 7,
        mcpServers: { other: { command: "other-server" } },
      }),
    );

    await applyInit(await planInit({ cwd, home, env, global: true, only: ["claude-mcp"] }));

    const doc = JSON.parse(await readFile(join(home, ".claude.json"), "utf8")) as {
      numStartups: number;
      mcpServers: Record<string, unknown>;
    };
    expect(doc.numStartups).toBe(7);
    expect(Object.keys(doc.mcpServers).sort()).toEqual(["other", "subpixel"]);
  });

  it("names the file it actually failed to parse", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude.json"), "{ this is not json\n");
    const [target] = await planInit({
      cwd,
      home,
      env,
      global: true,
      only: ["claude-mcp"],
    });
    expect(target!.state).toBe("conflict");
    expect(target!.reason).toContain(join(home, ".claude.json"));
  });

  it("keeps an MCP server someone else configured", async () => {
    await writeFile(
      join(cwd, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { other: { command: "other-server" } } }, null, 2)}\n`,
    );
    await applyInit(await planClaudeMcp());

    const doc = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(doc.mcpServers).sort()).toEqual(["other", "subpixel"]);
  });

  it("reports a conflict and writes nothing, until --force", async () => {
    await writeFile(join(cwd, ".mcp.json"), "{ this is not json\n");

    const blocked = await planClaudeMcp();
    expect(blocked.find((t) => t.id === "claude-mcp")?.state).toBe("conflict");
    await applyInit(blocked);
    expect(await readFile(join(cwd, ".mcp.json"), "utf8")).toBe("{ this is not json\n");

    const forced = await planClaudeMcp({ force: true });
    expect(forced.find((t) => t.id === "claude-mcp")?.state).toBe("updated");
    await applyInit(forced);
    const doc = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(doc.mcpServers.subpixel).toBeDefined();
  });

  it("keeps unrelated servers under --force when the file parses fine", async () => {
    // --force clears a conflict. It is not "rewrite every target from scratch": a
    // parseable config still merges, or the flag silently deletes a colleague's
    // servers on the way to fixing one unparseable file elsewhere.
    await writeFile(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "echo" } } }, null, 2),
    );

    await applyInit(await planClaudeMcp({ force: true }));

    const doc = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(doc.mcpServers).sort()).toEqual(["other", "subpixel"]);
  });
});

describe("formatInitPlan", () => {
  it("renders every file a dry run would write, and says it wrote nothing", async () => {
    await installEverything();
    const rendered = formatInitPlan(await plan(), true);
    expect(rendered).toContain("Dry run. Nothing was written.");
    expect(rendered).toContain(join(cwd, ".cursor", "mcp.json"));
    // The launch command is the one line a reader is checking for.
    expect(rendered).toContain('"npx"');
    expect(rendered).toContain('"subpixel"');
  });

  it("prints the id --only expects beside each target", async () => {
    expect(formatInitPlan(await plan(), false)).toContain("(agents-md — AGENTS.md instructions)");
  });

  it("names the opt-in target it did not write, and how to ask for it", async () => {
    // It is absent from the listing entirely, so the report is the only place a user
    // can learn the target exists.
    expect(formatInitPlan(await plan(), false)).toContain("--only claude-mcp");
    expect(formatInitPlan(await planClaudeMcp(), false)).not.toContain("Not written by default");
  });

  it("warns that a user-scoped entry is not project-scoped", async () => {
    await installEverything();
    const rendered = formatInitPlan(await plan(), false);
    expect(rendered).toContain("apply to every project you open");
  });

  it("stays quiet about user scope when no user-scoped harness is installed", async () => {
    expect(formatInitPlan(await plan(), false)).not.toContain("apply to every project you open");
  });

  it("tells the user how to clear a conflict", async () => {
    await writeFile(join(cwd, ".mcp.json"), "{ this is not json\n");
    const rendered = formatInitPlan(await planClaudeMcp(), false);
    expect(rendered).toContain("CONFLICT");
    expect(rendered).toContain("--force");
  });
});
