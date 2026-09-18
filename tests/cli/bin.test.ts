import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

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

describe("the bootstrap", () => {
  it("guards both output streams against a closed pipe", async () => {
    // Read as text, because bin.ts calls `main()` the moment it is imported. What is
    // being pinned is that BOTH streams are guarded: `spx generate ... 2>&1 | head -1`
    // is one pipe wearing two descriptors, so when `head` leaves, the progress lines
    // on stderr raise EPIPE exactly as the path on stdout does, and an unguarded
    // stderr turns a run that finished into a stack trace and exit 1. The stderr line
    // has been dropped once in review already, which is why it is worth a test.
    const source = await readFile(resolve("src/cli/bin.ts"), "utf8");
    for (const stream of ["stdout", "stderr"]) {
      expect(source, stream).toContain(`ignoreEpipe(process.${stream})`);
    }
  });
});
