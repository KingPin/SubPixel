import { describe, expect, it } from "vitest";
import { AuthExpired, ConfigError, DriftDetected } from "../../src/core/errors.js";
import { exitCodeFor, messageFor } from "../../src/cli/exit.js";

describe("exitCodeFor", () => {
  it("reads the code off a SubpixelError", () => {
    expect(exitCodeFor(new ConfigError("bad flag"))).toBe(2);
    expect(exitCodeFor(new AuthExpired("expired"))).toBe(3);
    expect(exitCodeFor(new DriftDetected("drift"))).toBe(6);
  });

  it("uses 1 for an ordinary Error", () => {
    expect(exitCodeFor(new Error("boom"))).toBe(1);
  });

  it("uses 1 for a thrown non-Error", () => {
    expect(exitCodeFor("boom")).toBe(1);
    expect(exitCodeFor(undefined)).toBe(1);
    expect(exitCodeFor({ exitCode: 99 })).toBe(1);
  });
});

describe("messageFor", () => {
  it("uses the error message", () => {
    expect(messageFor(new ConfigError("bad flag"))).toBe("bad flag");
  });

  it("stringifies a non-Error", () => {
    expect(messageFor("boom")).toBe("boom");
  });

  it("redacts credentials that reached the message", () => {
    expect(messageFor(new Error("Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature"))).not.toContain(
      "eyJhbGciOiJIUzI1NiJ9",
    );
  });
});
