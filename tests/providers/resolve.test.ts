import { describe, expect, it, vi } from "vitest";
import {
  AuthExpired,
  BackendUnavailable,
  ConfigError,
  ContentBlocked,
  ModelUnavailable,
  RateLimited,
  StreamAborted,
  SubmissionUncertain,
} from "../../src/core/errors.js";
import { resolveChain, runWithFallback } from "../../src/providers/resolve.js";
// Exported from generate.ts purely so the nested recovery path is testable. The
// double-spend bug lives in the COMPOSITION of these two functions, and neither
// one tested alone can show it.
import { callWithModelRecovery } from "../../src/engine/generate.js";
import { createDeadline } from "../../src/core/deadline.js";
import { silentLogger } from "../../src/core/logger.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const ok = { images: [PNG], model: "m", effectivePrompt: "a fox" };

describe("resolveChain", () => {
  it("defaults to the two subscription backends", () => {
    expect(resolveChain({ hasCodexBinary: true })).toEqual(["codex-http", "codex-exec"]);
  });

  it("never includes the paid backend by default", () => {
    expect(resolveChain({ hasCodexBinary: true })).not.toContain("api");
  });

  it("drops codex-exec when the binary is missing", () => {
    expect(resolveChain({ hasCodexBinary: false })).toEqual(["codex-http"]);
  });

  it("pins a single backend when one is requested", () => {
    expect(resolveChain({ hasCodexBinary: true, requested: "codex-exec" })).toEqual(["codex-exec"]);
  });

  it("refuses the paid backend, which no provider implements yet", () => {
    // The refusal lives in the resolver, not the CLI parser, because the CLI is not
    // the only way in: a project config may still carry `backend: "api"`. Without
    // this the chain reaches `runWithFallback` and dies on a missing runner, which
    // reads as a bug in subpixel rather than a backend that has not shipped.
    expect(() => resolveChain({ hasCodexBinary: true, requested: "api" })).toThrow(ConfigError);
    expect(() => resolveChain({ hasCodexBinary: true, requested: "api" })).toThrow(
      /not implemented yet/,
    );
  });

  it("refuses a pinned codex-exec when the binary is missing", () => {
    expect(() => resolveChain({ hasCodexBinary: false, requested: "codex-exec" })).toThrow(
      ConfigError,
    );
  });
});

describe("runWithFallback", () => {
  function runners(map: Record<string, unknown>) {
    return Object.fromEntries(
      Object.entries(map).map(([k, v]) => [
        k,
        typeof v === "function" ? v : vi.fn().mockResolvedValue(v),
      ]),
    ) as never;
  }

  it("returns the first success", async () => {
    const second = vi.fn();
    const result = await runWithFallback(
      ["codex-http", "codex-exec"],
      runners({ "codex-http": ok, "codex-exec": second }),
      silentLogger,
    );
    expect(result.backend).toBe("codex-http");
    expect(second).not.toHaveBeenCalled();
  });

  it("advances past a pre-submit failure", async () => {
    const result = await runWithFallback(
      ["codex-http", "codex-exec"],
      runners({
        "codex-http": vi.fn().mockRejectedValue(new BackendUnavailable("503")),
        "codex-exec": ok,
      }),
      silentLogger,
    );
    expect(result.backend).toBe("codex-exec");
  });

  it("advances past an auth failure", async () => {
    const result = await runWithFallback(
      ["codex-http", "codex-exec"],
      runners({
        "codex-http": vi.fn().mockRejectedValue(new AuthExpired("no token")),
        "codex-exec": ok,
      }),
      silentLogger,
    );
    expect(result.backend).toBe("codex-exec");
  });

  it("stops on a rate limit even though it extends BackendUnavailable", async () => {
    const second = vi.fn();
    await expect(
      runWithFallback(
        ["codex-http", "codex-exec"],
        runners({
          "codex-http": vi.fn().mockRejectedValue(new RateLimited("429", "2026-09-13T00:00:00Z")),
          "codex-exec": second,
        }),
        silentLogger,
      ),
    ).rejects.toBeInstanceOf(RateLimited);
    expect(second).not.toHaveBeenCalled();
  });

  it("stops on a content refusal", async () => {
    const second = vi.fn();
    await expect(
      runWithFallback(
        ["codex-http", "codex-exec"],
        runners({
          "codex-http": vi.fn().mockRejectedValue(new ContentBlocked("refused")),
          "codex-exec": second,
        }),
        silentLogger,
      ),
    ).rejects.toBeInstanceOf(ContentBlocked);
    expect(second).not.toHaveBeenCalled();
  });

  it("stops on a mid-stream abort because quota may already be spent", async () => {
    const second = vi.fn();
    await expect(
      runWithFallback(
        ["codex-http", "codex-exec"],
        runners({
          "codex-http": vi.fn().mockRejectedValue(new StreamAborted("stalled")),
          "codex-exec": second,
        }),
        silentLogger,
      ),
    ).rejects.toBeInstanceOf(StreamAborted);
    expect(second).not.toHaveBeenCalled();
  });

  it("stops when submission is uncertain, because quota may already be spent", async () => {
    const second = vi.fn();
    await expect(
      runWithFallback(
        ["codex-http", "codex-exec"],
        runners({
          "codex-http": vi.fn().mockRejectedValue(new SubmissionUncertain("socket hang up")),
          "codex-exec": second,
        }),
        silentLogger,
      ),
    ).rejects.toBeInstanceOf(SubmissionUncertain);
    expect(second).not.toHaveBeenCalled();
  });

  it("advances past a model-availability rejection", async () => {
    const result = await runWithFallback(
      ["codex-http", "codex-exec"],
      runners({
        "codex-http": vi.fn().mockRejectedValue(new ModelUnavailable("unknown model", "gpt-5.1")),
        "codex-exec": ok,
      }),
      silentLogger,
    );
    expect(result.backend).toBe("codex-exec");
  });

  it("throws the last error when every backend fails, keeping the earlier one on cause", async () => {
    const error = await runWithFallback(
      ["codex-http", "codex-exec"],
      runners({
        "codex-http": vi.fn().mockRejectedValue(new BackendUnavailable("primary down")),
        "codex-exec": vi.fn().mockRejectedValue(new BackendUnavailable("secondary down")),
      }),
      silentLogger,
    ).catch((err: unknown) => err as Error);
    expect(error.message).toContain("secondary down");
    expect((error.cause as Error).message).toContain("primary down");
  });

  it("reports the uncertain exec failure, not the pre-submit HTTP one", async () => {
    // The regression this exists for: reporting the FIRST error hands the model
    // recovery loop a not-submitted verdict that exec has already disproved.
    const error = await runWithFallback(
      ["codex-http", "codex-exec"],
      runners({
        "codex-http": vi.fn().mockRejectedValue(new ModelUnavailable("unknown model", "gpt-5.1")),
        "codex-exec": vi.fn().mockRejectedValue(new SubmissionUncertain("codex exec exited with code 1")),
      }),
      silentLogger,
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SubmissionUncertain);
    expect(error).not.toBeInstanceOf(ModelUnavailable);
  });

  it("never runs exec twice when model recovery wraps the whole chain", async () => {
    // End-to-end shape of the double-spend bug, with the real nesting:
    // callWithModelRecovery(runWithFallback(http, exec)).
    const exec = vi
      .fn()
      .mockRejectedValue(new SubmissionUncertain("codex exec exited with code 1"));
    const http = vi.fn().mockRejectedValue(new ModelUnavailable("unknown model", "gpt-5.1"));

    const provider = () =>
      runWithFallback(
        ["codex-http", "codex-exec"],
        runners({ "codex-http": http, "codex-exec": exec }),
        silentLogger,
      );

    await expect(
      callWithModelRecovery(
        { prompt: "a fox" },
        { slug: "gpt-5.1", candidates: [{ slug: "gpt-5.1" }, { slug: "gpt-5" }] } as never,
        provider as never,
        silentLogger,
        createDeadline(1_000),
      ),
    ).rejects.toBeInstanceOf(SubmissionUncertain);

    // The whole point. Two candidate models, but the child spawns once.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("wraps a non-subpixel error rather than falling back blindly", async () => {
    const second = vi.fn();
    await expect(
      runWithFallback(
        ["codex-http", "codex-exec"],
        runners({
          "codex-http": vi.fn().mockRejectedValue(new TypeError("undefined is not a function")),
          "codex-exec": second,
        }),
        silentLogger,
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(second).not.toHaveBeenCalled();
  });

  it("rejects an empty chain", async () => {
    await expect(runWithFallback([], runners({}), silentLogger)).rejects.toBeInstanceOf(ConfigError);
  });
});
