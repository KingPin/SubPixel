import { StreamAborted } from "../core/errors.js";
import { createDeadline, type Deadline } from "../core/deadline.js";

export interface SseEvent {
  event: string;
  data: string;
}

export interface SseOptions {
  /** Abort when no event arrives for this long. Guards a hung connection. */
  stallMs?: number;
  /**
   * The request's absolute deadline, created before the fetch and shared with it.
   *
   * The parser does NOT start its own total clock. Doing so was a defect: the
   * budget would begin when the response body started arriving, so slow DNS, a
   * slow connect, and slow response headers were all free. `--timeout 60` has to
   * mean sixty seconds from the moment the request is allowed to start, which is
   * a fact only the caller knows.
   */
  deadline?: Deadline;
  /** Fallback used only when no deadline is supplied, e.g. in unit tests. */
  totalMs?: number;
}

const DEFAULT_STALL_MS = 120_000;
const DEFAULT_TOTAL_MS = 600_000;

/**
 * Parse a Server-Sent Events body.
 *
 * Two independent clocks matter here. A stall timeout catches a connection that
 * is open but silent — the common failure when the upstream drops a job. The
 * caller's deadline caps the whole request so an unattended CI run cannot hang
 * forever, and it aborts the underlying socket rather than merely rejecting a
 * promise while the server keeps generating.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  options: SseOptions = {},
): AsyncGenerator<SseEvent> {
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  // An owned deadline is disposed here; a caller's deadline belongs to the caller.
  const owned = options.deadline === undefined;
  const deadline = options.deadline ?? createDeadline(options.totalMs ?? DEFAULT_TOTAL_MS);
  if (owned) deadline.start();
  const totalMs = deadline.totalMs;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];
  let done = false;

  const flush = (): SseEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = "message";
      return undefined;
    }
    const event: SseEvent = { event: eventName, data: dataLines.join("\n") };
    eventName = "message";
    dataLines = [];
    return event;
  };

  try {
    while (!done) {
      // The deadline is absolute and was started before the fetch, so this also
      // charges connect and header time against the budget.
      if (deadline.expired) {
        throw new StreamAborted(`Stream exceeded its ${totalMs}ms total budget.`);
      }

      const budget = Math.min(stallMs, deadline.remainingMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stall = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new StreamAborted(
                budget < stallMs
                  ? `Stream exceeded its ${totalMs}ms total budget.`
                  : `Stream produced no data for ${budget}ms.`,
              ),
            ),
          budget,
        );
      });

      // `ReadableStreamReadResult` is not in the Node type surface this project
      // compiles against, so take the reader's own return type instead.
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await Promise.race([reader.read(), stall]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (chunk.done) {
        buffer += decoder.decode();
        done = true;
      } else {
        buffer += decoder.decode(chunk.value, { stream: true });
      }

      // Normalise CRLF so the line splitter below only deals with \n.
      buffer = buffer.replace(/\r\n/g, "\n");

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line === "") {
          const event = flush();
          if (event) {
            if (event.data === "[DONE]") return;
            yield event;
          }
          continue;
        }
        if (line.startsWith(":")) continue;

        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const rawValue = colon < 0 ? "" : line.slice(colon + 1);
        const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

        if (field === "event") eventName = value;
        else if (field === "data") dataLines.push(value);
        // id and retry fields are not used by this endpoint; ignore them.
      }
    }

    // A stream that ends without a trailing blank line still has one event in hand.
    const trailing = flush();
    if (trailing && trailing.data !== "[DONE]") yield trailing;
  } finally {
    await reader.cancel().catch(() => {});
    if (owned) deadline.dispose();
  }
}
