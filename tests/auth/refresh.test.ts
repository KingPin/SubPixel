import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthExpired, SubmissionUncertain } from "../../src/core/errors.js";
import { createDeadline } from "../../src/core/deadline.js";
import { ensureFreshAuth, refreshAuth } from "../../src/auth/refresh.js";

let home: string;
let authFile: string;

function makeJwt(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ exp: expSeconds })}.sig`;
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

async function seed(accessExp: number): Promise<void> {
  await writeFile(
    authFile,
    JSON.stringify({
      OPENAI_API_KEY: null,
      auth_mode: "chatgpt",
      some_future_field: { keep: "me" },
      tokens: {
        id_token: makeJwt(FUTURE),
        access_token: makeJwt(accessExp),
        refresh_token: "rt_original",
        account_id: "acct_123",
      },
      last_refresh: "2026-01-01T00:00:00Z",
    }),
    { mode: 0o600 },
  );
}

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      id_token: makeJwt(FUTURE),
      access_token: makeJwt(FUTURE),
      refresh_token: "rt_rotated",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "subpixel-refresh-"));
  authFile = join(home, "auth.json");
  vi.restoreAllMocks();
});

describe("refreshAuth", () => {
  it("posts the documented OAuth payload", async () => {
    await seed(PAST);
    const fetchMock = vi.fn(async () => okResponse());
    await refreshAuth(authFile, { fetch: fetchMock as unknown as typeof fetch });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body.grant_type).toBe("refresh_token");
    expect(body.client_id).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(body.scope).toBe("openid profile email");
    expect(body.refresh_token).toBe("rt_original");
  });

  it("persists rotated tokens and preserves unknown fields", async () => {
    await seed(PAST);
    await refreshAuth(authFile, { fetch: (async () => okResponse()) as unknown as typeof fetch });

    const written = JSON.parse(await readFile(authFile, "utf8")) as Record<string, any>;
    expect(written.tokens.refresh_token).toBe("rt_rotated");
    expect(written.some_future_field).toEqual({ keep: "me" });
    expect(written.auth_mode).toBe("chatgpt");
    expect(written.tokens.account_id).toBe("acct_123");
    expect(typeof written.last_refresh).toBe("string");
    expect(written.last_refresh).not.toBe("2026-01-01T00:00:00Z");
  });

  it("keeps the file at mode 0600", async () => {
    await seed(PAST);
    await refreshAuth(authFile, { fetch: (async () => okResponse()) as unknown as typeof fetch });
    expect((await stat(authFile)).mode & 0o777).toBe(0o600);
  });

  it("keeps the old refresh token when the server does not rotate it", async () => {
    await seed(PAST);
    const noRotate = async () =>
      new Response(JSON.stringify({ access_token: makeJwt(FUTURE), id_token: makeJwt(FUTURE) }), {
        status: 200,
      });
    await refreshAuth(authFile, { fetch: noRotate as unknown as typeof fetch });
    const written = JSON.parse(await readFile(authFile, "utf8")) as Record<string, any>;
    expect(written.tokens.refresh_token).toBe("rt_original");
  });

  it("throws AuthExpired on 400", async () => {
    await seed(PAST);
    const bad = async () => new Response("invalid_grant", { status: 400 });
    await expect(
      refreshAuth(authFile, { fetch: bad as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(AuthExpired);
  });

  it("throws SubmissionUncertain on 503, so it never falls back", async () => {
    // A 5xx from any endpoint is ambiguous by the taxonomy's rule, and the class
    // that carries that meaning is SubmissionUncertain. It deliberately does NOT
    // extend BackendUnavailable, because that family is fallback-eligible.
    await seed(PAST);
    const down = async () => new Response("nope", { status: 503 });
    const err = await refreshAuth(authFile, {
      fetch: down as unknown as typeof fetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmissionUncertain);
    expect((err as SubmissionUncertain).canFallback).toBe(false);
  });

  it("throws AuthExpired when there is no refresh token", async () => {
    await writeFile(
      authFile,
      JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: makeJwt(PAST) } }),
    );
    await expect(
      refreshAuth(authFile, { fetch: (async () => okResponse()) as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(AuthExpired);
  });

  it("never leaks a token in an error message", async () => {
    await seed(PAST);
    const bad = async () => new Response(JSON.stringify({ error: "bad", token: "rt_original" }), { status: 400 });
    const err = await refreshAuth(authFile, {
      fetch: bad as unknown as typeof fetch,
    }).catch((e: Error) => e);
    expect(String(err)).not.toContain("rt_original");
  });

  it("abandons the write when Codex rotates the file during the exchange", async () => {
    await seed(PAST);
    // Codex does not honour our lock. Rotate the file while fetch is pending.
    const racing = async () => {
      const record = JSON.parse(await readFile(authFile, "utf8")) as Record<string, any>;
      record.tokens.refresh_token = "rt_from_codex";
      record.tokens.access_token = makeJwt(FUTURE);
      await writeFile(authFile, JSON.stringify(record), { mode: 0o600 });
      return okResponse();
    };

    const auth = await refreshAuth(authFile, { fetch: racing as unknown as typeof fetch });

    // Their file survives untouched.
    const written = JSON.parse(await readFile(authFile, "utf8")) as Record<string, any>;
    expect(written.tokens.refresh_token).toBe("rt_from_codex");
    expect(written.last_refresh).toBe("2026-01-01T00:00:00Z");
    // Our run still has a working token.
    expect(auth.accessToken).toBeTruthy();
    expect(auth.refreshToken).toBe("rt_rotated");
  });

  it("never pairs our access token with a switched account's id", async () => {
    await seed(PAST);
    // `codex login` as a different account lands while our exchange is in flight.
    const switching = async () => {
      const record = JSON.parse(await readFile(authFile, "utf8")) as Record<string, any>;
      record.tokens.account_id = "acct_999";
      await writeFile(authFile, JSON.stringify(record), { mode: 0o600 });
      return okResponse();
    };

    const auth = await refreshAuth(authFile, { fetch: switching as unknown as typeof fetch });

    // The token we hold belongs to acct_123. Labelling it acct_999 would attribute
    // this run's spend, and its quota telemetry, to the wrong account.
    expect(auth.accountId).toBe("acct_123");
    // And a file that now describes another identity is not ours to rewrite.
    const written = JSON.parse(await readFile(authFile, "utf8")) as Record<string, any>;
    expect(written.tokens.account_id).toBe("acct_999");
    expect(written.tokens.refresh_token).toBe("rt_original");
    expect(written.last_refresh).toBe("2026-01-01T00:00:00Z");
  });

  it("does not resurrect credentials deleted during the exchange", async () => {
    await seed(PAST);
    // `codex logout` while the POST is pending.
    const loggingOut = async () => {
      const { rm } = await import("node:fs/promises");
      await rm(authFile, { force: true });
      return okResponse();
    };

    const auth = await refreshAuth(authFile, { fetch: loggingOut as unknown as typeof fetch });

    // The run keeps a working token in memory...
    expect(auth.accessToken).toBeTruthy();
    expect(auth.accountId).toBe("acct_123");
    // ...and the user stays logged out.
    await expect(stat(authFile)).rejects.toThrow();
  });

  it("keeps an unrelated field written during the exchange", async () => {
    await seed(PAST);
    const racing = async () => {
      const record = JSON.parse(await readFile(authFile, "utf8")) as Record<string, any>;
      record.some_future_field = { keep: "newer" };
      await writeFile(authFile, JSON.stringify(record), { mode: 0o600 });
      return okResponse();
    };

    await refreshAuth(authFile, { fetch: racing as unknown as typeof fetch });

    const written = JSON.parse(await readFile(authFile, "utf8")) as Record<string, any>;
    // Credentials were untouched by the racer, so our rotation lands...
    expect(written.tokens.refresh_token).toBe("rt_rotated");
    // ...without reverting their unrelated edit.
    expect(written.some_future_field).toEqual({ keep: "newer" });
  });

  it("does not wait the full lock timeout when the deadline is already spent", async () => {
    await seed(PAST);
    const lockPath = `${authFile}.lock`;
    await writeFile(lockPath, JSON.stringify({ id: "other", pid: process.pid, host: "h", startedAt: new Date().toISOString() }));

    const started = Date.now();
    await expect(
      refreshAuth(authFile, {
        fetch: (async () => okResponse()) as unknown as typeof fetch,
        deadline: createDeadline(30),
      }),
    ).rejects.toThrow(/Timed out waiting for lock/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("makes exactly one network request when two callers race an expired token", async () => {
    await seed(PAST);
    let calls = 0;
    const counting = async () => {
      calls += 1;
      return okResponse();
    };
    const both = await Promise.all([
      refreshAuth(authFile, { fetch: counting as unknown as typeof fetch }),
      refreshAuth(authFile, { fetch: counting as unknown as typeof fetch }),
    ]);
    // The second caller queued on the lock, re-read the file, and found the fresh
    // token the first one wrote. Rotating twice would invalidate the first token.
    expect(calls).toBe(1);
    expect(both[0]!.accessToken).toBe(both[1]!.accessToken);
  });
});

describe("ensureFreshAuth", () => {
  it("does not call the network when the token is still valid", async () => {
    await seed(FUTURE);
    const fetchMock = vi.fn(async () => okResponse());
    const auth = await ensureFreshAuth(authFile, { fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.accountId).toBe("acct_123");
  });

  it("refreshes exactly once when the token is expired", async () => {
    await seed(PAST);
    const fetchMock = vi.fn(async () => okResponse());
    const auth = await ensureFreshAuth(authFile, { fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auth.refreshToken).toBe("rt_rotated");
  });
});
