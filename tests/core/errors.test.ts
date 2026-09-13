import { describe, expect, it } from "vitest";
import {
  AuthExpired,
  BackendUnavailable,
  ConfigError,
  ContentBlocked,
  ModelRejected,
  ModelUnavailable,
  RateLimited,
  StreamAborted,
  SubmissionUncertain,
  SubpixelError,
  classifyFetchError,
  classifyHttpStatus,
} from "../../src/core/errors.js";

describe("error taxonomy", () => {
  it("permits fallback only for failures that provably predate submission", () => {
    expect(new AuthExpired("expired").canFallback).toBe(true);
    expect(new BackendUnavailable("no route").canFallback).toBe(true);
    expect(new ModelUnavailable("no such model").canFallback).toBe(true);
    expect(new RateLimited("429").canFallback).toBe(false);
    expect(new SubmissionUncertain("socket hang up").canFallback).toBe(false);
    expect(new ContentBlocked("refused").canFallback).toBe(false);
    expect(new ModelRejected("bad request").canFallback).toBe(false);
    expect(new StreamAborted("stalled").canFallback).toBe(false);
    expect(new ConfigError("bad flag").canFallback).toBe(false);
  });

  it("records submission certainty explicitly", () => {
    expect(new BackendUnavailable("x").submission).toBe("not-submitted");
    expect(new SubmissionUncertain("x").submission).toBe("uncertain");
    expect(new ModelRejected("x").submission).toBe("uncertain");
    expect(new ContentBlocked("x").submission).toBe("submitted");
    expect(new StreamAborted("x").submission).toBe("submitted");
  });

  it("keeps RateLimited in the BackendUnavailable family without inheriting fallback", () => {
    const err = new RateLimited("429");
    expect(err).toBeInstanceOf(BackendUnavailable);
    expect(err.canFallback).toBe(false);
  });

  it("exposes a stable code on every class", () => {
    expect(new AuthExpired("x").code).toBe("AUTH_EXPIRED");
    expect(new RateLimited("x").code).toBe("RATE_LIMITED");
    expect(new ContentBlocked("x").code).toBe("CONTENT_BLOCKED");
    expect(new ModelRejected("x").code).toBe("MODEL_REJECTED");
    expect(new ModelUnavailable("x").code).toBe("MODEL_UNAVAILABLE");
    expect(new StreamAborted("x").code).toBe("STREAM_ABORTED");
    expect(new BackendUnavailable("x").code).toBe("BACKEND_UNAVAILABLE");
    expect(new SubmissionUncertain("x").code).toBe("SUBMISSION_UNCERTAIN");
  });

  it("classifies HTTP statuses", () => {
    expect(classifyHttpStatus(401, "nope")).toBeInstanceOf(AuthExpired);
    expect(classifyHttpStatus(403, "nope")).toBeInstanceOf(AuthExpired);
    expect(classifyHttpStatus(429, "slow down")).toBeInstanceOf(RateLimited);
    expect(classifyHttpStatus(404, "no route")).toBeInstanceOf(BackendUnavailable);
  });

  it("treats every 5xx as ambiguous, because a gateway can fail after upstream accepted", () => {
    for (const status of [500, 502, 503, 504]) {
      const err = classifyHttpStatus(status, "boom");
      expect(err).toBeInstanceOf(SubmissionUncertain);
      expect(err.canFallback).toBe(false);
    }
  });

  it("separates a model-availability 400 from every other 400", () => {
    const unavailable = classifyHttpStatus(
      400,
      `{"error":{"code":"model_not_found","message":"The model 'gpt-9' does not exist"}}`,
      undefined,
      { model: "gpt-9" },
    );
    expect(unavailable).toBeInstanceOf(ModelUnavailable);
    expect((unavailable as ModelUnavailable).canFallback).toBe(true);

    const other = classifyHttpStatus(400, `{"error":{"message":"image too large"}}`);
    expect(other).toBeInstanceOf(ModelRejected);
    expect(other).not.toBeInstanceOf(ModelUnavailable);
    expect(other.canFallback).toBe(false);
  });

  it("treats an unsupported PARAMETER as a rejection, not an unavailable model", () => {
    // The message names the model and says "does not support". An earlier pattern
    // set matched it and walked the whole candidate list, spending quota each time,
    // to be told the same thing about a request that was malformed from the start.
    for (const body of [
      "This model does not support the requested image size.",
      `{"error":{"message":"model gpt-image-1 does not support parameter 'quality'"}}`,
      `{"error":{"message":"The requested size is not supported by this model"}}`,
      `{"error":{"message":"Unsupported value for model: background"}}`,
    ]) {
      const err = classifyHttpStatus(400, body, undefined, { model: "gpt-image-1" });
      expect(err, body).toBeInstanceOf(ModelRejected);
      expect(err, body).not.toBeInstanceOf(ModelUnavailable);
      expect(err.canFallback, body).toBe(false);
    }
  });

  it("still recognises genuine existence and entitlement rejections", () => {
    for (const body of [
      `{"error":{"code":"model_not_found","message":"The model 'gpt-9' does not exist"}}`,
      "unknown model: gpt-9",
      "The model `gpt-9` does not exist",
      "Your account does not have access to the model gpt-9",
      "model gpt-9 is not enabled for this organisation",
    ]) {
      expect(classifyHttpStatus(400, body, undefined, { model: "gpt-9" }), body).toBeInstanceOf(
        ModelUnavailable,
      );
    }
  });

  it("refuses to recover when the rejection is not about the model we sent", () => {
    // Every one of these carries the SHAPE of an availability rejection. None of
    // them establishes that the driver model we sent is its subject, and advancing
    // the candidate list on a tool-config failure spends quota on every candidate
    // to be refused identically each time.
    for (const [body, model] of [
      // A longer model name that merely starts with our slug. This is the image
      // tool's model, not the driver, and `includes()` could not tell them apart.
      ["Image model driver-a-image is not available", "driver-a"],
      // Our slug appears, but the verdict belongs to the other model.
      ["Generation for driver-a failed: the image model gpt-image-2 is not available", "driver-a"],
      [`{"model":"driver-a","error":{"message":"image model gpt-image-2 is not available"}}`, "driver-a"],
      // No subject at all: a bare code cannot say which of the two models it means.
      [`{"error":{"code":"model_not_found"}}`, "driver-a"],
      // No model was recorded for the request, so nothing can be verified.
      ["unknown model: driver-a", undefined],
    ] as Array<[string, string | undefined]>) {
      const err = classifyHttpStatus(400, body, undefined, { model });
      expect(err, body).toBeInstanceOf(ModelRejected);
      expect(err, body).not.toBeInstanceOf(ModelUnavailable);
      expect(err.canFallback, body).toBe(false);
    }
  });

  it("carries the rejected slug on ModelUnavailable so recovery can advance past it", () => {
    const err = classifyHttpStatus(400, "unknown model: gpt-5.6-luna", undefined, {
      model: "gpt-5.6-luna",
    });
    expect(err).toBeInstanceOf(ModelUnavailable);
    expect((err as ModelUnavailable).model).toBe("gpt-5.6-luna");
  });

  it("only calls a fetch failure pre-submit when the error code proves it", () => {
    const dns = classifyFetchError(Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }));
    expect(dns).toBeInstanceOf(BackendUnavailable);
    expect(dns.canFallback).toBe(true);

    const refused = classifyFetchError(
      Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
    );
    expect(refused).toBeInstanceOf(BackendUnavailable);

    // The server may already have the POST body when the socket dies.
    for (const code of ["ECONNRESET", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET"]) {
      const err = classifyFetchError(Object.assign(new Error("socket"), { code }));
      expect(err).toBeInstanceOf(SubmissionUncertain);
      expect(err.canFallback).toBe(false);
    }

    // An unrecognised failure is ambiguous by default, never fallback-eligible.
    expect(classifyFetchError(new Error("something new"))).toBeInstanceOf(SubmissionUncertain);
  });

  it("reads the cause chain, because fetch wraps the real code", () => {
    const wrapped = new TypeError("fetch failed");
    (wrapped as Error & { cause?: unknown }).cause = Object.assign(new Error("dns"), {
      code: "EAI_AGAIN",
    });
    expect(classifyFetchError(wrapped)).toBeInstanceOf(BackendUnavailable);
  });

  it("accepts either a message string or a url context", () => {
    // Two call shapes exist because the auth refresher already has a full
    // sentence to report while the provider only knows the endpoint.
    expect(classifyFetchError(new Error("x"), "refresh could not reach the host").message).toBe(
      "refresh could not reach the host",
    );
    expect(classifyFetchError(new Error("socket hang up"), { url: "https://e/x" }).message).toBe(
      "The request to https://e/x failed: socket hang up",
    );
  });

  it("is an instance of SubpixelError", () => {
    expect(new RateLimited("x")).toBeInstanceOf(SubpixelError);
    expect(new SubmissionUncertain("x")).toBeInstanceOf(SubpixelError);
  });
});
