import { access, readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { validateAssetsFile } from "../../src/assets/schema.js";
import { KNOWN_COMMANDS } from "../../src/cli/options.js";
import { TOS_NOTICE } from "../../src/cli/doctor.js";
import { MCP_ARGS, MCP_COMMAND } from "../../src/install/writers.js";
import { TOOLS } from "../../src/mcp/tools.js";
import { DriftDetected } from "../../src/core/errors.js";

const DOC = await readFile("README.md", "utf8");
const ENGINES = JSON.parse(await readFile("package.json", "utf8")).engines.node as string;

function blocks(language: string): string[] {
  return [...DOC.matchAll(new RegExp("```" + language + "\\n([\\s\\S]*?)```", "g"))].map(
    (match) => match[1]!,
  );
}

/** The README spells the tool count out, as prose does. */
const COUNT_WORD = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];

/** The README hard-wraps its prose, so a sentence is matched without its line breaks. */
const PROSE = DOC.replace(/`/g, "").replace(/\s+/g, " ");

describe("the README", () => {
  it("shows an assets.yml the validator accepts whole", () => {
    const warnings: string[] = [];
    const yaml = blocks("yaml").find((block) => block.startsWith("assets:"));
    const file = validateAssetsFile(parse(yaml!), "README", (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    expect(file.assets.map((asset) => asset.id)).toEqual(["hero"]);
  });

  it("shows the MCP launch command `spx init` writes", () => {
    const json = blocks("json");
    expect(json).toHaveLength(1);
    const entry = JSON.parse(json[0]!).mcpServers.subpixel;
    expect(entry.command).toBe(MCP_COMMAND);
    expect(entry.args).toEqual(MCP_ARGS);
  });

  it("names every tool the MCP server declares", () => {
    // The README promises "seven tools" and then lists them. Either half going stale
    // sends a reader looking for a tool that is not there.
    for (const tool of TOOLS) expect(DOC, tool.name).toContain(`\`${tool.name}\``);
    expect(PROSE).toContain(`stdio server exposing ${COUNT_WORD[TOOLS.length]} tools`);
  });

  it("lists every command the CLI knows", () => {
    for (const command of KNOWN_COMMANDS.filter((name) => name !== "help")) {
      expect(DOC, command).toContain(`| \`spx ${command}`);
    }
  });

  it("states the Node version package.json requires", () => {
    expect(PROSE).toContain(`Node ${ENGINES.replace(/[^\d]*(\d+).*/, "$1")} or newer`);
  });

  it("carries the terms-of-service notice verbatim", () => {
    expect(PROSE).toContain(TOS_NOTICE.replace(/\s+/g, " "));
  });

  it("names the exit code `sync --check` actually returns", () => {
    expect(PROSE).toContain(`exit ${new DriftDetected("x").exitCode} if`);
  });

  it("links only to files that exist", async () => {
    const links = [...DOC.matchAll(/\]\((?!https?:)([^)#]+)\)/g)].map((match) => match[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) await expect(access(link), link).resolves.toBeUndefined();
  });
});
