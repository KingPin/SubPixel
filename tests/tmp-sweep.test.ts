import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sweepTempDirs } from "./tmp-sweep.js";

describe("sweepTempDirs", () => {
  it("removes the suite's temp directories and leaves everything else", async () => {
    const root = await mkdtemp(join(tmpdir(), "subpixel-sweep-"));
    const keep = await mkdtemp(join(tmpdir(), "subpixel-sweep-target-"));

    await mkdir(join(root, "subpixel-generate-abc"));
    // Non-empty, because the real ones hold a 13 MB image and `rm` has to recurse.
    await writeFile(join(root, "subpixel-generate-abc", "huge.png"), "x");
    await mkdir(join(root, "subpixel-ref-def"));
    await mkdir(join(root, "someone-elses-dir"));
    await writeFile(join(root, "subpixel-not-a-dir"), "x");
    // A link the sweep must not follow: removing it is fine, removing what it
    // points at is not.
    await symlink(keep, join(root, "subpixel-link"));

    const removed = await sweepTempDirs(root);

    expect(removed).toBe(2);
    expect((await readdir(root)).sort()).toEqual([
      "someone-elses-dir",
      "subpixel-link",
      "subpixel-not-a-dir",
    ]);
    // The link survived, so the directory behind it must have too.
    await expect(readdir(keep)).resolves.toEqual([]);
  });

  it("reports nothing rather than throwing when the root does not exist", async () => {
    await expect(sweepTempDirs(join(tmpdir(), "subpixel-sweep-missing-xyz"))).resolves.toBe(0);
  });
});
