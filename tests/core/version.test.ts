import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { packageVersion } from "../../src/core/version.js";
import { packageVersion as exported } from "../../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function pkg(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<string, unknown>;
}

describe("the package version", () => {
  it("is whatever package.json says", async () => {
    // The point of the whole exercise: one source. A release bumps package.json and
    // nothing else, and a second copy left behind somewhere is a copy that is wrong
    // at the one moment anyone reads it.
    expect(await packageVersion()).toBe((await pkg()).version);
  });

  it("is the same function the package exports", async () => {
    expect(exported).toBe(packageVersion);
  });

  it("returns the same answer when asked twice", async () => {
    expect(await packageVersion()).toBe(await packageVersion());
  });
});

describe("the published tarball", () => {
  it("ships the skill `spx init` installs", async () => {
    // `spx init` reads skills/subpixel/SKILL.md out of the installed package. Leave
    // it out of `files` and init fails only for users who installed from npm, which
    // is every user and no test.
    expect((await pkg()).files).toContain("skills");
    await expect(readFile(join(root, "skills", "subpixel", "SKILL.md"), "utf8")).resolves.toContain(
      "name: subpixel",
    );
  });

  it("declares the sharp version the suite actually tests against", async () => {
    const manifest = (await pkg()) as {
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.peerDependencies.sharp).toBe(manifest.devDependencies.sharp);
  });
});
