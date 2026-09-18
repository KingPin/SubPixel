import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateAssetsFile } from "../../src/assets/schema.js";
import { KNOWN_COMMANDS } from "../../src/cli/options.js";
import { validateConfig } from "../../src/config/schema.js";
import { ICON_PACK } from "../../src/engine/icons.js";
import { parseSize } from "../../src/engine/prompt.js";
import { parse } from "yaml";

const DOC = await readFile("docs/reference/cli.md", "utf8");

/** Pull the fenced blocks of one language out of the reference. */
function blocks(language: string): string[] {
  return [...DOC.matchAll(new RegExp("```" + language + "\\n([\\s\\S]*?)```", "g"))].map(
    (match) => match[1]!,
  );
}

describe("the CLI reference", () => {
  it("documents a config the validator accepts whole", () => {
    const warnings: string[] = [];
    const json = blocks("json");
    expect(json).toHaveLength(1);
    const config = validateConfig(JSON.parse(json[0]!), "docs", (m) => warnings.push(m));
    // An unknown key only WARNS, so a silent `validateConfig` call would have let
    // `defaultStyle` and `size` through unnoticed. The empty warning list is the
    // assertion that matters.
    expect(warnings).toEqual([]);
    expect(config.style).toBe("brand");
    expect(config.styles?.brand).toBeDefined();
  });

  it("documents an assets.yml the validator accepts whole", () => {
    const warnings: string[] = [];
    const yaml = blocks("yaml");
    expect(yaml).toHaveLength(1);
    const file = validateAssetsFile(parse(yaml[0]!), "docs", (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    expect(file.assets.map((asset) => asset.id)).toEqual(["hero", "og-card"]);
  });

  it("names the icons the pack actually writes", () => {
    for (const spec of ICON_PACK) expect(DOC, spec.name).toContain(spec.name);
    expect(DOC).toContain("favicon.ico");
  });

  it("shows only sizes the flag parser accepts", () => {
    // `--size landscape` is the trap: the names are an assets.yml convenience and
    // `parseSize` rejects them, so a documented example using one fails on paste.
    // Only the runnable blocks are scanned; the flag table says `--size <WxH>`,
    // which is a placeholder rather than a value.
    const commands = blocks("bash").join("\n");
    expect(commands).toContain("--size ");
    for (const match of commands.matchAll(/(?<![-\w])--size (\S+)/g)) {
      expect(() => parseSize(match[1]!), match[0]).not.toThrow();
    }
  });

  it("has a section for every command the CLI knows", () => {
    // `help` is commander's own, and has no section to write.
    for (const command of KNOWN_COMMANDS.filter((name) => name !== "help")) {
      expect(DOC, command).toMatch(new RegExp(`^## .*\\b${command}\\b`, "m"));
    }
  });

  it("documents every flag in the section of the command that registers it", async () => {
    // In its OWN section, not just somewhere in the file. A global search passes as
    // long as some other command happens to share the flag name, which is how the
    // reference came to claim `edit` had no `--emit` while `edit` registered one.
    // Split on the headings rather than matching each section: `$` under /m ends at
    // every line, which silently makes every section body the empty string, and an
    // empty string is a check that passes for want of anything to disagree with.
    const sections = new Map<string, string>();
    for (const part of DOC.split(/^## /m).slice(1)) {
      const heading = part.slice(0, part.indexOf("\n"));
      // "doctor and models" documents two commands in one section.
      for (const name of heading.split(/\W+/)) sections.set(name, part);
    }

    const { buildProgram } = await import("../../src/cli/index.js");
    for (const command of (await buildProgram()).commands) {
      // Its own section has to exist first. Falling back to `generate`'s text before
      // this check would let `edit` pass with no `## edit` section at all, because
      // every flag it registers is one `generate` registers too.
      const own = sections.get(command.name());
      expect(own, `no section for ${command.name()}`).toBeDefined();
      // `edit` documents itself as "every `generate` flag except ...", which is the
      // honest shape for a command that shares a resolver with another one.
      const text = command.name() === "edit" ? own! + sections.get("generate")! : own!;
      for (const option of command.options) {
        // `-n <count>` has no long form, so the short one is its only name.
        const flag = option.long ?? option.short!;
        expect(text, `${command.name()} ${flag}`).toContain(flag);
      }
    }
  });

  it("registers every flag the tables document", async () => {
    // The other direction, and the one that rots silently: a flag dropped from the
    // CLI stays in the reference, so the docs promise something that dies as an
    // unknown option. Only the first cell of a table row is scanned — that is where
    // a row names its own flag; prose and the right-hand cells reference flags that
    // belong to other commands.
    const { buildProgram } = await import("../../src/cli/index.js");
    const program = await buildProgram();
    const registered = new Set(
      [program, ...program.commands].flatMap((c) => c.options.map((o) => o.long).filter(Boolean)),
    );
    const documented = new Set<string>();
    for (const row of DOC.matchAll(/^\| `([^`]+)` \|/gm)) {
      for (const flag of row[1]!.matchAll(/--[a-z][a-z-]*/g)) documented.add(flag[0]);
    }
    expect(documented.size).toBeGreaterThan(10);
    expect([...documented].filter((flag) => !registered.has(flag))).toEqual([]);
  });
});
