import type { CodexAuth } from "../auth/read.js";
import { buildImageToolParams } from "../engine/prompt.js";
import type { GenerateRequest, ImageToolParams } from "../core/types.js";

export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

/**
 * The endpoint rejects requests that do not look like they came from the Codex
 * CLI. These values mirror what codex_cli_rs sends.
 */
const ORIGINATOR = "codex_cli_rs";
const USER_AGENT = `${ORIGINATOR}/0.154.0 (subpixel)`;

export function buildHeaders(
  auth: Pick<CodexAuth, "accessToken" | "accountId">,
  sessionId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${auth.accessToken}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    "openai-beta": "responses=experimental",
    originator: ORIGINATOR,
    session_id: sessionId,
    "user-agent": USER_AGENT,
  };
  // Sending an empty account id is worse than sending none: the server 400s on it.
  if (auth.accountId) headers["chatgpt-account-id"] = auth.accountId;
  return headers;
}

interface InputTextPart {
  type: "input_text";
  text: string;
}

interface InputImagePart {
  type: "input_image";
  image_url: string;
}

export interface ResponsesBody {
  model: string;
  instructions: string;
  input: Array<{ type: "message"; role: "user"; content: Array<InputTextPart | InputImagePart> }>;
  tools: ImageToolParams[];
  tool_choice: { type: "image_generation" };
  reasoning: { effort: "low" };
  parallel_tool_calls: false;
  store: false;
  stream: true;
  include: string[];
}

const INSTRUCTIONS =
  "You are an image generation assistant. Call the image_generation tool exactly once " +
  "with the user's request. Do not ask clarifying questions. Do not describe the image " +
  "in prose. Produce the image.";

export function buildBody(
  request: GenerateRequest,
  model: string,
  effectivePrompt: string,
): ResponsesBody {
  const content: Array<InputTextPart | InputImagePart> = [
    { type: "input_text", text: effectivePrompt },
  ];
  for (const reference of request.resolvedReferences ?? []) {
    content.push({ type: "input_image", image_url: reference.dataUrl });
  }

  return {
    model,
    instructions: INSTRUCTIONS,
    input: [{ type: "message", role: "user", content }],
    tools: [buildImageToolParams(request)],
    tool_choice: { type: "image_generation" },
    // Pinned, not inherited. The exec backend passes `model_reasoning_effort=low`
    // explicitly; this path sent nothing, so the cost tracked whichever slug
    // `resolveModel` happened to return. Half the listed catalogue defaults to
    // `medium`, so the bill moved when the Codex cache reordered. The driver's only
    // job is one forced tool call, so there is nothing for extra effort to buy.
    reasoning: { effort: "low" },
    // One image per request keeps the failure blast radius and the quota cost small.
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: [],
  };
}
