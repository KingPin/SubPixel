import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../../src/mcp/tools.js";
import { DEFAULT_CUTOVER_MS } from "../../src/mcp/progress.js";
import { MCP_ARGS, MCP_COMMAND, WRITERS } from "../../src/install/writers.js";
import * as errors from "../../src/core/errors.js";

const DOC = await readFile("docs/reference/mcp.md", "utf8");

/** Every concrete error class, instantiated, so `code` and `exitCode` are readable. */
function errorClasses(): { code: string; exitCode: number }[] {
  return Object.values(errors)
    .filter(
      (value): value is new (message: string) => errors.SubpixelError =>
        typeof value === "function" &&
        value !== errors.SubpixelError &&
        value.prototype instanceof errors.SubpixelError,
    )
    .map((Ctor) => {
      const instance = new Ctor("x");
      return { code: instance.code, exitCode: instance.exitCode };
    });
}

describe("the MCP reference", () => {
  it("documents every tool the server declares", () => {
    for (const tool of TOOLS) expect(DOC, tool.name).toContain(`\`${tool.name}\``);
  });

  it("declares no tool it does not document", () => {
    // The table is the contract a host reader trusts. A row for a tool that no
    // longer exists sends them looking for it.
    const table = DOC.slice(DOC.indexOf("| Tool |"), DOC.indexOf("### generate_image"));
    for (const name of table.matchAll(/^\| `(\w+)` \|/gm)) {
      expect(TOOLS.map((tool) => tool.name)).toContain(name[1]);
    }
  });

  it("gives every error code its exit code", () => {
    for (const { code, exitCode } of errorClasses()) {
      expect(DOC, code).toContain(`| \`${code}\` | ${exitCode} |`);
    }
  });

  it("states the cut-over the server actually uses", () => {
    expect(DOC).toContain(`${DEFAULT_CUTOVER_MS / 1000} seconds by default`);
    expect(DOC).toContain("SUBPIXEL_MCP_CUTOVER_MS");
  });

  it("shows the launch command `spx init` writes", () => {
    expect(DOC).toContain(`${MCP_COMMAND} ${MCP_ARGS.join(" ")}`);
  });

  it("names the destination of every MCP config `spx init` writes", () => {
    const ctx = { cwd: "/project", home: "~", skill: "" };
    for (const writer of WRITERS) {
      if (writer.id === "claude-skill" || writer.id === "agents-md") continue;
      // The filename alone. The full path differs by platform and by
      // XDG_CONFIG_HOME, and the doc spells the rule rather than one machine's answer.
      const file = writer.path(ctx).split("/").pop()!;
      expect(DOC, writer.id).toContain(file);
    }
  });

  it("says poll and not retry, in those words", () => {
    // The single most expensive mistake a host can make, so it is asserted rather
    // than trusted to survive an edit.
    expect(DOC).toContain("Poll, do not retry");
    expect(DOC).toContain("Never re-issue the original call");
  });

  it("warns that a user-scoped config has no project", () => {
    expect(DOC).toContain("A user-scoped config has no project to be in");
  });
});
