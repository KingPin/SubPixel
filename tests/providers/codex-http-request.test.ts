import { describe, expect, it } from "vitest";
import { redact } from "../../src/core/redact.js";
import {
  CODEX_RESPONSES_URL,
  buildBody,
  buildHeaders,
} from "../../src/providers/codex-http-request.js";

const AUTH = {
  path: "/tmp/auth.json",
  accessToken: "tok_abcdefghijklmnop",
  accountId: "acct_123",
};

describe("buildHeaders", () => {
  it("targets the documented endpoint", () => {
    expect(CODEX_RESPONSES_URL).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("sets the header set Codex sends", () => {
    const headers = buildHeaders(AUTH, "session-1");
    expect(headers.authorization).toBe("Bearer tok_abcdefghijklmnop");
    expect(headers["chatgpt-account-id"]).toBe("acct_123");
    expect(headers["openai-beta"]).toBe("responses=experimental");
    expect(headers.accept).toBe("text/event-stream");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers.session_id).toBe("session-1");
    expect(headers["user-agent"]).toContain("codex_cli_rs");
  });

  it("omits the account header when the id is unknown", () => {
    const headers = buildHeaders({ ...AUTH, accountId: undefined }, "s");
    expect("chatgpt-account-id" in headers).toBe(false);
  });

  it("is safe to log once redacted", () => {
    expect(redact(JSON.stringify(buildHeaders(AUTH, "s")))).not.toContain("tok_abcdefghijklmnop");
  });
});

describe("buildBody", () => {
  it("builds a streaming, non-storing request", () => {
    const body = buildBody({ prompt: "a fox" }, "gpt-5.6-sol", "a fox augmented");
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.include).toEqual([]);
    expect(body.parallel_tool_calls).toBe(false);
  });

  it("carries the augmented prompt, not the raw one", () => {
    const body = buildBody({ prompt: "raw" }, "m", "augmented text");
    const text = JSON.stringify(body.input);
    expect(text).toContain("augmented text");
    expect(text).not.toContain('"raw"');
  });

  it("declares the image_generation tool", () => {
    const body = buildBody({ prompt: "x", size: "1024x1536" }, "m", "x");
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]!.type).toBe("image_generation");
    expect(body.tools[0]!.size).toBe("1024x1536");
  });

  it("forces the tool call rather than leaving it optional", () => {
    const body = buildBody({ prompt: "x" }, "m", "x");
    expect(body.tool_choice).toEqual({ type: "image_generation" });
  });

  it("pins low reasoning effort instead of inheriting the model's default", () => {
    // Half the listed catalogue defaults to `medium`. Leaving this out makes the
    // cost of a generation depend on which slug the Codex cache ranks first.
    for (const model of ["gpt-6-astra", "gpt-5.6-terra"]) {
      expect(buildBody({ prompt: "x" }, model, "x").reasoning).toEqual({ effort: "low" });
    }
  });

  it("attaches reference images as input_image parts, encoded, never as a path", () => {
    const body = buildBody(
      {
        prompt: "edit this",
        resolvedReferences: [
          {
            path: "/tmp/logo.png",
            format: "png",
            bytes: 4,
            sha256: "a".repeat(64),
            dataUrl: "data:image/png;base64,AAAA",
          },
        ],
      },
      "gpt-5",
      "edit this",
    );
    const parts = (body.input[0] as { content: Array<Record<string, string>> }).content;
    expect(parts[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,AAAA" });
    expect(parts.some((p) => p.type === "input_text")).toBe(true);
    // The assertion that matters: it fails the day someone reintroduces a bare
    // filesystem path into a body the backend has no way to open.
    expect(JSON.stringify(body)).not.toContain("/tmp/logo.png");
  });

  it("sends no image parts for a plain generation", () => {
    const body = buildBody({ prompt: "x" }, "m", "x");
    const parts = (body.input[0] as { content: Array<Record<string, string>> }).content;
    expect(parts.every((p) => p.type === "input_text")).toBe(true);
  });
});
