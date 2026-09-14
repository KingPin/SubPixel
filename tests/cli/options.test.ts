import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/errors.js";
import {
  KNOWN_COMMANDS,
  normalizeArgv,
  parseBackend,
  parseSeconds,
} from "../../src/cli/options.js";

describe("normalizeArgv", () => {
  it("inserts generate before a bare prompt", () => {
    expect(normalizeArgv(["node", "spx", "a red fox"])).toEqual([
      "node",
      "spx",
      "generate",
      "a red fox",
    ]);
  });

  it("leaves an explicit subcommand alone", () => {
    for (const command of KNOWN_COMMANDS) {
      const argv = normalizeArgv(["node", "spx", command, "x"]);
      expect(argv[2]).toBe(command);
    }
  });

  it("leaves a flag-first invocation alone", () => {
    expect(normalizeArgv(["node", "spx", "--help"])).toEqual(["node", "spx", "--help"]);
    expect(normalizeArgv(["node", "spx", "-V"])).toEqual(["node", "spx", "-V"]);
  });

  it("leaves an empty invocation alone", () => {
    expect(normalizeArgv(["node", "spx"])).toEqual(["node", "spx"]);
  });

  it("keeps the flags that follow a bare prompt", () => {
    expect(normalizeArgv(["node", "spx", "a fox", "--size", "1024x1024"])).toEqual([
      "node",
      "spx",
      "generate",
      "a fox",
      "--size",
      "1024x1024",
    ]);
  });
});

describe("parseBackend", () => {
  it("maps auto to undefined so the default chain is used", () => {
    expect(parseBackend("auto")).toBeUndefined();
    expect(parseBackend(undefined)).toBeUndefined();
  });

  it("passes a real backend name through", () => {
    expect(parseBackend("codex-http")).toBe("codex-http");
    expect(parseBackend("codex-exec")).toBe("codex-exec");
    expect(parseBackend("api")).toBe("api");
  });

  it("rejects an unknown name and lists the valid ones", () => {
    expect(() => parseBackend("gpt")).toThrow(ConfigError);
    expect(() => parseBackend("gpt")).toThrow(/codex-http/);
  });
});

describe("parseSeconds", () => {
  it("converts seconds to milliseconds", () => {
    expect(parseSeconds("30", "--timeout")).toBe(30_000);
  });

  it("returns undefined for an absent value", () => {
    expect(parseSeconds(undefined, "--timeout")).toBeUndefined();
  });

  it("rejects a non-numeric value and names the flag", () => {
    expect(() => parseSeconds("soon", "--timeout")).toThrow(ConfigError);
    expect(() => parseSeconds("soon", "--timeout")).toThrow(/--timeout/);
  });

  it("rejects zero and negative values", () => {
    expect(() => parseSeconds("0", "--stall-timeout")).toThrow(ConfigError);
    expect(() => parseSeconds("-5", "--stall-timeout")).toThrow(ConfigError);
  });
});
