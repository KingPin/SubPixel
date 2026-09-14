import { randomUUID } from "node:crypto";
import type { CodexAuth } from "../auth/read.js";
import { ensureFreshAuth } from "../auth/refresh.js";
import {
  ContentBlocked,
  ModelRejected,
  ModelUnavailable,
  StreamAborted,
  classifyFetchError,
  classifyHttpStatus,
  looksLikeModelUnavailable,
  rejectsDriverModel,
} from "../core/errors.js";
import { createDeadline, type Deadline } from "../core/deadline.js";
import type { Logger } from "../core/logger.js";
import { redact } from "../core/redact.js";
import type { BackendName, GenerateRequest } from "../core/types.js";
import { augmentPrompt } from "../engine/prompt.js";
import { CODEX_RESPONSES_URL, buildBody, buildHeaders } from "./codex-http-request.js";
import { parseRateLimitEvent, type RateLimitEvent } from "./quota.js";
import { parseSse } from "./sse.js";

export interface CodexHttpOptions {
  model: string;
  fetch?: typeof fetch;
  /**
   * Takes the request's deadline, and must honour it. Authentication is part of
   * the request, not a free prelude to it: a refresh that queues behind another
   * process's lock can burn the entire `--timeout` before a single byte is sent.
   */
  ensureAuth?: (deadline: Deadline) => Promise<CodexAuth>;
  stallMs?: number;
  /**
   * The request's absolute budget, started by the caller after it acquired a
   * concurrency slot. The spec is explicit that the timeout budget starts after
   * slot acquisition, so a request that waited ten minutes behind other work still
   * gets its full `--timeout`. The provider never starts this clock itself.
   */
  deadline?: Deadline;
  /** Used only when no deadline is supplied, e.g. in unit tests. */
  totalMs?: number;
  /** Warnings that must reach the user without failing the run. */
  logger?: Logger;
}

export interface ProviderResult {
  images: Buffer[];
  model: string;
  effectivePrompt: string;
  quota?: RateLimitEvent;
  /**
   * Which backend actually produced these bytes. Undefined until Task 20 puts a
   * fallback chain behind the provider; from then on it travels WITH the result.
   *
   * It is a field on the result and not a variable in the caller on purpose. The
   * batch runs several workers at once, and a shared `backendUsed` can be
   * overwritten by a sibling worker while this one awaits `sharp` or the disk —
   * which labels the manifest and the cache entry with the wrong backend.
   */
  backend?: BackendName;
}

/** Refusal wording the model and the safety system use. */
const REFUSAL_HINTS = [
  "cannot",
  "can't",
  "unable to",
  "won't",
  "not able to",
  "policy",
  "safety",
  "rejected",
];

function looksLikeRefusal(text: string): boolean {
  const lower = text.toLowerCase();
  return REFUSAL_HINTS.some((hint) => lower.includes(hint));
}

function collectAssistantText(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    const record = item as { type?: string; content?: Array<{ type?: string; text?: string }> };
    if (record.type !== "message") continue;
    for (const part of record.content ?? []) {
      if (typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join(" ").trim();
}

function imageFromOutput(output: unknown[]): string | undefined {
  for (const item of output) {
    const record = item as { type?: string; result?: unknown };
    if (record.type === "image_generation_call" && typeof record.result === "string") {
      return record.result;
    }
  }
  return undefined;
}

/**
 * The image tool as a generic output item.
 *
 * The backend does not only announce image work through the dedicated
 * `response.image_generation_call.*` events. It also streams it as
 * `response.output_item.done` carrying `item.type: "image_generation_call"` with
 * the bytes in `item.result`. In that shape the trailing `response.completed`
 * holds only usage, so there is no second copy of the image to fall back on.
 * Watching the dedicated events alone loses the bytes AND leaves `workStarted`
 * false, which then licenses a second billed attempt on any trailing failure.
 */
function imageCallItem(record: Record<string, unknown>): { result?: unknown } | undefined {
  const item = record.item;
  if (typeof item !== "object" || item === null) return undefined;
  const typed = item as { type?: unknown; result?: unknown };
  return typed.type === "image_generation_call" ? typed : undefined;
}

/**
 * Drain an error body without letting it outlive the request budget.
 *
 * `response.text()` on a body the server never finishes will hang forever. That
 * is the exact failure the deadline exists to prevent, so an unreadable body
 * degrades to an empty string rather than parking the process.
 */
async function readBodyWithin(response: Response, deadline: Deadline): Promise<string> {
  try {
    return await deadline.race(response.text(), "error body");
  } catch {
    return "";
  }
}

export async function generateViaCodexHttp(
  request: GenerateRequest,
  options: CodexHttpOptions,
): Promise<ProviderResult> {
  const doFetch = options.fetch ?? fetch;
  // An owned deadline is only for tests and direct callers; production passes one in.
  const ownsDeadline = options.deadline === undefined;
  const deadline =
    options.deadline ?? createDeadline(options.totalMs ?? 600_000, { label: "generate" });
  if (ownsDeadline) deadline.start();

  try {
    return await runRequest(request, options, doFetch, deadline);
  } finally {
    if (ownsDeadline) deadline.dispose();
  }
}

async function runRequest(
  request: GenerateRequest,
  options: CodexHttpOptions,
  doFetch: typeof fetch,
  deadline: Deadline,
): Promise<ProviderResult> {
  // Auth is inside the budget. A refresh that queues behind another process's lock
  // is still the user waiting, and a `--timeout` that only starts counting at the
  // POST is not the timeout the user asked for.
  const auth = await (options.ensureAuth ??
    ((d: Deadline) => ensureFreshAuth(undefined, { deadline: d, logger: options.logger })))(
    deadline,
  );

  const effectivePrompt = augmentPrompt(request.prompt, request);
  const headers = buildHeaders(auth, randomUUID());
  const body = buildBody(request, options.model, effectivePrompt);

  let response: Response;
  try {
    response = await doFetch(CODEX_RESPONSES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // The signal covers connect, TLS, request write, and headers. Without it the
      // deadline could only reject a promise while the socket kept running and the
      // backend kept billing the job against the subscription.
      signal: deadline.signal,
    });
  } catch (err) {
    // A fetch rejection is NOT proof that nothing was submitted. A connect refusal
    // is safe to retry elsewhere; a socket reset after the body was written is not.
    // `classifyFetchError` makes that distinction and returns SubmissionUncertain
    // when it cannot tell, which blocks fallback and protects the quota.
    throw classifyFetchError(err, { url: CODEX_RESPONSES_URL });
  }

  if (!response.ok) {
    const text = redact(await readBodyWithin(response, deadline)).slice(0, 400);
    throw classifyHttpStatus(response.status, text, undefined, { model: options.model });
  }
  if (!response.body) {
    // Headers arrived, so the job may exist upstream. Treat it as submitted.
    throw new StreamAborted("The backend returned no response body.");
  }

  let finalImage: string | undefined;
  let modelUsed = options.model;
  let quota: RateLimitEvent | undefined;
  let assistantText = "";

  // Has the model begun doing billable work on this request?
  //
  // This is the gate on in-stream model recovery. A `response.failed` carrying
  // "unknown model" is only safe to retry if it arrived BEFORE anything ran. Once
  // the image tool has been invoked — never mind completed — the request is
  // submitted in the sense that matters, and the taxonomy's `not-submitted`
  // verdict would be a lie that costs the user a second image.
  //
  // Set on the first sign of work, not on the first image. The tool call is what
  // spends quota; the completed event only proves it finished.
  let workStarted = false;

  // The whole drain sits in a try/catch, not just the `response.failed` branch.
  // A stall, a socket reset or a malformed frame makes `parseSse` throw, and that
  // path bypassed the keep-the-image rule below: an image that had already
  // arrived was discarded and the caller generated a second one.
  try {
    for await (const event of parseSse(response.body, {
      stallMs: options.stallMs,
      deadline,
    })) {
      const rateLimit = parseRateLimitEvent(event.data);
      if (rateLimit) {
        quota = rateLimit;
        continue;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        continue;
      }
      // `JSON.parse("null")` succeeds; a cast would throw on the next property read.
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
      const record = payload as Record<string, unknown>;

      const type = typeof record.type === "string" ? record.type : event.event;

      // Any image_generation_call event at all means the tool was invoked. Match on
      // the prefix rather than the `.completed` suffix so `.in_progress`,
      // `.generating` and `.partial_image` all close the recovery window too.
      if (type.startsWith("response.image_generation_call")) {
        workStarted = true;
      }

      // The same tool call also arrives wrapped in a generic output item. Both the
      // "work began" signal and the bytes can come only through this path.
      if (type.startsWith("response.output_item")) {
        const item = imageCallItem(record);
        if (item) {
          workStarted = true;
          if (typeof item.result === "string") {
            finalImage = item.result;
            continue;
          }
        }
      }

      if (type === "response.image_generation_call.completed" && typeof record.result === "string") {
        finalImage = record.result;
        continue;
      }

      if (type === "response.failed" || type === "response.error") {
        const nested = record.response as { error?: { message?: string } } | null | undefined;
        const message =
          nested?.error?.message ??
          (record.error as { message?: string } | null | undefined)?.message ??
          "The backend reported a failure with no message.";
        const safe = redact(message);

        // If bytes already arrived, a trailing failure event does not undo them.
        // Returning what we have is strictly better than throwing away a paid image
        // and then generating a second one.
        if (finalImage) {
          options.logger?.warn(
            `The backend reported "${safe}" after the image was already produced. ` +
              "Keeping the image.",
          );
          break;
        }

        // Exactly one in-stream failure is worth retrying on another model: the
        // backend rejecting the image model by name BEFORE any work began. Nothing
        // was generated, so nothing was billed.
        //
        // `workStarted` is the guard the string match cannot provide. A matching
        // message arriving after the tool ran describes a mid-generation collapse,
        // not a pre-flight rejection, and quota may already be spent. Everything
        // else stays non-recoverable by construction.
        if (workStarted) {
          throw new StreamAborted(safe);
        }
        if (looksLikeModelUnavailable(safe)) {
          // Shape AND subject, via the same check the HTTP 400 classifier uses. A
          // rejection that does not name the driver slug as the subject of its
          // verdict is about the image tool's own model, which recovery cannot
          // route around: every remaining candidate sends the same tool.
          if (rejectsDriverModel(safe, options.model)) {
            throw new ModelUnavailable(safe, options.model);
          }
          throw new ModelRejected(safe, options.model);
        }
        throw new ContentBlocked(safe);
      }

      if (type === "response.completed") {
        const nested = record.response as { model?: string; output?: unknown[] } | null | undefined;
        if (typeof nested?.model === "string") modelUsed = nested.model;
        const output = Array.isArray(nested?.output) ? nested.output : [];
        finalImage = imageFromOutput(output) ?? finalImage;
        assistantText = collectAssistantText(output);
      }
    }
  } catch (err) {
    // No image yet means nothing was lost: report the transport failure as-is,
    // with whatever submission verdict it already carries.
    if (!finalImage) throw err;
    options.logger?.warn(
      `The image stream failed after the image was already produced (${redact(err)}). ` +
        "Keeping the image.",
    );
  }

  if (!finalImage) {
    const detail = assistantText
      ? `The model replied in text instead of generating an image: "${redact(assistantText).slice(0, 300)}"`
      : "The stream completed without producing an image.";
    // Either way the request was submitted, so this is not a fallback-eligible failure.
    if (assistantText && !looksLikeRefusal(assistantText)) {
      throw new ContentBlocked(`${detail} Try rephrasing the prompt.`);
    }
    throw new ContentBlocked(detail);
  }

  return {
    images: [Buffer.from(finalImage, "base64")],
    model: modelUsed,
    effectivePrompt,
    quota,
  };
}
