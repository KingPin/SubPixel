import { describe, expect, it, vi } from "vitest";
import {
  AuthExpired,
  BackendUnavailable,
  ContentBlocked,
  ModelRejected,
  ModelUnavailable,
  RateLimited,
  StreamAborted,
  SubmissionUncertain,
} from "../../src/core/errors.js";
import { createDeadline } from "../../src/core/deadline.js";
import { silentLogger } from "../../src/core/logger.js";
import { generateViaCodexHttp } from "../../src/providers/codex-http.js";

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

const AUTH = {
  path: "/tmp/auth.json",
  accessToken: "tok_live",
  accountId: "acct_123",
  refreshToken: "rt",
};

function sseResponse(lines: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(line));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

function completedWithImage(): string[] {
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created" })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        model: "gpt-5.6-sol",
        output: [
          { type: "image_generation_call", status: "completed", result: PNG_B64, output_format: "png" },
        ],
      },
    })}\n\n`,
  ];
}

const deps = (fetchImpl: unknown) => ({
  fetch: fetchImpl as typeof fetch,
  ensureAuth: async () => AUTH,
});

describe("generateViaCodexHttp", () => {
  it("returns image bytes from a completed response", async () => {
    const result = await generateViaCodexHttp(
      { prompt: "a fox" },
      { model: "gpt-5.6-sol", ...deps(async () => sseResponse(completedWithImage())) },
    );
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(result.model).toBe("gpt-5.6-sol");
  });

  it("accepts the image from a streamed completed-image event", async () => {
    const lines = [
      `event: response.image_generation_call.completed\ndata: ${JSON.stringify({
        type: "response.image_generation_call.completed",
        result: PNG_B64,
      })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { model: "m", output: [] },
      })}\n\n`,
    ];
    const result = await generateViaCodexHttp(
      { prompt: "x" },
      { model: "m", ...deps(async () => sseResponse(lines)) },
    );
    expect(result.images).toHaveLength(1);
  });

  it("prefers the final image over a partial one", async () => {
    const partial = Buffer.from([0x01]).toString("base64");
    const lines = [
      `event: response.image_generation_call.partial_image\ndata: ${JSON.stringify({
        type: "response.image_generation_call.partial_image",
        partial_image_b64: partial,
      })}\n\n`,
      ...completedWithImage(),
    ];
    const result = await generateViaCodexHttp(
      { prompt: "x" },
      { model: "m", ...deps(async () => sseResponse(lines)) },
    );
    expect(result.images[0]!.length).toBeGreaterThan(1);
  });

  it("surfaces quota telemetry seen mid-stream", async () => {
    const lines = [
      `event: response.rate_limits.updated\ndata: ${JSON.stringify({
        type: "response.rate_limits.updated",
        plan_type: "plus",
        rate_limits: [{ used_percent: 42, window_minutes: 300 }],
      })}\n\n`,
      ...completedWithImage(),
    ];
    const result = await generateViaCodexHttp(
      { prompt: "x" },
      { model: "m", ...deps(async () => sseResponse(lines)) },
    );
    expect(result.quota?.planType).toBe("plus");
    expect(result.quota?.windows[0]!.usedPercent).toBe(42);
  });

  it("throws ContentBlocked when the model answers in prose", async () => {
    const lines = [
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: {
          model: "m",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "I cannot create that image." }],
            },
          ],
        },
      })}\n\n`,
    ];
    const err = await generateViaCodexHttp(
      { prompt: "x" },
      { model: "m", ...deps(async () => sseResponse(lines)) },
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ContentBlocked);
    expect(String(err)).toContain("cannot create");
  });

  it("throws ContentBlocked on a failed response event", async () => {
    const lines = [
      `event: response.failed\ndata: ${JSON.stringify({
        type: "response.failed",
        response: { error: { message: "Request rejected by safety system." } },
      })}\n\n`,
    ];
    await expect(
      generateViaCodexHttp({ prompt: "x" }, { model: "m", ...deps(async () => sseResponse(lines)) }),
    ).rejects.toBeInstanceOf(ContentBlocked);
  });

  it("maps a 429 to RateLimited", async () => {
    await expect(
      generateViaCodexHttp(
        { prompt: "x" },
        { model: "m", ...deps(async () => new Response("slow down", { status: 429 })) },
      ),
    ).rejects.toBeInstanceOf(RateLimited);
  });

  it("maps a 401 to AuthExpired", async () => {
    await expect(
      generateViaCodexHttp(
        { prompt: "x" },
        { model: "m", ...deps(async () => new Response("nope", { status: 401 })) },
      ),
    ).rejects.toBeInstanceOf(AuthExpired);
  });

  it("sends the augmented prompt", async () => {
    const fetchMock = vi.fn(async () => sseResponse(completedWithImage()));
    await generateViaCodexHttp(
      { prompt: "a fox", size: "1024x1536" },
      { model: "m", ...deps(fetchMock) },
    );
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(init.body)).toContain("2:3 portrait");
  });

  it("refreshes credentials before sending, under the request's own deadline", async () => {
    const ensureAuth = vi.fn(async () => AUTH);
    const deadline = createDeadline(5_000);
    await generateViaCodexHttp(
      { prompt: "x" },
      {
        model: "m",
        deadline,
        fetch: (async () => sseResponse(completedWithImage())) as unknown as typeof fetch,
        ensureAuth,
      },
    );
    expect(ensureAuth).toHaveBeenCalledTimes(1);
    // Not a fresh budget of its own: auth waiting is the user waiting.
    expect(ensureAuth).toHaveBeenCalledWith(deadline);
    deadline.dispose();
  });

  it("gives up when auth alone outlasts the budget, without sending the request", async () => {
    const fetchMock = vi.fn(async () => sseResponse(completedWithImage()));
    const deadline = createDeadline(20);
    const err = await generateViaCodexHttp(
      { prompt: "x" },
      {
        model: "m",
        deadline,
        fetch: fetchMock as unknown as typeof fetch,
        ensureAuth: (d) => d.race(new Promise<never>(() => {}), "slow auth"),
      },
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(fetchMock).not.toHaveBeenCalled();
    deadline.dispose();
  });

  it("passes the deadline signal to fetch", async () => {
    const deadline = createDeadline(5_000);
    deadline.start();
    const fetchMock = vi.fn(async () => sseResponse(completedWithImage()));
    await generateViaCodexHttp({ prompt: "x" }, { model: "m", deadline, ...deps(fetchMock) });
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(init.signal).toBe(deadline.signal);
    deadline.dispose();
  });

  it("treats a connect refusal as not submitted", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const err = await generateViaCodexHttp(
      { prompt: "x" },
      {
        model: "m",
        ...deps(async () => {
          throw refused;
        }),
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendUnavailable);
    expect((err as BackendUnavailable).canFallback).toBe(true);
  });

  it("treats a mid-flight socket reset as uncertain, not as a free retry", async () => {
    // The body may already be on the wire, so the job may exist upstream. Falling
    // back here would risk spending the subscription quota twice for one image.
    const reset = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    });
    const err = await generateViaCodexHttp(
      { prompt: "x" },
      {
        model: "m",
        ...deps(async () => {
          throw reset;
        }),
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionUncertain);
    expect((err as SubmissionUncertain).canFallback).toBe(false);
  });

  it("maps an in-stream model rejection to ModelUnavailable", async () => {
    const lines = [
      'data: {"type":"response.failed","response":{"error":{"message":"The model `gpt-image-9` does not exist"}}}\n\n',
    ];
    const err = await generateViaCodexHttp(
      { prompt: "x" },
      { model: "gpt-image-9", ...deps(async () => sseResponse(lines)) },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailable);
    expect((err as ModelUnavailable).model).toBe("gpt-image-9");
    expect((err as ModelUnavailable).message).toContain("does not exist");
  });

  it("does NOT map a matching message to ModelUnavailable once the tool has run", async () => {
    // Same text as the test above. The difference is that generation started, so
    // quota may already be spent and a `not-submitted` verdict would be a lie.
    const lines = [
      'data: {"type":"response.image_generation_call.in_progress"}\n\n',
      'data: {"type":"response.failed","response":{"error":{"message":"The model `gpt-image-9` does not exist"}}}\n\n',
    ];
    const err = await generateViaCodexHttp(
      { prompt: "x" },
      { model: "gpt-image-9", ...deps(async () => sseResponse(lines)) },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamAborted);
    expect(err).not.toBeInstanceOf(ModelUnavailable);
    expect((err as StreamAborted).canFallback).toBe(false);
  });

  it("keeps the image when a failure event arrives after the bytes", async () => {
    // Throwing here would discard an image the user has already paid for, and the
    // recovery loop above would then generate a second one.
    const warn = vi.fn();
    const lines = [
      ...completedWithImage(),
      'data: {"type":"response.failed","response":{"error":{"message":"unknown model"}}}\n\n',
    ];
    const result = await generateViaCodexHttp(
      { prompt: "x" },
      { model: "m", logger: { ...silentLogger, warn }, ...deps(async () => sseResponse(lines)) },
    );
    expect(result.images).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Keeping the image"));
  });

  it("takes the image from a response.output_item.done tool call", async () => {
    // The shape the local reference captures: the bytes ride on the generic
    // output item, and `response.completed` then carries usage only. Watching the
    // dedicated image events alone returns nothing here.
    const lines = [
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: { type: "image_generation_call", result: PNG_B64, size: "1024x1024" },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { model: "gpt-5.6-sol", usage: { total_tokens: 2357 } },
      })}\n\n`,
    ];
    const result = await generateViaCodexHttp(
      { prompt: "a cat" },
      { model: "gpt-5.6-sol", ...deps(async () => sseResponse(lines)) },
    );
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(result.model).toBe("gpt-5.6-sol");
  });

  it("keeps the output-item image when the stream then fails on model text", async () => {
    // The trailing-failure variant. Bytes already arrived through the output
    // item, so this must keep them — and must NOT report a fallback-eligible
    // ModelUnavailable for an image that was already paid for.
    const warn = vi.fn();
    const lines = [
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: { type: "image_generation_call", result: PNG_B64 },
      })}\n\n`,
      'data: {"type":"response.failed","response":{"error":{"message":"Image model not available"}}}\n\n',
    ];
    const result = await generateViaCodexHttp(
      { prompt: "x" },
      { model: "m", logger: { ...silentLogger, warn }, ...deps(async () => sseResponse(lines)) },
    );
    expect(result.images).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Keeping the image"));
  });

  it("does NOT map a rejection of the image tool's model to ModelUnavailable", async () => {
    // The driver is `gpt-5.6-sol`; the unavailable model is the one inside the
    // image_generation tool. Advancing the driver list sends the same tool config
    // to every candidate and collects the same refusal each time.
    const lines = [
      'data: {"type":"response.failed","response":{"error":{"message":"The model `gpt-image-2.5-flare` is not available"}}}\n\n',
    ];
    const err = await generateViaCodexHttp(
      { prompt: "x" },
      { model: "gpt-5.6-sol", ...deps(async () => sseResponse(lines)) },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelRejected);
    expect(err).not.toBeInstanceOf(ModelUnavailable);
    expect((err as ModelRejected).canFallback).toBe(false);
  });

  it("does NOT map a rejection of a LONGER model name to ModelUnavailable", async () => {
    // The driver is `driver-a`; the rejected model is `driver-a-image`, the image
    // tool's own. A containment test cannot tell these apart, and treating this as
    // recoverable walks the whole candidate list spending quota on each one.
    const lines = [
      'data: {"type":"response.failed","response":{"error":{"message":"Image model driver-a-image not available"}}}\n\n',
    ];
    const err = await generateViaCodexHttp(
      { prompt: "x" },
      { model: "driver-a", ...deps(async () => sseResponse(lines)) },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelRejected);
    expect(err).not.toBeInstanceOf(ModelUnavailable);
    expect((err as ModelRejected).canFallback).toBe(false);
  });

  it("does NOT map a tool rejection that merely mentions the driver", async () => {
    // The driver slug appears, and so does an availability verdict — but the
    // verdict is about the other model. Subjecthood, not containment, decides.
    const lines = [
      'data: {"type":"response.failed","response":{"error":{"message":"Generation for driver-a failed: the image model gpt-image-2 is not available"}}}\n\n',
    ];
    const err = await generateViaCodexHttp(
      { prompt: "x" },
      { model: "driver-a", ...deps(async () => sseResponse(lines)) },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelRejected);
    expect(err).not.toBeInstanceOf(ModelUnavailable);
    expect((err as ModelRejected).canFallback).toBe(false);
  });

  it("keeps the image when the stream itself dies after the bytes", async () => {
    // Not a `response.failed` event — the transport breaks. The keep-the-image
    // rule has to cover this too, or the paid output is thrown away.
    const warn = vi.fn();
    // `controller.error()` resets the queue, so bytes enqueued and errored inside the
    // same `start()` are never delivered. Hand the chunk over on the first pull and
    // break the socket on the next one, which is the order a real reset arrives in.
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new Error("socket hang up"));
          return;
        }
        sent = true;
        controller.enqueue(new TextEncoder().encode(completedWithImage().join("")));
      },
    });
    const result = await generateViaCodexHttp(
      { prompt: "x" },
      {
        model: "m",
        logger: { ...silentLogger, warn },
        ...deps(async () => new Response(body, { headers: { "content-type": "text/event-stream" } })),
      },
    );
    expect(result.images).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Keeping the image"));
  });

  it("propagates a stream failure that arrives before any bytes", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("socket hang up"));
      },
    });
    await expect(
      generateViaCodexHttp(
        { prompt: "x" },
        {
          model: "m",
          ...deps(async () => new Response(body, { headers: { "content-type": "text/event-stream" } })),
        },
      ),
    ).rejects.toThrow();
  });

  it("skips a stream payload that parses to null", async () => {
    const lines = ["data: null\n\n", ...completedWithImage()];
    const result = await generateViaCodexHttp(
      { prompt: "x" },
      { model: "m", ...deps(async () => sseResponse(lines)) },
    );
    expect(result.images).toHaveLength(1);
  });
});
