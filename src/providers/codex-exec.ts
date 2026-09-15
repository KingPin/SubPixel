import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import {
  BackendUnavailable,
  ContentBlocked,
  StreamAborted,
  SubmissionUncertain,
} from "../core/errors.js";
import { redact } from "../core/redact.js";
import type { Deadline } from "../core/deadline.js";
import type { Logger } from "../core/logger.js";
import { eventSink, type EventSink } from "../core/events.js";
import type { GenerateRequest } from "../core/types.js";
import { augmentPrompt } from "../engine/prompt.js";
import { sha256 } from "../engine/output.js";
import { findOnPath } from "../core/fsx.js";
import type { ProviderResult } from "./codex-http.js";

export const DEFAULT_EXEC_TIMEOUT_MS = 600_000;

export interface CodexExecOptions {
  model?: string;
  spawnFn?: typeof spawn;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * The caller's remaining budget. Exec runs LAST in the chain, so by the time it
   * starts, an HTTP attempt has usually already spent most of the request. Without
   * this it would start a fresh full budget and a `--timeout 60` request could run
   * for two minutes.
   */
  deadline?: Deadline;
  logger?: Logger;
  /**
   * Progress, for a caller that wants to show it. `codex exec` is opaque while it
   * runs, so this path emits far fewer events than the HTTP one: the stages it can
   * observe honestly are "the child started" and "the child finished".
   */
  onEvent?: EventSink;
}

/**
 * The shape `--output-schema` forces onto the final assistant message.
 *
 * Without it the last message is prose, and finding the saved file means
 * guessing. With it the path is a field, which is the difference between a
 * fallback that works and one that reports a refusal after spending quota.
 */
export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["images"],
  properties: {
    images: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", description: "Path to the saved image, relative to the working directory." },
          revised_prompt: { type: "string" },
        },
      },
    },
  },
} as const;

/**
 * Appended after `augmentPrompt`. The exec route needs two things the HTTP route
 * does not: an instruction to save the bytes, and the anti-fabrication clause
 * carried over from `gpt-image-bridge`. A model that reports a path it never
 * wrote turns a clean failure into a confusing one.
 */
const EXEC_CLAUSE =
  "\n\nSave the generated image into the current working directory and report its " +
  "path in your final message. Do not invent a path: report only a file you " +
  "actually created, and if no image was produced, return an empty images array.";

export async function hasCodexBinary(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await findOnPath("codex", env)) !== undefined;
}

export interface CodexArgPaths {
  workdir: string;
  schemaPath: string;
  lastMessagePath: string;
  model?: string;
  /** Absolute paths to reference files ALREADY COPIED INTO `workdir`. */
  images?: string[];
}

export function buildCodexArgs(prompt: string, options: CodexArgPaths): string[] {
  const args = [
    "exec",
    "--json",
    // A temp workdir is not a git repo and the tool must not refuse to start.
    "--skip-git-repo-check",
    // Do not pollute the user's Codex session history with our prompts.
    "--ephemeral",
    "-C",
    options.workdir,
    // workspace-write, NOT read-only: the model saves the image to a file and
    // reports the path. read-only would make the primary retrieval route
    // impossible and leave only the unreliable inline-base64 case.
    "-s",
    "workspace-write",
    // Isolate from the user's config.toml. It can set high reasoning effort, a
    // different model, MCP servers and hooks, all of which slow or destabilise a
    // headless run. Auth still comes from CODEX_HOME, which is an env var.
    "--ignore-user-config",
    // The dominant cost on this path. The spec calls this out explicitly.
    "-c",
    "model_reasoning_effort=low",
    "--output-schema",
    options.schemaPath,
    "-o",
    options.lastMessagePath,
  ];
  // The Task 1 capture confirmed this flag on the installed binary (codex-cli
  // 0.154.0: `-i, --image <FILE>...`) and confirmed the model reads the pixels,
  // so it is the primary carrier. The copy into the workdir and the prompt naming
  // below are the belt to its braces.
  for (const image of options.images ?? []) args.push("-i", image);
  if (options.model) args.push("-m", options.model);
  // Last: the prompt is argv, not shell input, so no quoting is required.
  args.push(prompt);
  return args;
}

const MAGIC: Array<[string, string]> = [
  ["89504e47", "png"],
  ["ffd8ff", "jpeg"],
  ["52494646", "webp"],
];

function looksLikeImage(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 4).toString("hex");
  return MAGIC.some(([magic]) => head.startsWith(magic));
}

const B64_FIELDS = ["b64_json", "result", "image", "image_base64", "data"];

function searchForBase64(value: unknown, depth = 0): Buffer | undefined {
  if (depth > 8 || value === null || typeof value !== "object") return undefined;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === "string" && B64_FIELDS.includes(key)) {
      const payload = child.startsWith("data:") ? (child.split(",", 2)[1] ?? "") : child;
      // Long enough to carry a magic number, nothing more. `looksLikeImage` is the
      // real filter; a bigger threshold here silently drops small valid payloads
      // instead of rejecting non-images, which is the opposite of the intent.
      if (payload.length >= 8) {
        const buffer = Buffer.from(payload, "base64");
        if (looksLikeImage(buffer)) return buffer;
      }
      continue;
    }
    const nested = searchForBase64(child, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * The `codex exec --json` event shape is not a stable contract, so the parser
 * hunts for image payloads anywhere in the object rather than pinning a path
 * that a Codex release could rename without warning.
 */
export function extractImageFromLine(line: string): Buffer | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return searchForBase64(JSON.parse(trimmed));
  } catch {
    // A partial or non-JSON line is normal in a mixed stream. Skip it.
    return undefined;
  }
}

const PATH_FIELDS = ["path", "file_path", "output_path", "saved_path", "filename", "file"];
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

function searchForPaths(value: unknown, into: string[], depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const child of value) searchForPaths(child, into, depth + 1);
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === "string" && PATH_FIELDS.includes(key)) {
      // Codex emits many paths that are not the artifact: the rollout file, log
      // files, config files. Only an image extension is worth following.
      if (IMAGE_EXT.test(child)) into.push(child);
      continue;
    }
    searchForPaths(child, into, depth + 1);
  }
}

/**
 * Pull every image-looking path out of one JSONL event, in document order.
 *
 * This is the route the spec actually expects to succeed: `codex exec` drives a
 * model that saves the image and names the file. Discarding these and hunting
 * only for inline base64 reports `ContentBlocked` on a run that worked.
 */
export function extractPathsFromLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return [];
  const found: string[] = [];
  try {
    searchForPaths(JSON.parse(trimmed), found);
  } catch {
    return [];
  }
  return found;
}

/**
 * Read a model-supplied path, but only if it really lives inside the workdir.
 *
 * The model runs with `workspace-write` and writes its own final message, so the
 * path is untrusted input. `realpath` is taken on both sides so that a symlink
 * planted inside the workdir cannot point at `~/.ssh/id_ed25519` and have those
 * bytes returned as an image. A file that is not an image is refused too — the
 * point of following the path is to get the artifact, not any readable file.
 */
async function readImageAt(root: string, candidate: string): Promise<Buffer | undefined> {
  const full = isAbsolute(candidate) ? candidate : resolvePath(root, candidate);
  let real: string;
  try {
    real = await realpath(full);
  } catch {
    // The model named a file it never wrote. This is the case the prompt's
    // anti-fabrication clause exists to reduce, not to eliminate.
    return undefined;
  }
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;

  try {
    const data = await readFile(real);
    return looksLikeImage(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the `-o` structured final message and return the paths it names. */
async function pathsFromLastMessage(lastMessagePath: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(lastMessagePath, "utf8");
  } catch {
    // Older codex versions have no -o flag, so its absence is expected, not an
    // error. The event-stream route below covers them.
    return [];
  }
  const found: string[] = [];
  try {
    // The model fills this in, so it can be null, an array, a bare string, or a
    // shape that ignores the schema. searchForPaths tolerates all of those.
    searchForPaths(JSON.parse(text), found);
  } catch {
    return [];
  }
  return found;
}

interface ChildHarvest {
  images: Buffer[];
  /** Image-looking paths seen in the event stream, in the order they appeared. */
  paths: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /**
   * Set when the child emitted `error`. `spawned` is the whole point of this
   * field: a failure BEFORE the spawn provably reached no backend and is the one
   * free retry this provider has, while anything after it is uncertain.
   */
  error?: { cause: Error; spawned: boolean };
}

async function collectFromChild(
  child: ChildProcess,
  timeoutMs: number,
  deadline?: Deadline,
): Promise<ChildHarvest> {
  const images: Buffer[] = [];
  const paths: string[] = [];
  let stderr = "";

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeoutMs);

  // The kill timer alone is not enough. The deadline can be aborted by something
  // else entirely — Ctrl-C, a sibling request failing the batch — and an unwatched
  // child would then keep running and keep spending quota.
  const onAbort = () => child.kill("SIGKILL");
  deadline?.signal.addEventListener("abort", onAbort, { once: true });

  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
  }

  const reading = (async () => {
    if (!child.stdout) return;
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const image = extractImageFromLine(line);
        if (image) images.push(image);
        paths.push(...extractPathsFromLine(line));
      }
    } catch {
      // A broken stdout pipe costs the REST of the stream, not the lines already
      // read. Those are still the best evidence of what the run produced.
    } finally {
      rl.close();
    }
  })();

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  // Without this listener an ENOENT or EACCES from the spawn is an unhandled
  // 'error' event, which takes the whole process down instead of becoming the
  // promised pre-submit exception. A PATH probe cannot replace it: the binary can
  // be removed between the probe and the spawn, and library callers never probe.
  let failure: Error | undefined;
  const errored = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", (err: Error) => {
      failure = err;
      // A spawn that never happened emits no dependable `close`, so this resolves
      // the wait itself rather than leaving the caller parked until the timer.
      resolve({ code: null, signal: null });
    });
  });

  try {
    const result = await Promise.race([
      Promise.all([reading, exit]).then(([, exited]) => exited),
      errored,
    ]);
    return {
      images,
      paths,
      stderr,
      ...result,
      // `pid` is set once the OS accepted the fork. Undefined means the spawn
      // itself failed, which is the only provably not-submitted case here.
      ...(failure && { error: { cause: failure, spawned: child.pid !== undefined } }),
    };
  } finally {
    clearTimeout(timer);
    deadline?.signal.removeEventListener("abort", onAbort);
  }
}

export async function generateViaCodexExec(
  request: GenerateRequest,
  options: CodexExecOptions,
): Promise<ProviderResult> {
  const spawnFn = options.spawnFn ?? spawn;
  const effectivePrompt = `${augmentPrompt(request.prompt, request)}${EXEC_CLAUSE}`;

  // Check BEFORE the spawn, not after. A spawn is a submission, and submitting work
  // the caller has already stopped waiting for spends quota for nothing.
  if (options.deadline?.expired) {
    throw new BackendUnavailable(
      `The request ran out of time before codex exec could start (budget ${options.deadline.totalMs} ms).`,
    );
  }
  // Two levels: the root holds the schema and the -o target, and `work/` is the
  // only directory the sandboxed model can write to. Putting the schema inside
  // the workdir would let the model rewrite its own output contract.
  const root = await mkdtemp(join(tmpdir(), "subpixel-exec-"));
  const workdir = join(root, "work");
  const schemaPath = join(root, "schema.json");
  const lastMessagePath = join(root, "last-message.json");

  try {
    await mkdir(workdir, { recursive: true });
    await writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA), "utf8");

    // The subprocess runs sandboxed with workspace-write inside this temp
    // directory. A path outside it may not be readable, so the bytes are copied in
    // rather than referenced where they sit. The extension comes from the SNIFFED
    // format, because a .png that is really a JPEG would otherwise confuse the tool
    // for no reason.
    //
    // `inputs/` is a SUBDIRECTORY, not the workdir root. The last-resort retrieval
    // route scans this tree for the newest image, and a reference sitting loose in
    // the root is a perfect candidate for it.
    const inputsDir = join(workdir, "inputs");
    const imagePaths: string[] = [];
    const inputDigests = new Set<string>();
    if (request.resolvedReferences && request.resolvedReferences.length > 0) {
      await mkdir(inputsDir, { recursive: true });
      for (const [index, reference] of request.resolvedReferences.entries()) {
        const extension = reference.format === "jpeg" ? "jpg" : reference.format;
        const copy = join(inputsDir, `reference-${index}.${extension}`);
        const bytes = Buffer.from(reference.dataUrl.split(",", 2)[1] ?? "", "base64");
        await writeFile(copy, bytes);
        imagePaths.push(copy);
        inputDigests.add(reference.sha256);
      }
    }

    // Named in the prompt as well as passed as a flag. The flag is the stronger
    // signal, but naming the files costs nothing and survives a binary that drops
    // or renames the flag.
    const promptWithReferences =
      imagePaths.length === 0
        ? effectivePrompt
        : `${effectivePrompt}\n\n[Reference images]\nThe following files in the working ` +
          `directory are reference images: ${imagePaths
            .map((path) => relative(workdir, path))
            .join(", ")}. Read them before drawing. Write your result somewhere else — ` +
          "never overwrite or re-save a reference file.";

    const args = buildCodexArgs(promptWithReferences, {
      workdir,
      schemaPath,
      lastMessagePath,
      model: options.model,
      images: imagePaths,
    });
    // Recheck HERE, not only at entry. mkdtemp, mkdir and writeFile are three
    // awaits, and a budget that was alive on entry can be gone by the time the
    // child would be created. A spawn after expiry submits work nobody is waiting
    // for. `timeoutMs` is computed here for the same reason: a remaining-time
    // value read before the setup hands the child time the caller no longer has.
    if (options.deadline?.expired) {
      throw new BackendUnavailable(
        `The request ran out of time while preparing codex exec (budget ${options.deadline.totalMs} ms).`,
      );
    }
    const timeoutMs = Math.min(
      options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
      options.deadline?.remainingMs ?? Number.POSITIVE_INFINITY,
    );

    const emitEvent = eventSink(options.onEvent);
    emitEvent({ stage: "submitted", message: "codex exec started" });

    const child = spawnFn("codex", args, {
      // CODEX_HOME must survive so the child uses the same ChatGPT login.
      env: options.env ?? process.env,
      // stdin is ignored, the equivalent of the reference's `</dev/null`, so
      // codex can never block waiting for input in a headless run.
      stdio: ["ignore", "pipe", "pipe"],
    });

    const { images: inlineImages, paths, code, signal, stderr, error } = await collectFromChild(
      child,
      timeoutMs,
      options.deadline,
    );

    // The spawn never happened, so nothing exists to harvest and nothing was
    // submitted. This is the only genuinely retryable exec failure.
    if (error && !error.spawned) {
      throw new BackendUnavailable(
        `codex exec could not be started: ${redact(error.cause)}`,
        error.cause,
      );
    }

    // HARVEST BEFORE CLASSIFYING. A killed or non-zero run can still have saved
    // the image before it died, and the `finally` below deletes the only copy.
    // Throwing first spends the quota and then discards what it bought.
    //
    // The workdir is realpath'd once. On macOS `os.tmpdir()` is a symlink into
    // /private/var, so an un-resolved root would reject every path inside it.
    const realWorkdir = await realpath(workdir);
    const found = await retrieveImage(realWorkdir, lastMessagePath, paths, inlineImages, inputDigests);

    if (found) {
      if (error || signal || code !== 0) {
        options.logger?.warn(
          `codex exec ended badly (${describeExecEnd(code, signal, error?.cause)}) but had ` +
            "already saved a usable image. Keeping it.",
        );
      }
      return { images: [found], model: options.model ?? "unknown", effectivePrompt };
    }

    // Nothing was recovered. Now report the failure, and only now.
    if (error) {
      // Post-spawn: the child ran, so this process cannot prove it never reached
      // the backend.
      throw new SubmissionUncertain(`codex exec failed: ${redact(error.cause)}`, error.cause);
    }
    if (signal) {
      throw new StreamAborted(`codex exec was terminated by ${signal} after ${timeoutMs} ms.`);
    }
    if (code !== 0) {
      // The child SPAWNED. From here on this process cannot prove whether codex
      // reached the backend before it died, so the exit code is uncertain, not
      // "unavailable". `BackendUnavailable` declares `not-submitted`, which tells
      // the orchestrator it is free to retry — and retrying an exec run that
      // already submitted spends a second unit of subscription quota.
      //
      // Only a failure BEFORE the spawn is genuinely not-submitted. That case is
      // handled by `hasCodexBinary()` and by the spawn error path above.
      throw new SubmissionUncertain(
        `codex exec exited with code ${code}: ${redact(stderr.slice(0, 500))}`,
      );
    }

    throw new ContentBlocked(
      "codex exec completed without producing a readable image. The model either " +
        "declined the request or saved the file outside its working directory.",
    );
  } finally {
    // Removes the workdir, the schema and the -o file together.
    await rm(root, { recursive: true, force: true });
  }
}

function describeExecEnd(
  code: number | null,
  signal: NodeJS.Signals | null,
  cause?: Error,
): string {
  if (cause) return redact(cause);
  if (signal) return `killed by ${signal}`;
  return `exit code ${code}`;
}

/**
 * Try each retrieval route in descending order of reliability.
 *
 * The scan is deliberately last. The spec keeps newest-file scanning "strictly as
 * a last resort after the structured path fails" because it guesses: a workdir
 * with two images has no way to say which one the model meant.
 */
async function retrieveImage(
  realWorkdir: string,
  lastMessagePath: string,
  eventPaths: readonly string[],
  inline: readonly Buffer[],
  // Content digests of every file this process placed in the workdir. Empty for a
  // request with no references, which is why the common path is unaffected.
  inputDigests: ReadonlySet<string>,
): Promise<Buffer | undefined> {
  // Applied to EVERY route, not only the scan. The structured routes read a path
  // the model reported, and a model that was asked to edit an image is entirely
  // capable of reporting the file it was given. Path-based exclusion alone would
  // not catch a straight copy to `out.png`, so the test is on the bytes.
  //
  // Without this, a run that times out, is refused, or exits non-zero returns the
  // user's own input reported as a successful generation — written to the output
  // path, banked in the cache, and under `spx sync` committed as the asset.
  const notAnInput = (data: Buffer | undefined): Buffer | undefined =>
    data && !inputDigests.has(sha256(data)) ? data : undefined;

  for (const candidate of await pathsFromLastMessage(lastMessagePath)) {
    const data = notAnInput(await readImageAt(realWorkdir, candidate));
    if (data) return data;
  }
  for (const candidate of eventPaths) {
    const data = notAnInput(await readImageAt(realWorkdir, candidate));
    if (data) return data;
  }
  const first = notAnInput(inline[0]);
  if (first) return first;
  return scanForNewestImage(realWorkdir, inputDigests);
}

const MAX_SCAN_DEPTH = 6;

/**
 * Walk the workdir and return the most recently modified image. A guess, used
 * only when every structured route has failed.
 */
async function scanForNewestImage(
  root: string,
  inputDigests: ReadonlySet<string>,
): Promise<Buffer | undefined> {
  const candidates: Array<{ path: string; mtimeMs: number }> = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      // Never follow a symlink here. It can leave the workdir, and this route is
      // already the least trustworthy one.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        // The one directory in here whose contents this process wrote.
        if (depth === 0 && entry.name === "inputs") continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !IMAGE_EXT.test(entry.name)) continue;
      try {
        candidates.push({ path: full, mtimeMs: (await stat(full)).mtimeMs });
      } catch {
        // Vanished between readdir and stat. Nothing to do.
      }
    }
  }

  await walk(root, 0);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    try {
      const data = await readFile(candidate.path);
      // The directory skip above is the cheap guard; this is the correct one.
      if (looksLikeImage(data) && !inputDigests.has(sha256(data))) return data;
    } catch {
      // Keep looking; an unreadable entry is not fatal here.
    }
  }
  return undefined;
}
