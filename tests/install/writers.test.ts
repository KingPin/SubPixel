import { describe, expect, it } from "vitest";
import { manifestPathFor } from "../../src/engine/manifest.js";
import { MCP_ARGS, MCP_COMMAND, WRITERS, type InitContext } from "../../src/install/writers.js";
import { ConfigError } from "../../src/core/errors.js";

const ctx: InitContext = {
  cwd: "/project",
  home: "/home/someone",
  skill: "---\nname: subpixel\n---\n\nbody\n",
  // Only reached in an error message. `planTarget` replaces it with the real path.
  dest: "/project/some-config.json",
};

/**
 * One row per writer, carrying only what the writer does NOT already tell the test.
 *
 * `existing` is a realistic prior file with a key we did not write, and `survives` is
 * a fragment of it that must still be in the output. That pair is the whole point of
 * the suite: a writer that truncates someone else's MCP server passes every other
 * assertion here.
 */
const ROWS: { id: string; path: string; existing: string; survives: string }[] = [
  {
    id: "claude-skill",
    path: "/project/.claude/skills/subpixel/SKILL.md",
    // The skill directory is ours alone, so a stale copy is replaced, not merged.
    existing: "---\nname: subpixel\n---\n\nan older copy\n",
    survives: "body",
  },
  {
    id: "claude-mcp",
    path: "/project/.mcp.json",
    existing: `{"mcpServers":{"other":{"command":"other-server"}}}`,
    survives: `"other-server"`,
  },
  {
    id: "cursor",
    path: "/project/.cursor/mcp.json",
    existing: `{"mcpServers":{"other":{"command":"other-server"}}}`,
    survives: `"other-server"`,
  },
  {
    id: "windsurf",
    path: "/home/someone/.codeium/windsurf/mcp_config.json",
    existing: `{"mcpServers":{"other":{"command":"other-server"}}}`,
    survives: `"other-server"`,
  },
  {
    id: "cline",
    path: "/home/someone/.cline/data/settings/cline_mcp_settings.json",
    existing: `{"mcpServers":{"other":{"command":"other-server"}}}`,
    survives: `"other-server"`,
  },
  {
    id: "kilo",
    path: "/home/someone/.config/kilo/kilo.jsonc",
    existing: `{"model":"some/model","mcp":{"other":{"type":"local","command":["other-server"]}}}`,
    survives: `"some/model"`,
  },
  {
    id: "agents-md",
    path: "/project/AGENTS.md",
    existing: "# Contributing\n\nRun the tests before you push.\n",
    survives: "Run the tests before you push.",
  },
];

function writerFor(id: string) {
  const writer = WRITERS.find((candidate) => candidate.id === id);
  if (!writer) throw new Error(`no writer with id ${id}`);
  return writer;
}

describe("the install writers", () => {
  it("covers every writer in the table", () => {
    expect(ROWS.map((row) => row.id).sort()).toEqual(WRITERS.map((writer) => writer.id).sort());
  });

  for (const row of ROWS) {
    describe(row.id, () => {
      const writer = writerFor(row.id);

      it("writes to the destination the harness reads", () => {
        expect(writer.path(ctx)).toBe(row.path);
      });

      it("produces a complete file from nothing", () => {
        const fresh = writer.write(undefined, ctx);
        expect(fresh.length).toBeGreaterThan(0);
        expect(fresh.endsWith("\n")).toBe(true);
        expect(fresh).toContain("subpixel");
      });

      it("keeps a key it did not write", () => {
        expect(writer.write(row.existing, ctx)).toContain(row.survives);
      });

      it("is byte-identical on the second run", () => {
        const once = writer.write(row.existing, ctx);
        expect(writer.write(once, ctx)).toBe(once);
      });

      it("is byte-identical on the second run from nothing", () => {
        const once = writer.write(undefined, ctx);
        expect(writer.write(once, ctx)).toBe(once);
      });

      // The JSON-merging writers only. The rest own their whole file and replace it.
      if (row.existing.startsWith("{")) {
        it("hands over the entry when the file cannot be merged into", () => {
          // JSONC. Several of these hosts document `//` comments in their own
          // config, and this merge writes back through JSON.stringify — which
          // would delete every one of them. The user has to do it by hand, so the
          // error has to say what to type.
          let thrown: unknown;
          try {
            writer.write('{\n  // my notes\n  "theme": "dark"\n}\n', ctx);
          } catch (err) {
            thrown = err;
          }
          const message = (thrown as Error).message;
          expect(message).toContain("subpixel");
          expect(message).toContain("npx");
          expect(message).toContain("by hand");
          // --force REPLACES the file. It may still be what someone wants, but it
          // must not be the headline advice for a file with a comment in it.
          expect(message.indexOf("by hand")).toBeLessThan(message.indexOf("--force"));
        });
      }
    });
  }
});

describe("the MCP entries", () => {
  /** The launch command is the one field that is identical everywhere. */
  const jsonWriters = ["claude-mcp", "cursor", "windsurf", "cline", "kilo"];

  for (const id of jsonWriters) {
    it(`${id} launches the server with ${MCP_COMMAND} ${MCP_ARGS.join(" ")}`, () => {
      const doc = JSON.parse(writerFor(id).write(undefined, ctx)) as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      // Kilo is the odd one out on both counts, which is why this reads the shape
      // back rather than asserting one canonical structure.
      const entry = id === "kilo" ? doc.mcp!.subpixel! : doc.mcpServers!.subpixel!;
      const argv = Array.isArray(entry.command)
        ? (entry.command as string[])
        : [entry.command as string, ...(entry.args as string[])];
      expect(argv).toEqual([MCP_COMMAND, ...MCP_ARGS]);
    });

    it(`${id} reports a conflict rather than clobbering a file it cannot parse`, () => {
      expect(() => writerFor(id).write("{ not json", ctx)).toThrow(ConfigError);
      expect(() => writerFor(id).write("[]", ctx)).toThrow(ConfigError);
    });
  }

  it("gives Cursor the type its field table marks required", () => {
    const doc = JSON.parse(writerFor("cursor").write(undefined, ctx)) as {
      mcpServers: { subpixel: { type?: string } };
    };
    expect(doc.mcpServers.subpixel.type).toBe("stdio");
  });

  it("puts Kilo under `mcp`, not `mcpServers`", () => {
    // Kilo Code v7 renamed the container. An entry under `mcpServers` is read by
    // nothing, and nothing reports that it was ignored.
    const doc = JSON.parse(writerFor("kilo").write(undefined, ctx)) as Record<string, unknown>;
    expect(doc.mcp).toBeDefined();
    expect(doc.mcpServers).toBeUndefined();
  });

  it("honours XDG_CONFIG_HOME for Kilo", () => {
    expect(writerFor("kilo").path({ ...ctx, xdgConfigHome: "/xdg" })).toBe("/xdg/kilo/kilo.jsonc");
  });
});

describe("the AGENTS.md block", () => {
  const writer = writerFor("agents-md");

  it("appends below prose it did not write", () => {
    const out = writer.write("# Contributing\n\nRun the tests.\n", ctx);
    expect(out.indexOf("Run the tests.")).toBeLessThan(out.indexOf("Images with subpixel"));
  });

  it("replaces its own block in place rather than appending a second one", () => {
    const first = writer.write("# Contributing\n\nRun the tests.\n", ctx);
    const stale = first.replace("## Images with subpixel", "## Images with subpixel (old)");
    const second = writer.write(stale, ctx);
    expect(second).toBe(first);
    expect(second.match(/subpixel:begin/g)).toHaveLength(1);
  });

  it("tells a harness with no MCP support how to spend quota safely", () => {
    const out = writer.write(undefined, ctx);
    expect(out).toContain("Never re-run a\ncommand that appears to have hung");
    expect(out).toContain("subpixel sync --check");
  });

  it("names the manifest the engine actually writes", () => {
    // This said `.subpixel.json` once, which is not a file that has ever existed.
    // An agent told to look for it concludes the generation failed.
    expect(writer.write(undefined, ctx)).toContain(manifestPathFor("hero.png"));
  });
});
