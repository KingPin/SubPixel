import type { GenerationEvent } from "./types.js";

export type EventSink = (event: GenerationEvent) => void;

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
