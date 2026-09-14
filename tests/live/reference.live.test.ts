import { execFile, spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { readAuth } from "../../src/auth/read.js";
import { redact } from "../../src/core/redact.js";
import type { GenerateRequest } from "../../src/core/types.js";
import { resolveModel } from "../../src/providers/models.js";
import { buildBody, buildHeaders, CODEX_RESPONSES_URL } from "../../src/providers/codex-http-request.js";
import { TINY_PNG_DATA_URL, tinyPng } from "../fixtures/tiny.png.js";

const run = promisify(execFile);
const live = process.env.SUBPIXEL_LIVE === "1";

/**
 * Run a child with its stdin CLOSED and collect what it said.
 *
 * `codex exec` reads a trailing prompt from stdin when stdin is a pipe, so the
 * obvious `promisify(execFile)` call blocks forever on "Reading additional input
 * from stdin..." and times out. That timeout looks exactly like a backend refusal
 * in the transcript, which is the failure mode this whole task exists to avoid:
 * the first run of this probe recorded two FAILED exec routes that had never
 * reached the backend at all. `execFile` has no stdin option, so it is spawn.
 */
function runClosedStdin(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number },
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `spawn failed: ${String(err)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
  });
}

/**
 * Read one SSE stream until it says something CONCLUSIVE about the reference.
 *
 * The earlier version of this probe stopped at 8 KB or at the first event that
 * merely mentioned an image. Both stops can land before the endpoint has said
 * anything about the attachment, and the transcript then reads like an acceptance.
 * A guess dressed as a capture is worse than no capture: Tasks 4 and 5 are written
 * against this sentence, and a wrong one spends quota on requests that cannot work.
 *
 * So there are exactly three conclusive outcomes — an error event, a completed
 * image event, or a stream that closed — and everything else is reported as
 * `INCONCLUSIVE` with what was seen. `INCONCLUSIVE` does not close Task 1.
 */
async function firstVerdict(response: Response): Promise<string> {
  if (!response.ok) return `HTTP ${response.status}: ${redact(await response.text()).slice(0, 400)}`;
  const reader = response.body?.getReader();
  if (!reader) return "INCONCLUSIVE: no body";
  const decoder = new TextDecoder();
  let seen = "";
  let verdict = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      verdict ||= "stream closed";
      break;
    }
    seen += decoder.decode(value, { stream: true });
    // An error event is a decision. So is a COMPLETED image event — the partial
    // `image_generation_call` frame that the old probe stopped on is emitted while
    // the request is still being planned and says nothing about the reference.
    if (/"type"\s*:\s*"[^"]*error/.test(seen)) {
      verdict = "error event";
      break;
    }
    if (seen.includes("image_generation_call.completed") || seen.includes('"b64_json"')) {
      verdict = "image produced";
      break;
    }
    // No byte ceiling. A long planning preamble is normal and cutting it short is
    // what produced the false "accepted" reading. The caller's test timeout is the
    // real bound, and it fails loudly instead of returning a comfortable guess.
  }
  await reader.cancel().catch(() => {});
  const tail = redact(seen).slice(-800);
  return verdict === "stream closed" && !seen.includes('"b64_json"')
    ? `INCONCLUSIVE: stream closed with no image and no error — ${tail}`
    : `${verdict} — ${tail}`;
}

/**
 * The exec routes worth trying, in the order Task 5 would prefer them.
 *
 * Both are tried even if `--help` listed neither flag, because a help listing and
 * an argument parser disagree more often than either should. A rejected flag costs
 * nothing; an unasked question costs a wrong verdict in the capture document.
 */
function execAttempts(imagePath: string): Array<{ label: string; args: string[] }> {
  const ask = "Name the single colour of the attached image in one word. If you cannot see an image, say NO IMAGE.";
  return [
    { label: "-i flag", args: ["exec", "-i", imagePath, "--skip-git-repo-check", ask] },
    {
      label: "filename in prompt, file in cwd",
      args: ["exec", "--skip-git-repo-check", `${ask} The image is the file tiny.png in the working directory.`],
    },
  ];
}

describe.runIf(live)("reference image capture", () => {
  it("records what each backend accepts as a reference image", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subpixel-ref-"));
    const imagePath = join(dir, "tiny.png");
    await writeFile(imagePath, tinyPng());

    const auth = await readAuth();
    const resolved = await resolveModel({});
    const notes: string[] = [];

    notes.push(`- Date: ${new Date().toISOString()}`);
    notes.push(`- Driver model: ${resolved.slug} (source: ${resolved.source})`);

    // 1. codex-http with a data: URL.
    //
    // The reference is passed in BOTH shapes on purpose. Today `buildBody` reads
    // `referenceImages`; Task 4 Step 6 changes it to read `resolvedReferences` and
    // nothing else. A probe that only set the old field would, from that commit on,
    // send a request with no reference at all and record the resulting success as
    // "the encoding is accepted" — the most expensive kind of wrong answer this
    // document can contain. Setting both keeps the capture re-runnable across that
    // change. Task 4 Step 6 must re-run this probe and confirm the recorded verdict
    // still holds.
    const asReference = (url: string) => ({
      path: imagePath,
      format: "png" as const,
      bytes: tinyPng().length,
      sha256: "0".repeat(64),
      dataUrl: url,
    });
    const dataUrlBody = buildBody(
      {
        prompt: "Recolour this square blue.",
        referenceImages: [TINY_PNG_DATA_URL],
        resolvedReferences: [asReference(TINY_PNG_DATA_URL)],
      } as GenerateRequest,
      resolved.slug,
      "Recolour this square blue.",
    );
    // Fail loudly rather than probing an empty request. A body with no image in it
    // answers a different question than the one this task exists to answer.
    expect(JSON.stringify(dataUrlBody)).toContain("input_image");
    const dataUrlResponse = await fetch(CODEX_RESPONSES_URL, {
      method: "POST",
      headers: buildHeaders(auth, `capture-${Date.now()}`),
      body: JSON.stringify(dataUrlBody),
    });
    notes.push(`- codex-http, \`data:\` URL → ${await firstVerdict(dataUrlResponse)}`);

    // 2. codex-http with a bare local path, which is what the current code would
    //    send today. Recorded so the findings say what the defect looks like.
    const pathBody = buildBody(
      {
        prompt: "Recolour this square blue.",
        referenceImages: [imagePath],
        // The bare path sits where the encoded image belongs. That IS the defect
        // being recorded: whatever string the caller supplied goes out as
        // `image_url`.
        resolvedReferences: [asReference(imagePath)],
      } as GenerateRequest,
      resolved.slug,
      "Recolour this square blue.",
    );
    const pathResponse = await fetch(CODEX_RESPONSES_URL, {
      method: "POST",
      headers: buildHeaders(auth, `capture-${Date.now()}`),
      body: JSON.stringify(pathBody),
    });
    notes.push(`- codex-http, bare local path → ${await firstVerdict(pathResponse)}`);

    // 3. codex exec: which flag, if any, attaches an image.
    try {
      const { stdout } = await run("codex", ["exec", "--help"]);
      const imageFlags = stdout
        .split("\n")
        .filter((line) => /image|--i\b|-i,/i.test(line))
        .map((line) => line.trim());
      notes.push(`- codex exec image flags: ${imageFlags.join(" | ") || "none found"}`);
      const { stdout: version } = await run("codex", ["--version"]);
      notes.push(`- codex binary: ${version.trim()}`);
    } catch (err) {
      notes.push(`- codex exec: not probed (${redact(err)})`);
    }

    // 4. codex exec, ACTUALLY SUBMITTING the reference. A `--help` listing proves a
    //    flag parses; it proves nothing about whether the model receives the pixels.
    //    Task 5 routes real user images through this path, so this probe has to
    //    close the question the help text leaves open: can the model READ the file?
    //
    //    The fixture is a single solid colour, so the answer is a word the model
    //    cannot produce by guessing. "I cannot see an image" is an equally usable
    //    verdict — what is not usable is never having asked.
    for (const attempt of execAttempts(imagePath)) {
      const { ok, output } = await runClosedStdin("codex", attempt.args, {
        cwd: dir,
        timeoutMs: 180_000,
      });
      const label = ok ? "answered" : "FAILED";
      notes.push(`- codex exec, ${attempt.label} → ${label}: ${redact(output).slice(-600)}`);
    }

    // The findings are the deliverable. Printing them is how they get transcribed
    // into the capture document; the assertion only proves the probe ran.
    process.stdout.write(`\n${notes.join("\n")}\n`);
    expect(notes.length).toBeGreaterThan(3);
  }, 300_000);
});
