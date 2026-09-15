import type { SubpixelConfig } from "../config/schema.js";
import type { EventSink } from "../core/events.js";
import type { GenerationEvent } from "../core/types.js";

/**
 * How long a generating tool call stays open before it hands back a `job_id`.
 *
 * Five seconds is well inside every host timeout observed so far, and it is long
 * enough that a cache hit — the common case in a repeat run — returns the image
 * rather than a job the host then has to poll for something already on disk.
 */
export const DEFAULT_CUTOVER_MS = 5000;

/** `SUBPIXEL_MCP_CUTOVER_MS` beats the project config, which beats the default. */
export function resolveCutoverMs(
  config: SubpixelConfig,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.SUBPIXEL_MCP_CUTOVER_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    // A bad value falls back rather than throwing. This is read while a tool call is
    // already in flight, and refusing to generate because an environment variable is
    // misspelt is a worse answer than using the default.
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return config.mcp?.cutoverMs ?? DEFAULT_CUTOVER_MS;
}

export type ProgressToken = string | number;

export interface ProgressNotification {
  method: "notifications/progress";
  params: { progressToken: ProgressToken; progress: number; message?: string };
}

export interface ProgressReporter {
  /** Hand this to `GenerateDeps.onEvent`. */
  onEvent: EventSink;
  /** Stop sending. Called before the tool call returns, and safe to call twice. */
  stop(): void;
}

function describe(event: GenerationEvent): string {
  const subject = event.assetId ?? (event.index === undefined ? undefined : `image ${event.index + 1}`);
  const head = subject ? `${subject}: ${event.stage}` : event.stage;
  return event.message ? `${head} — ${event.message}` : head;
}

/**
 * Turn engine events into protocol progress notifications.
 *
 * Two rules the engine does not follow, and which this exists to impose:
 *
 * 1. **The value is a counter owned by this request.** MCP requires every
 *    notification to carry a larger `progress` than the last, and the engine is
 *    allowed to repeat itself — a queued image and a submitted image legitimately
 *    carry the same number, or none. So the wire value counts notifications, not
 *    images.
 * 2. **Nothing is sent after the call returns.** A notification that arrives once
 *    the host has the result is a notification against a token that no longer
 *    exists, and hosts differ on how loudly they complain about it.
 *
 * `total` is deliberately never sent. The engine's total counts images and this
 * counter counts notifications; publishing the two together would label the bar
 * with a denominator from a different unit, and an honestly indeterminate bar is
 * better than a confidently wrong one.
 */
export function createProgressReporter(
  progressToken: ProgressToken,
  send: (notification: ProgressNotification) => Promise<void> | void,
): ProgressReporter {
  let progress = 0;
  let live = true;

  return {
    onEvent: (event) => {
      if (!live) return;
      progress += 1;
      void Promise.resolve(
        send({
          method: "notifications/progress",
          params: { progressToken, progress, message: describe(event) },
        }),
        // A host that closed the stream is not a reason to abandon a paid image.
      ).catch(() => {});
    },
    stop: () => {
      live = false;
    },
  };
}
