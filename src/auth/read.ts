import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthExpired } from "../core/errors.js";

/** Tokens within this many milliseconds of expiry are treated as already expired. */
export const EXPIRY_SKEW_MS = 60_000;

export interface CodexAuth {
  /** Path the credentials were read from, so callers can write back to the same file. */
  path: string;
  accountId?: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  lastRefresh?: string;
}

export function authPath(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string {
  const codexHome = env.CODEX_HOME;
  if (codexHome) return join(codexHome, "auth.json");
  const home = env.HOME ?? homedir();
  return join(home, ".codex", "auth.json");
}

/**
 * Read and validate the Codex credential file.
 *
 * Every throw path is AuthExpired, because the caller's recovery is the same in
 * all cases: tell the user to run `codex login`. Messages name the path, never a
 * token value.
 */
export async function readAuth(path: string = authPath()): Promise<CodexAuth> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AuthExpired(
        `No Codex credentials at ${path}. Run \`codex login\` first.`,
      );
    }
    throw new AuthExpired(`Cannot read ${path}: ${(err as Error).name}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthExpired(`${path} is not valid JSON. Run \`codex login\` to rewrite it.`);
  }

  const record = parsed as {
    auth_mode?: string;
    last_refresh?: string;
    tokens?: {
      id_token?: string;
      access_token?: string;
      refresh_token?: string;
      account_id?: string;
    };
  };

  if (record.auth_mode !== "chatgpt") {
    throw new AuthExpired(
      `${path} has auth_mode "${record.auth_mode ?? "unset"}". subpixel needs a ChatGPT ` +
        "subscription login. Run `codex login` and choose the ChatGPT option.",
    );
  }

  const tokens = record.tokens ?? {};
  if (!tokens.access_token) {
    throw new AuthExpired(`${path} has no access token. Run \`codex login\`.`);
  }

  return {
    path,
    accountId: tokens.account_id,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    lastRefresh: record.last_refresh,
  };
}

/** Decode a JWT's `exp` claim without verifying the signature. Returns milliseconds. */
export function decodeJwtExp(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const payload = parts[1];
  if (!payload) return undefined;
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const claims = JSON.parse(json) as { exp?: number };
    if (typeof claims.exp !== "number") return undefined;
    return claims.exp * 1000;
  } catch {
    return undefined;
  }
}

/**
 * A token is expired when it is within EXPIRY_SKEW_MS of its exp, or when the exp
 * cannot be read at all. An undecodable token is treated as expired so the caller
 * refreshes rather than sending something the server will reject.
 */
export function isExpired(token: string, now: number = Date.now()): boolean {
  const exp = decodeJwtExp(token);
  if (exp === undefined) return true;
  return exp - now <= EXPIRY_SKEW_MS;
}
