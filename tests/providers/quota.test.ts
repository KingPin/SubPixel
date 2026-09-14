import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  formatQuota,
  isQuotaStale,
  loadQuota,
  parseRateLimitEvent,
  QUOTA_STALE_MS,
  saveQuota,
  shouldWarn,
  worstWindow,
} from "../../src/providers/quota.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "subpixel-quota-"));
});

const PAYLOAD = {
  type: "response.rate_limits.updated",
  plan_type: "plus",
  resets_at: "2026-09-13T00:00:00Z",
  rate_limits: [
    { used_percent: 12.5, window_minutes: 300 },
    { used_percent: 91.2, window_minutes: 10080 },
  ],
  credits: { has_credits: false, unlimited: false, balance: 0 },
};

describe("parseRateLimitEvent", () => {
  it("extracts the documented fields", () => {
    const event = parseRateLimitEvent(JSON.stringify(PAYLOAD));
    expect(event?.planType).toBe("plus");
    expect(event?.resetsAt).toBe("2026-09-13T00:00:00Z");
    expect(event?.windows).toHaveLength(2);
    expect(event?.windows[1]).toEqual({ usedPercent: 91.2, windowMinutes: 10080 });
    expect(event?.credits).toEqual({ hasCredits: false, unlimited: false, balance: 0 });
  });

  it("returns undefined for an unrelated payload", () => {
    expect(parseRateLimitEvent(JSON.stringify({ type: "response.created" }))).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    expect(parseRateLimitEvent("{{{")).toBeUndefined();
  });

  it("tolerates a payload with no windows", () => {
    const event = parseRateLimitEvent(
      JSON.stringify({ type: "response.rate_limits.updated", plan_type: "pro" }),
    );
    expect(event?.planType).toBe("pro");
    expect(event?.windows).toEqual([]);
  });

  it("tolerates windows with missing numbers", () => {
    const event = parseRateLimitEvent(
      JSON.stringify({ type: "response.rate_limits.updated", rate_limits: [{ foo: 1 }] }),
    );
    expect(event?.windows).toEqual([]);
  });

  it("returns undefined for JSON that is valid but not an object", () => {
    // `JSON.parse("null")` succeeds. A cast to Record would type-check and then
    // throw on the first property read, which is the bug this test pins down.
    for (const text of ["null", "[]", '"text"', "42", "true"]) {
      expect(parseRateLimitEvent(text)).toBeUndefined();
    }
  });

  it("skips non-object entries inside rate_limits", () => {
    const event = parseRateLimitEvent(
      JSON.stringify({
        type: "response.rate_limits.updated",
        rate_limits: [null, "nope", 7, [], { used_percent: 5, window_minutes: 60 }],
      }),
    );
    expect(event?.windows).toEqual([{ usedPercent: 5, windowMinutes: 60 }]);
  });

  it("drops non-finite percentages", () => {
    // JSON has no NaN literal, so the endpoint would deliver these as strings or
    // via a nonstandard encoder. Either way they must not win the max comparison.
    const event = parseRateLimitEvent(
      JSON.stringify({
        type: "response.rate_limits.updated",
        rate_limits: [{ used_percent: "99", window_minutes: 60 }],
      }),
    );
    expect(event?.windows).toEqual([]);
  });

  it("ignores a null credits object", () => {
    const event = parseRateLimitEvent(
      JSON.stringify({ type: "response.rate_limits.updated", credits: null }),
    );
    expect(event?.credits).toBeUndefined();
  });
});

describe("worstWindow", () => {
  it("returns the most-consumed window", () => {
    const event = parseRateLimitEvent(JSON.stringify(PAYLOAD))!;
    expect(worstWindow(event)?.usedPercent).toBe(91.2);
  });

  it("returns undefined when there are no windows", () => {
    expect(worstWindow({ windows: [] })).toBeUndefined();
  });

  it("survives a record whose windows field is not an array", () => {
    // This is what a hand-edited or older-shape quota.json looks like.
    expect(worstWindow(undefined)).toBeUndefined();
    expect(worstWindow({ windows: undefined as never })).toBeUndefined();
    expect(worstWindow({ windows: null as never })).toBeUndefined();
  });
});

describe("shouldWarn", () => {
  it("warns at or above 90 percent", () => {
    expect(shouldWarn({ windows: [{ usedPercent: 90, windowMinutes: 60 }] })).toBe(true);
    expect(shouldWarn({ windows: [{ usedPercent: 99.9, windowMinutes: 60 }] })).toBe(true);
  });

  it("stays quiet below 90 percent", () => {
    expect(shouldWarn({ windows: [{ usedPercent: 89.9, windowMinutes: 60 }] })).toBe(false);
  });

  it("stays quiet with no data", () => {
    expect(shouldWarn({ windows: [] })).toBe(false);
  });
});

describe("saveQuota / loadQuota", () => {
  it("round-trips through disk", async () => {
    const event = parseRateLimitEvent(JSON.stringify(PAYLOAD))!;
    const path = join(dir, "quota.json");
    await saveQuota(path, event);
    const loaded = await loadQuota(path);
    expect(loaded?.planType).toBe("plus");
    expect(loaded?.observedAt).toBeTruthy();
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty("windows");
  });

  it("swallows a write failure", async () => {
    const event = parseRateLimitEvent(JSON.stringify(PAYLOAD))!;
    await expect(saveQuota(join(dir, "no", "\0bad", "q.json"), event)).resolves.toBeUndefined();
  });

  it("returns undefined for a missing file", async () => {
    expect(await loadQuota(join(dir, "absent.json"))).toBeUndefined();
  });

  it("normalises a hand-edited file instead of trusting it", async () => {
    const path = join(dir, "hand-edited.json");
    await writeFile(path, JSON.stringify({ windows: "not an array", planType: 7 }), "utf8");
    const loaded = await loadQuota(path);
    expect(loaded?.windows).toEqual([]);
    expect(loaded?.planType).toBeUndefined();
    expect(() => shouldWarn(loaded)).not.toThrow();
  });

  it("returns undefined for a file holding valid non-object JSON", async () => {
    const path = join(dir, "null.json");
    await writeFile(path, "null", "utf8");
    expect(await loadQuota(path)).toBeUndefined();
  });
});

describe("isQuotaStale", () => {
  it("treats a reading with no timestamp as stale", () => {
    expect(isQuotaStale({ windows: [] })).toBe(true);
  });

  it("treats a fresh reading as current", () => {
    const now = Date.now();
    expect(isQuotaStale({ windows: [], observedAt: new Date(now).toISOString() }, now)).toBe(false);
  });

  it("treats an old reading as stale", () => {
    const now = Date.now();
    const old = new Date(now - QUOTA_STALE_MS - 1000).toISOString();
    expect(isQuotaStale({ windows: [], observedAt: old }, now)).toBe(true);
  });
});

describe("formatQuota", () => {
  it("summarises without leaking identifiers", () => {
    const event = parseRateLimitEvent(JSON.stringify(PAYLOAD))!;
    const text = formatQuota(event);
    expect(text).toContain("plus");
    expect(text).toContain("91.2%");
    expect(text).not.toContain("acct_");
  });

  it("reports unknown when there is no data", () => {
    expect(formatQuota(undefined)).toContain("unknown");
  });

  it("marks an old reading as stale", () => {
    const event = parseRateLimitEvent(JSON.stringify(PAYLOAD))!;
    const now = Date.now();
    event.observedAt = new Date(now - QUOTA_STALE_MS - 1000).toISOString();
    expect(formatQuota(event, now)).toContain("(stale)");
  });
});
