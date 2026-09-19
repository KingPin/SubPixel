import { describe, expect, it } from "vitest";
import { StreamAborted } from "../../src/core/errors.js";
import { createDeadline } from "../../src/core/deadline.js";
import { parseSse, type SseEvent, type SseOptions } from "../../src/providers/sse.js";

function streamOf(chunks: string[], delayMs = 0): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      controller.enqueue(encoder.encode(chunks[index]!));
      index += 1;
    },
  });
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  options: SseOptions = {},
): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const event of parseSse(stream, options)) out.push(event);
  return out;
}

describe("parseSse", () => {
  it("parses event and data pairs", async () => {
    const events = await collect(streamOf(["event: a\ndata: {\"x\":1}\n\n"]));
    expect(events).toEqual([{ event: "a", data: '{"x":1}' }]);
  });

  it("joins multi-line data with newlines", async () => {
    const events = await collect(streamOf(["event: a\ndata: one\ndata: two\n\n"]));
    expect(events[0]!.data).toBe("one\ntwo");
  });

  it("ignores comment lines", async () => {
    const events = await collect(streamOf([": keepalive\n\nevent: a\ndata: 1\n\n"]));
    expect(events).toEqual([{ event: "a", data: "1" }]);
  });

  it("handles an event split across chunk boundaries", async () => {
    const events = await collect(streamOf(["event: a\nda", "ta: hel", "lo\n\n"]));
    expect(events).toEqual([{ event: "a", data: "hello" }]);
  });

  it("handles CRLF line endings", async () => {
    const events = await collect(streamOf(["event: a\r\ndata: hi\r\n\r\n"]));
    expect(events).toEqual([{ event: "a", data: "hi" }]);
  });

  it("handles a CRLF split down the middle by a chunk boundary", async () => {
    // The \r ends one chunk and the \n starts the next, so neither chunk contains the
    // pair. Lines are assembled from pieces and the \r is stripped off the assembled
    // line, which is the only place the two halves are ever next to each other.
    const events = await collect(streamOf(["event: a\r", "\ndata: hi\r", "\n\r", "\n"]));
    expect(events).toEqual([{ event: "a", data: "hi" }]);
  });

  it("assembles one line out of many chunks", async () => {
    // What a real image looks like on the wire: a single `data:` line carrying
    // megabytes of base64, arriving 64KB at a time. Re-scanning the accumulated
    // buffer for a newline on every chunk is quadratic in the size of the line.
    const payload = "A".repeat(1024 * 1024);
    const line = `event: a\ndata: ${payload}\n\n`;
    const chunks: string[] = [];
    for (let i = 0; i < line.length; i += 64 * 1024) chunks.push(line.slice(i, i + 64 * 1024));
    expect(chunks.length).toBeGreaterThan(10);
    const events = await collect(streamOf(chunks));
    expect(events).toEqual([{ event: "a", data: payload }]);
  });

  it("defaults the event name to message", async () => {
    const events = await collect(streamOf(["data: bare\n\n"]));
    expect(events).toEqual([{ event: "message", data: "bare" }]);
  });

  it("stops at [DONE]", async () => {
    const events = await collect(streamOf(["data: one\n\ndata: [DONE]\n\ndata: never\n\n"]));
    expect(events.map((e) => e.data)).toEqual(["one"]);
  });

  it("emits a trailing event with no blank line at end of stream", async () => {
    const events = await collect(streamOf(["event: a\ndata: last\n"]));
    expect(events).toEqual([{ event: "a", data: "last" }]);
  });

  it("throws StreamAborted when the stream stalls", async () => {
    const stalling = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: a\ndata: 1\n\n"));
        // Never closes, never sends again.
      },
    });
    await expect(collect(stalling, { stallMs: 50 })).rejects.toBeInstanceOf(StreamAborted);
  });

  it("throws StreamAborted when the total budget is exceeded", async () => {
    const slow = streamOf(["data: 1\n\n", "data: 2\n\n", "data: 3\n\n"], 40);
    await expect(collect(slow, { totalMs: 50, stallMs: 10_000 })).rejects.toBeInstanceOf(
      StreamAborted,
    );
  });

  it("charges pre-body time against a caller-supplied deadline", async () => {
    // The deadline starts before the body exists, standing in for a slow connect
    // and slow response headers. Only 20ms of the 60ms budget is left by the time
    // the parser sees the first byte, so a 40ms stream must abort.
    const deadline = createDeadline(60);
    deadline.start();
    await new Promise((r) => setTimeout(r, 40));
    const slow = streamOf(["data: 1\n\n", "data: 2\n\n"], 40);
    await expect(collect(slow, { deadline, stallMs: 10_000 })).rejects.toBeInstanceOf(
      StreamAborted,
    );
    // The parser does not dispose a deadline it did not create.
    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
  });
});
