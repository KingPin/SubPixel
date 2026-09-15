import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function skill(): Promise<{ frontmatter: Record<string, string>; body: string }> {
  const raw = await readFile(join(root, "skills", "subpixel", "SKILL.md"), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error("SKILL.md has no frontmatter block");
  return {
    frontmatter: parse(match[1]!) as Record<string, string>,
    body: match[2]!,
  };
}

describe("the bundled skill", () => {
  it("keeps the description inside the limit every harness enforces", async () => {
    const { frontmatter } = await skill();
    expect(frontmatter.name).toBe("subpixel");
    // 1024 is the ceiling. A description over it is silently truncated by the host,
    // and the triggers at the end are the ones that disappear first.
    expect(frontmatter.description.length).toBeLessThan(1024);
  });

  it("describes triggers rather than summarising the tool", async () => {
    const { frontmatter } = await skill();
    // A summary tells the model what subpixel is. A trigger list tells it when to
    // reach for it, which is the only thing the description is read for.
    expect(frontmatter.description).toMatch(/Use when/);
    for (const trigger of ["hero image", "favicon", "assets.yml", "generate an image"]) {
      expect(frontmatter.description).toContain(trigger);
    }
  });

  it("states the exclusions that stop an image being bought for nothing", async () => {
    const { frontmatter, body } = await skill();
    expect(frontmatter.description).toMatch(/Do not use for/);
    for (const exclusion of ["SVG", "1px", "charts"]) {
      expect(body.toLowerCase()).toContain(exclusion.toLowerCase());
    }
  });

  it("warns about the timeout and forbids a blind retry", async () => {
    const { body } = await skill();
    expect(body).toContain("6 minutes");
    expect(body).toMatch(/maximum/);
    expect(body).toMatch(/Never re-run/);
  });

  it("tells the agent to look at what it generated", async () => {
    expect((await skill()).body).toMatch(/read the generated file back into context/i);
  });

  it("ships the terms-of-service refusal", async () => {
    const { body } = await skill();
    const { TOS_NOTICE } = await import("../../src/cli/doctor.js");
    // The same sentence `spx doctor` prints, allowing for Markdown wrapping and a
    // code span around the endpoint. Two wordings of one policy is one wording
    // nobody updates.
    const prose = body.replaceAll("`", "").replace(/\s+/g, " ");
    expect(prose).toContain(TOS_NOTICE);
  });
});
