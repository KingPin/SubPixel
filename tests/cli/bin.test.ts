import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

const run = promisify(execFile);
const BIN = resolve("dist/cli/bin.js");

// These exercise the built artifact, so they are skipped when dist/ is absent.
const built = existsSync(BIN);

describe.runIf(built)("installed binary", () => {
  it("runs when invoked directly", async () => {
    const { stdout } = await run(process.execPath, [BIN, "--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("runs through a symlink, the way npm installs it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subpixel-bin-"));
    const link = join(dir, "spx");
    await symlink(BIN, link);
    await chmod(BIN, 0o755);
    const { stdout } = await run(process.execPath, [link, "--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("runs from a directory whose name contains a space", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subpixel bin "));
    const link = join(dir, "spx");
    await symlink(BIN, link);
    const { stdout } = await run(process.execPath, [link, "--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("produces output, not a silent zero exit", async () => {
    // `doctor` exits 1 when this machine has no ChatGPT login, which is the normal
    // state in CI. The point of this test is the stdout, not the status, so read it
    // from the rejection too rather than skipping the check wherever auth is absent.
    const { stdout } = await run(process.execPath, [BIN, "doctor", "--json"]).catch(
      (err: { stdout?: string }) => ({ stdout: err.stdout ?? "" }),
    );
    expect(stdout.startsWith("{")).toBe(true);
  });
});

describe("bin bootstrap", () => {
  it("installs the broken-pipe guard only on stdout", async () => {
    vi.resetModules();
    const ignoreEpipe = vi.fn();
    const main = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../src/cli/exit.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/cli/exit.js")>()),
      ignoreEpipe,
    }));
    vi.doMock("../../src/cli/index.js", () => ({ main }));
    try {
      await import("../../src/cli/bin.js");
      expect(ignoreEpipe).toHaveBeenCalledTimes(1);
      expect(ignoreEpipe).toHaveBeenCalledWith(process.stdout);
    } finally {
      vi.doUnmock("../../src/cli/exit.js");
      vi.doUnmock("../../src/cli/index.js");
      vi.resetModules();
      vi.restoreAllMocks();
    }
  });
});
