import type { GenerationEvent } from "./types.js";

export type EventSink = (event: GenerationEvent) => void;

/**
 * One human-readable line for an engine event.
 *
 * Lives here, beside the sink type, because both consumers render the same thing:
 * the MCP reporter puts it in a progress notification and the CLI puts it on
 * stderr. Two copies is how the two surfaces end up disagreeing about what stage
 * a run is in.
 */
export function describeEvent(event: GenerationEvent): string {
  const subject = event.assetId ?? (event.index === undefined ? undefined : `image ${event.index + 1}`);
  // On the stage, not appended to the line: `message` is the written path and the
  // line reads `... done (cached) — /out/fox.png`. Where the money went is the first
  // thing a reader of this line wants and the last thing a path would let them find.
  const stage = event.cached === true ? `${event.stage} (cached)` : event.stage;
  const head = subject ? `${subject}: ${stage}` : stage;
  return event.message ? `${head} — ${event.message}` : head;
}

/**
 * Wrap a caller's event callback so it cannot fail a generation.
 *
 * The callback belongs to whoever asked for progress — an MCP adapter, a progress
 * bar, a test spy. None of them are worth a paid image: a listener that throws
 * halfway through a stream would otherwise abort a request the backend has already
 * billed. Returns a no-op when there is no listener, so call sites need no guard.
 */
export function eventSink(onEvent: EventSink | undefined): EventSink {
  if (!onEvent) return () => {};
  return (event) => {
    try {
      onEvent(event);
    } catch {
      // Deliberately silent. There is nowhere to report this that is not either
      // stdout (the MCP transport) or the same broken listener.
    }
  };
}
