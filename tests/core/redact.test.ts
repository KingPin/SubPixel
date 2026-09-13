import { describe, expect, it } from "vitest";
import { redact } from "../../src/core/redact.js";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

describe("redact", () => {
  it("masks JWTs", () => {
    const out = redact(`token is ${JWT} ok`);
    expect(out).not.toContain(JWT);
    expect(out).toContain("[REDACTED]");
  });

  it("masks sk- keys", () => {
    const out = redact("key=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).toContain("[REDACTED]");
  });

  it("masks Bearer headers", () => {
    const out = redact("Authorization: Bearer abc123def456ghi789jkl");
    expect(out).not.toContain("abc123def456");
    expect(out).toContain("Bearer [REDACTED]");
  });

  it("masks token fields inside JSON text", () => {
    const out = redact('{"access_token":"abc123def456ghi","account_id":"acct_1"}');
    expect(out).not.toContain("abc123def456ghi");
    expect(out).toContain("acct_1");
  });

  it("leaves ordinary text alone", () => {
    expect(redact("generate a red circle")).toBe("generate a red circle");
  });

  it("handles non-string input", () => {
    expect(redact(undefined)).toBe("undefined");
    expect(redact({ a: 1 })).toContain('"a":1');
  });
});
