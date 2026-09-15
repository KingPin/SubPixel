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
      "claude-mcp": "created",
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
    expect(files).toContain(join(cwd, ".mcp.json"));
    expect(files).toContain(join(cwd, "AGENTS.md"));
    expect(files).toContain(join(cwd, ".claude", "skills", "subpixel", "SKILL.md"));

    const before = await Promise.all(files.map((file) => readFile(file, "utf8")));

    const second = await plan();
    expect(initIsCurrent(second)).toBe(true);
    expect(await applyInit(second)).toEqual([]);
    expect(await Promise.all(files.map((file) => readFile(file, "utf8")))).toEqual(before);
  });

  it("keeps an MCP server someone else configured", async () => {
    await writeFile(
      join(cwd, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { other: { command: "other-server" } } }, null, 2)}\n`,
    );
    await applyInit(await plan());

    const doc = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(doc.mcpServers).sort()).toEqual(["other", "subpixel"]);
  });

  it("reports a conflict and writes nothing, until --force", async () => {
    await writeFile(join(cwd, ".mcp.json"), "{ this is not json\n");

    const blocked = await plan();
    expect(blocked.find((t) => t.id === "claude-mcp")?.state).toBe("conflict");
    await applyInit(blocked);
    expect(await readFile(join(cwd, ".mcp.json"), "utf8")).toBe("{ this is not json\n");

    const forced = await planInit({ cwd, home, env, force: true });
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

    await applyInit(await planInit({ cwd, home, env, force: true }));

    const doc = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(doc.mcpServers).sort()).toEqual(["other", "subpixel"]);
  });
});

describe("formatInitPlan", () => {
  it("renders every file a dry run would write, and says it wrote nothing", async () => {
    const rendered = formatInitPlan(await plan(), true);
    expect(rendered).toContain("Dry run. Nothing was written.");
    expect(rendered).toContain(join(cwd, ".mcp.json"));
    // The launch command is the one line a reader is checking for.
    expect(rendered).toContain('"npx"');
    expect(rendered).toContain('"subpixel"');
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
    const rendered = formatInitPlan(await plan(), false);
    expect(rendered).toContain("CONFLICT");
    expect(rendered).toContain("--force");
  });
});
