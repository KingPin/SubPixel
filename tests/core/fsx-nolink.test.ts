import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OutputError } from "../../src/core/errors.js";

const fail = (code: string) => Object.assign(new Error(code), { code });

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    link: () => Promise.reject(fail("EOPNOTSUPP")),
  };
});

const { atomicPublish } = await import("../../src/core/fsx.js");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "subpixel-nolink-"));
});

describe("atomicPublish without hard links", () => {
  it("refuses to publish, and says how to get through", async () => {
    const target = join(dir, "a.png");
    const err = await atomicPublish(target, "payload").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutputError);
    expect((err as OutputError).message).toContain("hard links");
    expect((err as OutputError).message).toContain("--overwrite");
  });

  it("leaves NO file at the target", async () => {
    // The whole reason for refusing. A zero-byte reservation left by a crash makes
    // every later publish see EEXIST, so the real image is diverted to a -v2
    // sibling for good.
    const target = join(dir, "b.png");
    await atomicPublish(target, "payload").catch(() => {});
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still publishes with overwrite, because that path only needs rename", async () => {
    const target = join(dir, "c.png");
    expect(await atomicPublish(target, "payload", { overwrite: true })).toBe(true);
    expect(await readFile(target, "utf8")).toBe("payload");
  });

});
