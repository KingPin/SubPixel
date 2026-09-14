import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateAssetsFile } from "../../src/assets/schema.js";
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

  it("documents every flag the commands register", async () => {
    const { buildProgram } = await import("../../src/cli/index.js");
    for (const command of (await buildProgram()).commands) {
      for (const option of command.options) {
        // `-n <count>` has no long form, so the short one is its only name.
        const flag = option.long ?? option.short!;
        expect(DOC, `${command.name()} ${flag}`).toContain(flag);
      }
    }
  });
});
