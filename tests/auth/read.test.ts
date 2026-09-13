import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthExpired } from "../../src/core/errors.js";
import { authPath, decodeJwtExp, isExpired, readAuth } from "../../src/auth/read.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "subpixel-auth-"));
});

/** Build a JWT with the given exp (seconds). The signature is not verified anywhere. */
function makeJwt(expSeconds: number): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ exp: expSeconds })}.sig`;
}

async function writeAuth(contents: unknown): Promise<string> {
  const path = join(home, "auth.json");
  await writeFile(path, JSON.stringify(contents));
  return path;
}

describe("authPath", () => {
  it("prefers CODEX_HOME", () => {
    expect(authPath({ CODEX_HOME: "/custom", HOME: "/h" })).toBe("/custom/auth.json");
  });

  it("falls back to ~/.codex", () => {
    expect(authPath({ HOME: "/h" })).toBe("/h/.codex/auth.json");
  });
});

describe("readAuth", () => {
  it("parses a chatgpt auth file", async () => {
    const path = await writeAuth({
      OPENAI_API_KEY: null,
      auth_mode: "chatgpt",
      tokens: {
        id_token: makeJwt(2_000_000_000),
        access_token: makeJwt(2_000_000_000),
        refresh_token: "rt_abc",
        account_id: "acct_123",
      },
      last_refresh: "2026-09-12T00:00:00Z",
    });
    const auth = await readAuth(path);
    expect(auth.accountId).toBe("acct_123");
    expect(auth.refreshToken).toBe("rt_abc");
    expect(auth.accessToken).toContain(".");
    expect(auth.lastRefresh).toBe("2026-09-12T00:00:00Z");
  });

  it("throws AuthExpired when the file is missing", async () => {
    await expect(readAuth(join(home, "nope.json"))).rejects.toBeInstanceOf(AuthExpired);
  });

  it("throws AuthExpired on malformed JSON", async () => {
    const path = join(home, "auth.json");
    await writeFile(path, "{not json");
    await expect(readAuth(path)).rejects.toBeInstanceOf(AuthExpired);
  });

  it("rejects a non-chatgpt auth mode", async () => {
    const path = await writeAuth({ auth_mode: "apikey", tokens: {} });
    await expect(readAuth(path)).rejects.toBeInstanceOf(AuthExpired);
  });

  it("rejects a file with no access token", async () => {
    const path = await writeAuth({ auth_mode: "chatgpt", tokens: { account_id: "a" } });
    await expect(readAuth(path)).rejects.toBeInstanceOf(AuthExpired);
  });

  it("never includes token text in the error message", async () => {
    const secret = makeJwt(1);
    const path = await writeAuth({ auth_mode: "apikey", tokens: { access_token: secret } });
    const err = await readAuth(path).catch((e: Error) => e);
    expect(String(err)).not.toContain(secret);
  });
});

describe("decodeJwtExp", () => {
  it("returns exp in milliseconds", () => {
    expect(decodeJwtExp(makeJwt(1_700_000_000))).toBe(1_700_000_000_000);
  });

  it("returns undefined for a non-JWT", () => {
    expect(decodeJwtExp("not-a-jwt")).toBeUndefined();
  });

  it("returns undefined when exp is absent", () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    expect(decodeJwtExp(`${b64({})}.${b64({ sub: "x" })}.sig`)).toBeUndefined();
  });
});

describe("isExpired", () => {
  it("treats a token expiring within the skew as expired", () => {
    expect(isExpired(makeJwt(Math.floor(Date.now() / 1000) + 30))).toBe(true);
  });

  it("treats a comfortably valid token as live", () => {
    expect(isExpired(makeJwt(Math.floor(Date.now() / 1000) + 3600))).toBe(false);
  });

  it("treats an undecodable token as expired", () => {
    expect(isExpired("garbage")).toBe(true);
  });
});
