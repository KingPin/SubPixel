import { readFile } from "node:fs/promises";
import { atomicWrite } from "../core/fsx.js";

export interface RateLimitEventWindow {
  usedPercent: number;
  windowMinutes: number;
}

export interface RateLimitEventCredits {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: number;
}

export interface RateLimitEvent {
  planType?: string;
  resetsAt?: string;
  windows: RateLimitEventWindow[];
  credits?: RateLimitEventCredits;
  /** Set when the event is persisted, so a stale reading can be labelled. */
  observedAt?: string;
}

/** Warn the user once a window crosses this share of the subscription allowance. */
export const WARN_THRESHOLD_PERCENT = 90;

/**
 * Narrow an unknown value to an indexable object.
 *
 * `typeof null === "object"` and `JSON.parse("null")` succeeds, so a bare `as
 * Record<string, unknown>` cast is not a guard: it type-checks and then throws at
 * runtime on the first property read. Every parse path below goes through this.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Pull the window list out of any shape without trusting element types. */
function readWindows(value: unknown): RateLimitEventWindow[] {
  if (!Array.isArray(value)) return [];
  const windows: RateLimitEventWindow[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const usedPercent = finiteNumber(entry.used_percent ?? entry.usedPercent);
    const windowMinutes = finiteNumber(entry.window_minutes ?? entry.windowMinutes);
    if (usedPercent === undefined || windowMinutes === undefined) continue;
    windows.push({ usedPercent, windowMinutes });
  }
  return windows;
}

/**
 * Parse a rate-limit SSE payload.
 *
 * Every failure path returns undefined. This telemetry is a convenience; the
 * endpoint is undocumented and may reshape it at any time, and a reshape must not
 * cost the user a generation.
 */
export function parseRateLimitEvent(data: string): RateLimitEvent | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return undefined;
  }
  // `null`, `[…]`, `"text"` and `42` all parse cleanly and none of them is an event.
  if (!isRecord(payload)) return undefined;

  if (typeof payload.type !== "string" || !payload.type.includes("rate_limits")) {
    return undefined;
  }

  const windows = readWindows(payload.rate_limits);

  const rawCredits = payload.credits;
  const credits: RateLimitEventCredits | undefined = isRecord(rawCredits)
    ? {
        hasCredits: typeof rawCredits.has_credits === "boolean" ? rawCredits.has_credits : undefined,
        unlimited: typeof rawCredits.unlimited === "boolean" ? rawCredits.unlimited : undefined,
        balance: finiteNumber(rawCredits.balance),
      }
    : undefined;

  return {
    planType: typeof payload.plan_type === "string" ? payload.plan_type : undefined,
    resetsAt: typeof payload.resets_at === "string" ? payload.resets_at : undefined,
    windows,
    credits,
  };
}

export function worstWindow(
  event: Pick<RateLimitEvent, "windows"> | undefined,
): RateLimitEventWindow | undefined {
  // Callers include `loadQuota`, whose input is a file a previous version — or a
  // person — may have written. Never assume `windows` is an array.
  if (!event || !Array.isArray(event.windows)) return undefined;
  let worst: RateLimitEventWindow | undefined;
  for (const window of event.windows) {
    if (!isRecord(window)) continue;
    const usedPercent = finiteNumber(window.usedPercent);
    if (usedPercent === undefined) continue;
    if (!worst || usedPercent > worst.usedPercent) worst = window as unknown as RateLimitEventWindow;
  }
  return worst;
}

export function shouldWarn(event: Pick<RateLimitEvent, "windows"> | undefined): boolean {
  const worst = worstWindow(event);
  return worst !== undefined && worst.usedPercent >= WARN_THRESHOLD_PERCENT;
}

/** Persist the last reading. Failures are swallowed by design. */
export async function saveQuota(path: string, event: RateLimitEvent): Promise<void> {
  try {
    const record: RateLimitEvent = { ...event, observedAt: new Date().toISOString() };
    await atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // Telemetry must never break a generation.
  }
}

/**
 * Read the last persisted reading.
 *
 * The file is normalised on the way in, not cast. It can be hand-edited, written
 * by an older build with a different shape, or truncated by a crash mid-write, and
 * a bad file must degrade to "unknown" rather than throw inside `spx doctor`.
 */
export async function loadQuota(path: string): Promise<RateLimitEvent | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;

  const rawCredits = raw.credits;
  return {
    planType: typeof raw.planType === "string" ? raw.planType : undefined,
    resetsAt: typeof raw.resetsAt === "string" ? raw.resetsAt : undefined,
    windows: readWindows(raw.windows),
    credits: isRecord(rawCredits)
      ? {
          hasCredits: typeof rawCredits.hasCredits === "boolean" ? rawCredits.hasCredits : undefined,
          unlimited: typeof rawCredits.unlimited === "boolean" ? rawCredits.unlimited : undefined,
          balance: finiteNumber(rawCredits.balance),
        }
      : undefined,
    observedAt: typeof raw.observedAt === "string" ? raw.observedAt : undefined,
  };
}

/** How old a persisted reading may be before it is labelled stale. */
export const QUOTA_STALE_MS = 6 * 60 * 60 * 1000;

export function isQuotaStale(event: RateLimitEvent | undefined, now = Date.now()): boolean {
  if (!event?.observedAt) return true;
  const observed = Date.parse(event.observedAt);
  return !Number.isFinite(observed) || now - observed > QUOTA_STALE_MS;
}

export function formatQuota(event: RateLimitEvent | undefined, now = Date.now()): string {
  if (!event) return "Quota: unknown (no rate-limit event seen yet).";
  const worst = worstWindow(event);
  const plan = event.planType ?? "unknown plan";
  // A reading is a snapshot from the last generation, not a live query. Say so,
  // or `spx doctor` reads as an authoritative current balance.
  const age = isQuotaStale(event, now) ? " (stale)" : "";
  if (!worst) return `Quota: ${plan}, no window data${age}.`;
  const hours = Math.round(worst.windowMinutes / 60);
  const resets = event.resetsAt ? `, resets ${event.resetsAt}` : "";
  return `Quota: ${plan}, ${worst.usedPercent}% of the ${hours}h window used${resets}${age}.`;
}
