import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/core/logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logger", () => {
  it("writes to stderr, never stdout", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    createLogger({ level: "info" }).info("hello");
    expect(err).toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
  });

  it("redacts every message", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    createLogger({ level: "info" }).info("Authorization: Bearer abc123def456ghi789");
    const written = err.mock.calls.map((c) => String(c[0])).join("");
    expect(written).not.toContain("abc123def456");
  });

  it("suppresses messages below the configured level", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const log = createLogger({ level: "warn" });
    log.debug("quiet");
    log.info("quiet");
    expect(err).not.toHaveBeenCalled();
    log.warn("loud");
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("silences everything at level silent", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const log = createLogger({ level: "silent" });
    log.error("boom");
    expect(err).not.toHaveBeenCalled();
  });
});
