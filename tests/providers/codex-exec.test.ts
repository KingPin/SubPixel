import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BackendUnavailable,
  ContentBlocked,
  StreamAborted,
  SubmissionUncertain,
} from "../../src/core/errors.js";
import { createDeadline, type Deadline } from "../../src/core/deadline.js";
import { silentLogger } from "../../src/core/logger.js";
import {
  buildCodexArgs,
  extractImageFromLine,
  extractPathsFromLine,
  generateViaCodexExec,
} from "../../src/providers/codex-exec.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_B64 = PNG.toString("base64");

/**
 * A fake `codex exec`. `onSpawn` receives the parsed argv so a test can plant
 * files in the workdir, or write the `-o` last-message file, exactly as the real
 * binary would before it exits.
 */
function fakeSpawn(
  lines: string[],
  code: number | null,
  signal: NodeJS.Signals | null = null,
  onSpawn?: (args: string[]) => Promise<void>,
) {
  return (_cmd: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: (sig?: NodeJS.Signals) => boolean;
    };
    child.stdout = Readable.from(lines.map((l) => `${l}\n`));
    child.stderr = Readable.from([]);
    child.kill = vi.fn(() => true);
    // Attach the `end` listener SYNCHRONOUSLY. The provider starts draining stdout
    // as soon as this returns, so a listener attached after `onSpawn` awaits misses
    // an `end` that already fired, no `close` is ever emitted, and the test hangs
    // until the runner's timeout. Awaiting inside the handler keeps the real
    // binary's ordering: the files exist before the process reports that it exited.
    const spawned = onSpawn ? onSpawn(args) : Promise.resolve();
    child.stdout.on("end", () => {
      void spawned.then(() => child.emit("close", code, signal));
    });
    return child;
  };
}

/** Reads the value that follows a flag in the argv the provider built. */
function flagValue(args: string[], flag: string): string {
  const at = args.indexOf(flag);
  expect(at).toBeGreaterThanOrEqual(0);
  return args[at + 1]!;
}

describe("buildCodexArgs", () => {
  const paths = { workdir: "/tmp/w", schemaPath: "/tmp/s.json", lastMessagePath: "/tmp/o.json" };

  it("always passes the safety and isolation flags", () => {
    const args = buildCodexArgs("draw a fox", { ...paths, model: "gpt-5.6-sol" });
    expect(args).toContain("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--ephemeral");
    expect(flagValue(args, "-C")).toBe("/tmp/w");
    expect(args).toContain("-m");
    expect(args).toContain("gpt-5.6-sol");
  });

  it("passes each reference image after the fixed flags and before the prompt", () => {
    const args = buildCodexArgs("draw", {
      ...paths,
      images: ["/tmp/w/inputs/reference-0.png", "/tmp/w/inputs/reference-1.jpeg"],
    });
    expect(args).toContain("-i");
    expect(args.indexOf("/tmp/w/inputs/reference-0.png")).toBeLessThan(args.indexOf("draw"));
    expect(args[args.length - 1]).toBe("draw");
  });

  it("adds nothing when there are no references", () => {
    expect(buildCodexArgs("draw", paths)).not.toContain("-i");
  });

  it("passes the spec's isolation and cost flags", () => {
    const args = buildCodexArgs("draw a fox", paths);
    // The user's config.toml can set high reasoning effort, a custom model, MCP
    // servers and hooks. None of that belongs in a headless image run.
    expect(args).toContain("--ignore-user-config");
    expect(flagValue(args, "-c")).toBe("model_reasoning_effort=low");
  });

  it("requests workspace-write, not read-only", () => {
    // The model has to save the image somewhere. read-only makes the whole
    // path-based retrieval route impossible.
    expect(flagValue(buildCodexArgs("x", paths), "-s")).toBe("workspace-write");
  });

  it("wires the structured output contract", () => {
    const args = buildCodexArgs("x", paths);
    expect(flagValue(args, "--output-schema")).toBe("/tmp/s.json");
    expect(flagValue(args, "-o")).toBe("/tmp/o.json");
  });

  it("passes the prompt as the final argv element", () => {
    const args = buildCodexArgs('draw a "fox"; rm -rf /', paths);
    expect(args[args.length - 1]).toBe('draw a "fox"; rm -rf /');
  });

  // `codex exec` has subcommands of its own and a variadic --image. Without the
  // separator a prompt is offered to the child's parser as one more option-
  // position token, and the child is free to read it as something other than a
  // prompt. All three cases below were reproducible against codex-cli 0.155.0.
  it("closes option parsing with -- so the prompt cannot be read as anything else", () => {
    const args = buildCodexArgs("draw a fox", paths);
    expect(args[args.length - 2]).toBe("--");
  });

  it.each(["review", "resume", "fork", "help"])(
    "keeps the prompt %j a prompt and not a codex exec subcommand",
    (prompt) => {
      const args = buildCodexArgs(prompt, paths);
      expect(args.slice(-2)).toEqual(["--", prompt]);
    },
  );

  it("keeps a prompt that opens with a flag away from the child's parser", () => {
    // The flags at the top of buildCodexArgs are the sandbox. A prompt read as
    // a flag would be able to replace them.
    const args = buildCodexArgs("--sandbox=danger-full-access please", paths);
    expect(args.slice(-2)).toEqual(["--", "--sandbox=danger-full-access please"]);
  });

  it("separates the prompt from the variadic --image list", () => {
    // -i is `--image <FILE>...`: a trailing positional sitting right after it
    // is a candidate for the same list.
    const args = buildCodexArgs("draw", { ...paths, images: ["/tmp/w/inputs/reference-0.png"] });
    expect(args.slice(-2)).toEqual(["--", "draw"]);
  });

  it("omits the model flag when no model is given", () => {
    expect(buildCodexArgs("x", paths)).not.toContain("-m");
  });
});

describe("extractImageFromLine", () => {
  it("finds a top-level base64 field", () => {
    const found = extractImageFromLine(JSON.stringify({ type: "image", b64_json: PNG_B64 }));
    expect(found?.subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  it("finds a nested result field", () => {
    const line = JSON.stringify({ msg: { item: { type: "image_generation_call", result: PNG_B64 } } });
    expect(extractImageFromLine(line)).toBeInstanceOf(Buffer);
  });

  it("strips a data URL prefix", () => {
    const line = JSON.stringify({ image: `data:image/png;base64,${PNG_B64}` });
    expect(extractImageFromLine(line)).toBeInstanceOf(Buffer);
  });

  it("returns undefined for an unparsable line", () => {
    expect(extractImageFromLine("not json at all")).toBeUndefined();
  });

  it("returns undefined for a line with no image", () => {
    expect(extractImageFromLine(JSON.stringify({ msg: { type: "agent_message" } }))).toBeUndefined();
  });

  it("ignores a base64 string that does not decode to a known image", () => {
    expect(extractImageFromLine(JSON.stringify({ b64_json: Buffer.from("hello").toString("base64") }))).toBeUndefined();
  });
});

describe("extractPathsFromLine", () => {
  it("finds a saved path in a tool-call event", () => {
    const line = JSON.stringify({
      msg: { item: { type: "image_generation_call", path: "out/fox.png" } },
    });
    expect(extractPathsFromLine(line)).toEqual(["out/fox.png"]);
  });

  it("collects every path-shaped field in order", () => {
    const line = JSON.stringify({ images: [{ path: "a.png" }, { file_path: "b/c.webp" }] });
    expect(extractPathsFromLine(line)).toEqual(["a.png", "b/c.webp"]);
  });

  it("ignores a path field that is not an image name", () => {
    // Codex emits plenty of paths that are not the artifact: logs, configs, the
    // rollout file. Taking them would read the wrong bytes and call it an image.
    const line = JSON.stringify({ path: "/var/log/codex.log" });
    expect(extractPathsFromLine(line)).toEqual([]);
  });

  it("returns an empty array for an unparsable line", () => {
    expect(extractPathsFromLine("<<<")).toEqual([]);
  });
});

describe("generateViaCodexExec", () => {
  let outside: string;

  beforeEach(async () => {
    outside = await mkdtemp(join(tmpdir(), "subpixel-outside-"));
  });
  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
  });

  it("reads the image named by the -o structured final message", async () => {
    // The normal successful path. No inline bytes appear anywhere.
    const spawnFn = fakeSpawn(
      [JSON.stringify({ msg: { type: "agent_message" } })],
      0,
      null,
      async (args) => {
        const workdir = flagValue(args, "-C");
        await writeFile(join(workdir, "fox.png"), PNG);
        await writeFile(
          flagValue(args, "-o"),
          JSON.stringify({ images: [{ path: "fox.png", revised_prompt: "a red fox" }] }),
        );
      },
    );
    const result = await generateViaCodexExec(
      { prompt: "a fox" },
      { model: "gpt-5.6-sol", spawnFn: spawnFn as never },
    );
    expect(result.images[0]?.equals(PNG)).toBe(true);
    expect(result.model).toBe("gpt-5.6-sol");
  });

  it("reads an image saved in a nested subdirectory", async () => {
    const spawnFn = fakeSpawn([], 0, null, async (args) => {
      const workdir = flagValue(args, "-C");
      await mkdir(join(workdir, "a", "b"), { recursive: true });
      await writeFile(join(workdir, "a", "b", "fox.png"), PNG);
      await writeFile(flagValue(args, "-o"), JSON.stringify({ images: [{ path: "a/b/fox.png" }] }));
    });
    const result = await generateViaCodexExec(
      { prompt: "a fox" },
      { model: "m", spawnFn: spawnFn as never },
    );
    expect(result.images[0]?.equals(PNG)).toBe(true);
  });

  it("refuses a path outside the workdir even when it is a real image", async () => {
    const secret = join(outside, "secret.png");
    const spawnFn = fakeSpawn([], 0, null, async (args) => {
      await writeFile(secret, PNG);
      await writeFile(flagValue(args, "-o"), JSON.stringify({ images: [{ path: secret }] }));
    });
    await expect(
      generateViaCodexExec({ prompt: "a fox" }, { model: "m", spawnFn: spawnFn as never }),
    ).rejects.toBeInstanceOf(ContentBlocked);
  });

  it("refuses a symlink inside the workdir that escapes it", async () => {
    const target = join(outside, "escape.png");
    const spawnFn = fakeSpawn([], 0, null, async (args) => {
      const workdir = flagValue(args, "-C");
      await writeFile(target, PNG);
      await symlink(target, join(workdir, "fox.png"));
      await writeFile(flagValue(args, "-o"), JSON.stringify({ images: [{ path: "fox.png" }] }));
    });
    await expect(
      generateViaCodexExec({ prompt: "a fox" }, { model: "m", spawnFn: spawnFn as never }),
    ).rejects.toBeInstanceOf(ContentBlocked);
  });

  it("falls back to a path found in the JSONL events when no -o file exists", async () => {
    let workdir = "";
    const spawnFn = (cmd: string, args: string[]) => {
      workdir = flagValue(args, "-C");
      return fakeSpawn(
        [JSON.stringify({ msg: { item: { type: "image_generation_call", path: "fox.png" } } })],
        0,
        null,
        async () => {
          await writeFile(join(workdir, "fox.png"), PNG);
        },
      )(cmd, args);
    };
    const result = await generateViaCodexExec(
      { prompt: "a fox" },
      { model: "m", spawnFn: spawnFn as never },
    );
    expect(result.images[0]?.equals(PNG)).toBe(true);
  });

  it("falls back to inline base64 when no path resolves", async () => {
    const result = await generateViaCodexExec(
      { prompt: "a fox" },
      {
        model: "gpt-5.6-sol",
        spawnFn: fakeSpawn(
          ["not json", JSON.stringify({ msg: { item: { result: PNG_B64 } } })],
          0,
        ) as never,
      },
    );
    expect(result.images).toHaveLength(1);
  });

  it("scans the workdir only as a last resort, newest first", async () => {
    const spawnFn = fakeSpawn([], 0, null, async (args) => {
      const workdir = flagValue(args, "-C");
      await mkdir(join(workdir, "nested"), { recursive: true });
      await writeFile(join(workdir, "nested", "old.png"), PNG);
      await new Promise((r) => setTimeout(r, 10));
      await writeFile(join(workdir, "nested", "new.png"), Buffer.concat([PNG, Buffer.from("x")]));
      // No -o file and no event paths: nothing structured to go on.
    });
    const result = await generateViaCodexExec(
      { prompt: "a fox" },
      { model: "m", spawnFn: spawnFn as never },
    );
    expect(result.images[0]?.length).toBe(PNG.length + 1);
  });

  it("maps a non-zero exit to SubmissionUncertain, never to a retryable error", async () => {
    const error = await generateViaCodexExec(
      { prompt: "a fox" },
      { model: "m", spawnFn: fakeSpawn(["{}"], 1) as never },
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SubmissionUncertain);
    // The property that actually matters: the child spawned, so nobody upstream
    // is allowed to spend a second unit of quota on our behalf.
    expect((error as SubmissionUncertain).submission).toBe("uncertain");
    expect((error as SubmissionUncertain).canFallback).toBe(false);
  });

  it("reports a failed spawn as BackendUnavailable, through the real spawn API", async () => {
    // Not a mocked exit code. A real `spawn` of a path that does not exist emits
    // `error`, and without a listener that is an unhandled event that kills the
    // process rather than the promised pre-submit exception.
    const missing = join(tmpdir(), `subpixel-no-such-binary-${Date.now()}`);
    const err = await generateViaCodexExec(
      { prompt: "a fox" },
      {
        model: "m",
        spawnFn: ((_cmd: string, args: string[], opts: object) =>
          spawn(missing, args, opts)) as never,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendUnavailable);
    // Nothing was forked, so this is the one exec failure a retry is free.
    expect((err as BackendUnavailable).submission).toBe("not-submitted");
  });

  it("does not spawn when the deadline expires during setup", async () => {
    // `expired` is false at entry and true by the time the child would be created,
    // which is exactly what three awaits of scratch-directory setup produce. A
    // single entry check passes this and spawns anyway.
    let reads = 0;
    const deadline = {
      get expired() {
        return reads++ > 0;
      },
      totalMs: 10,
      remainingMs: 0,
      signal: new AbortController().signal,
      start() {},
      dispose() {},
    } as unknown as Deadline;
    const spawnFn = vi.fn();
    const err = await generateViaCodexExec(
      { prompt: "a fox" },
      { model: "m", deadline, spawnFn: spawnFn as never },
    ).catch((e: unknown) => e);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(BackendUnavailable);
  });

  it("kills the child when the deadline aborts after the spawn", async () => {
    // A real, long-lived child. The kill timer is 10 s away, so only the abort
    // subscription can end this run.
    const controller = new AbortController();
    const deadline = createDeadline(10_000, { label: "t", parent: controller.signal });
    deadline.start();
    const err = generateViaCodexExec(
      { prompt: "a fox" },
      {
        model: "m",
        deadline,
        spawnFn: (() =>
          spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: ["ignore", "pipe", "pipe"],
          })) as never,
      },
    ).catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 25);
    expect(await err).toBeInstanceOf(StreamAborted);
    deadline.dispose();
  });

  it("keeps an image the run saved before it exited non-zero", async () => {
    // The scratch tree is deleted in `finally`. Classifying the exit first throws
    // away the only copy of an image the user has already paid for.
    const warn = vi.fn();
    const spawnFn = fakeSpawn([], 1, null, async (args) => {
      await writeFile(join(flagValue(args, "-C"), "fox.png"), PNG);
      await writeFile(flagValue(args, "-o"), JSON.stringify({ images: [{ path: "fox.png" }] }));
    });
    const result = await generateViaCodexExec(
      { prompt: "a fox" },
      { model: "m", logger: { ...silentLogger, warn }, spawnFn: spawnFn as never },
    );
    expect(result.images[0]?.equals(PNG)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Keeping it"));
  });

  it("maps a killed run to StreamAborted", async () => {
    await expect(
      generateViaCodexExec(
        { prompt: "a fox" },
        { model: "m", spawnFn: fakeSpawn(["{}"], null, "SIGKILL") as never },
      ),
    ).rejects.toBeInstanceOf(StreamAborted);
  });

  it("maps a clean run with no image to ContentBlocked", async () => {
    await expect(
      generateViaCodexExec(
        { prompt: "a fox" },
        {
          model: "m",
          spawnFn: fakeSpawn([JSON.stringify({ msg: { type: "agent_message" } })], 0) as never,
        },
      ),
    ).rejects.toBeInstanceOf(ContentBlocked);
  });

  it("removes the whole temporary tree, including the schema and -o files", async () => {
    let root = "";
    const spawnFn = (cmd: string, args: string[]) => {
      // The schema lives beside the workdir, not inside it.
      root = dirname(flagValue(args, "--output-schema"));
      expect(flagValue(args, "-C").startsWith(root)).toBe(true);
      return fakeSpawn([JSON.stringify({ b64_json: PNG_B64 })], 0)(cmd, args);
    };
    await generateViaCodexExec({ prompt: "a fox" }, { model: "m", spawnFn: spawnFn as never });
    await expect(stat(root)).rejects.toThrow();
  });

  it("augments the prompt before spawning", async () => {
    const spawnFn = vi.fn(fakeSpawn([JSON.stringify({ b64_json: PNG_B64 })], 0));
    const result = await generateViaCodexExec(
      { prompt: "a fox", size: "1024x1536" },
      { model: "m", spawnFn: spawnFn as never },
    );
    expect(result.effectivePrompt).toContain("[Image requirements]");
    const args = spawnFn.mock.calls[0]![1] as string[];
    expect(args[args.length - 1]).toContain("[Image requirements]");
  });

  it("tells the model to save the file and not to fabricate a path", async () => {
    const spawnFn = vi.fn(fakeSpawn([JSON.stringify({ b64_json: PNG_B64 })], 0));
    await generateViaCodexExec({ prompt: "a fox" }, { model: "m", spawnFn: spawnFn as never });
    const prompt = (spawnFn.mock.calls[0]![1] as string[]).at(-1)!;
    expect(prompt).toContain("Save the generated image");
    // The anti-fabrication clause, kept from gpt-image-bridge.
    expect(prompt).toContain("Do not invent a path");
  });

  it("does NOT spawn when the request has already run out of time", async () => {
    // A spawn is a submission. Submitting work nobody is waiting for spends quota.
    const spawnFn = vi.fn(fakeSpawn([JSON.stringify({ b64_json: PNG_B64 })], 0));
    const deadline = createDeadline(1);
    await new Promise((r) => setTimeout(r, 20));

    await expect(
      generateViaCodexExec({ prompt: "a fox" }, { model: "m", spawnFn: spawnFn as never, deadline }),
    ).rejects.toBeInstanceOf(BackendUnavailable);
    expect(spawnFn).not.toHaveBeenCalled();
    deadline.dispose();
  });

  it("kills the child at the remaining budget, not at a fresh full timeout", async () => {
    // A child that never finishes on its own, so only the kill timer can end it.
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        kill: (sig?: NodeJS.Signals) => boolean;
      };
      child.stdout = new Readable({ read() {} });
      child.stderr = Readable.from([]);
      child.kill = vi.fn((sig?: NodeJS.Signals) => {
        child.stdout.push(null);
        child.emit("close", null, sig ?? "SIGKILL");
        return true;
      });
      return child;
    });
    const deadline = createDeadline(60);
    const started = Date.now();

    await expect(
      generateViaCodexExec(
        { prompt: "a fox" },
        { model: "m", spawnFn: spawnFn as never, timeoutMs: 600_000, deadline },
      ),
    ).rejects.toBeInstanceOf(StreamAborted);
    expect(Date.now() - started).toBeLessThan(5_000);
    deadline.dispose();
  });

  // --- references: never hand an input back as the output -------------------

  /**
   * A resolved reference carrying PNG bytes, shaped exactly as `loadReferences`
   * would return it. The digest has to match the bytes or the guard under test is
   * testing nothing.
   */
  function tinyReference() {
    return {
      path: "/somewhere/photo.png",
      format: "png" as const,
      bytes: PNG.length,
      sha256: createHash("sha256").update(PNG).digest("hex"),
      dataUrl: `data:image/png;base64,${PNG_B64}`,
    };
  }

  const editRequest = { prompt: "make the sky orange", resolvedReferences: [tinyReference()] };

  it("copies each reference into work/inputs and names it in the prompt", async () => {
    let seen: string[] = [];
    let prompt = "";
    const spawnFn = fakeSpawn([], 0, null, async (args) => {
      const workdir = flagValue(args, "-C");
      prompt = args[args.length - 1]!;
      seen = await readdir(join(workdir, "inputs"));
      await writeFile(join(workdir, "fox.png"), Buffer.concat([PNG, Buffer.from("new")]));
      await writeFile(flagValue(args, "-o"), JSON.stringify({ images: [{ path: "fox.png" }] }));
    });
    await generateViaCodexExec(editRequest, { model: "m", spawnFn: spawnFn as never });
    expect(seen).toEqual(["reference-0.png"]);
    // Asserted on the argv, not on the returned `effectivePrompt`. The reference
    // clause names paths inside a temp directory that no longer exists by the time
    // anyone reads the manifest, so it is a transport detail of this backend and is
    // deliberately kept out of the provenance the caller records.
    expect(prompt).toContain("inputs/reference-0.png");
  });

  it("does not return a reference image when the run produced nothing", async () => {
    // A child that exits non-zero having written no output, with a reference sitting
    // in the workdir. The only image file present is the input.
    await expect(
      generateViaCodexExec(editRequest, { model: "m", spawnFn: fakeSpawn([], 1) as never }),
    ).rejects.toBeInstanceOf(SubmissionUncertain);
  });

  it("does not return a reference the model merely copied to a new name", async () => {
    // The bytes are what disqualify it, not the filename.
    const spawnFn = fakeSpawn([], 0, null, async (args) => {
      const workdir = flagValue(args, "-C");
      await writeFile(join(workdir, "out.png"), PNG);
      await writeFile(flagValue(args, "-o"), JSON.stringify({ images: [{ path: "out.png" }] }));
    });
    await expect(
      generateViaCodexExec(editRequest, { model: "m", spawnFn: spawnFn as never }),
    ).rejects.toBeInstanceOf(ContentBlocked);
  });

  it("removes the temporary tree, references included", async () => {
    let workdir = "";
    const spawnFn = fakeSpawn([], 0, null, async (args) => {
      workdir = flagValue(args, "-C");
    });
    await expect(
      generateViaCodexExec(editRequest, { model: "m", spawnFn: spawnFn as never }),
    ).rejects.toBeInstanceOf(ContentBlocked);
    await expect(stat(join(workdir, "inputs"))).rejects.toThrow();
  });
});
