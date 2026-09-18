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
  // The pieces of the line currently being assembled, joined only once it completes.
  //
  // NOT one growing string re-scanned on every chunk. A single `data:` line here
  // carries a whole base64 image, so it arrives across dozens of chunks, and looking
  // for the newline in the whole accumulated buffer each time is quadratic: measured
  // on a 32MB line, 1.6s of scanning against 12ms for this. Each chunk is read once.
  let pending: string[] = [];
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

      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const stall = new Promise<never>((_, reject) => {
        // Two independent clocks, and each one owns exactly one of them.
        //
        // The stall timer owns `stallMs`. The DEADLINE owns the total budget, via
        // its own signal — not via a second timer here clamped to its remainder.
        // Scheduling a duplicate timer for the same instant makes which of the two
        // fires first a coin flip, and when this one won the parser reported the
        // budget as exceeded while `deadline.signal.aborted` was still false, so a
        // caller inspecting the signal saw a live deadline after a deadline abort.
        onAbort = () => {
          reject(new StreamAborted(`Stream exceeded its ${totalMs}ms total budget.`));
        };
        if (deadline.signal.aborted) {
          onAbort();
          return;
        }
        deadline.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(
          () => reject(new StreamAborted(`Stream produced no data for ${stallMs}ms.`)),
          stallMs,
        );
      });

      // `ReadableStreamReadResult` is not in the Node type surface this project
      // compiles against, so take the reader's own return type instead.
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await Promise.race([reader.read(), stall]);
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) deadline.signal.removeEventListener("abort", onAbort);
      }

      let text: string;
      if (chunk.done) {
        text = decoder.decode();
        done = true;
      } else {
        text = decoder.decode(chunk.value, { stream: true });
      }

      let from = 0;
      let newlineIndex: number;
      while ((newlineIndex = text.indexOf("\n", from)) >= 0) {
        pending.push(text.slice(from, newlineIndex));
        from = newlineIndex + 1;
        let line = pending.join("");
        pending = [];
        // CRLF, handled one line at a time. Equivalent to normalising the buffer up
        // front, because the only `\r` it removed was the one immediately before a `\n`.
        if (line.endsWith("\r")) line = line.slice(0, -1);

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
      if (from < text.length) pending.push(text.slice(from));
    }

    // A stream that ends without a trailing blank line still has one event in hand.
    const trailing = flush();
    if (trailing && trailing.data !== "[DONE]") yield trailing;
  } finally {
    await reader.cancel().catch(() => {});
    if (owned) deadline.dispose();
  }
}
