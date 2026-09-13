import { readFile } from "node:fs/promises";
import { createDeadline, type Deadline } from "../core/deadline.js";
import {
  AuthExpired,
  BackendUnavailable,
  classifyFetchError,
  classifyHttpStatus,
} from "../core/errors.js";
import { atomicWrite, withFileLock } from "../core/fsx.js";
import type { Logger } from "../core/logger.js";
import { redact } from "../core/redact.js";
import { authPath, isExpired, readAuth, type CodexAuth } from "./read.js";

/** The public OAuth client id the Codex CLI uses. Not a secret. */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const SCOPE = "openid profile email";

export interface RefreshOptions {
  fetch?: typeof fetch;
  /** Overrides the lock path. Defaults to `<auth.json>.lock`. */
  lockPath?: string;
  /** Whole-operation budget: connect, headers, AND body. Defaults to 30s. */
  timeoutMs?: number;
  /** Shared deadline from the caller, so queue time is never free time. */
  deadline?: Deadline;
  logger?: Logger;
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

/**
 * Exchange the refresh token for a new access token and write the result back.
 *
 * The entire read-modify-write runs under a lock, and the file is read TWICE: once
 * after the lock is acquired, and once after the token exchange returns.
 *
 * The first read handles the cooperating case. A caller that waited behind another
 * `spx` process must see the token that process just wrote, not the expired one it
 * observed before queueing. Without it, every waiter performs its own redundant
 * rotation and the last writer wins, invalidating everybody else's token.
 *
 * The second read handles the NON-cooperating case, which is the common one. Codex
 * does not honour this lock, so it can rotate the credentials while our exchange is
 * in flight — and the exchange is the longest part of the critical section. The
 * snapshot from the first read is stale by then. Persisting it would silently revoke
 * whatever Codex just wrote. So: compare, and if the file moved, keep our token in
 * memory for this run and leave the file alone.
 *
 * This narrows the window to "between the re-read and the rename". It does not close
 * it. Nothing available here can: there is no atomic compare-and-swap on file content,
 * and the other writer ignores the lock. Do not claim coordination with Codex.
 */
export async function refreshAuth(
  path: string = authPath(),
  options: RefreshOptions = {},
): Promise<CodexAuth> {
  const doFetch = options.fetch ?? fetch;
  const lockPath = options.lockPath ?? `${path}.lock`;
  const deadline = options.deadline ?? createDeadline(options.timeoutMs ?? 30_000);
  const readRecord = async (): Promise<Record<string, unknown>> => {
    const raw = await readFile(path, "utf8").catch(() => {
      throw new AuthExpired(`No Codex credentials at ${path}. Run \`codex login\` first.`);
    });
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new AuthExpired(`${path} is not valid JSON. Run \`codex login\`.`);
    }
  };

  return withFileLock(
    lockPath,
    async (lock) => {
      const record = await readRecord();
      const tokens = (record.tokens ?? {}) as Record<string, unknown>;

      // Re-check under the lock. Someone may have rotated while we queued.
      const current = typeof tokens.access_token === "string" ? tokens.access_token : undefined;
      if (current && !isExpired(current)) {
        options.logger?.debug("Another process refreshed the token while we waited.");
        return toCodexAuth(path, record, tokens, current);
      }

      const refreshToken =
        typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined;
      if (!refreshToken) {
        throw new AuthExpired(
          `${path} has no refresh token, so the session cannot be renewed. Run \`codex login\`.`,
        );
      }

      let response: Response;
      try {
        response = await doFetch(TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_id: CODEX_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            scope: SCOPE,
          }),
          // One signal for the whole exchange. It stays armed through body reads
          // below, so a server that sends headers and then stalls still trips it.
          signal: deadline.signal,
        });
      } catch (err) {
        if (deadline.expired) {
          throw new BackendUnavailable(
            `Token refresh exceeded its ${deadline.totalMs} ms budget.`,
            err,
          );
        }
        // Nothing was generated here, but classify honestly anyway: an auth POST
        // that half-landed is still an auth POST that half-landed.
        throw classifyFetchError(
          err,
          `Token refresh could not reach ${TOKEN_ENDPOINT}: ${redact(err)}`,
        );
      }

      if (!response.ok) {
        const body = redact(await readBodyWithin(response, deadline));
        if (response.status === 400 || response.status === 401) {
          throw new AuthExpired(
            `Token refresh was rejected (HTTP ${response.status}). Run \`codex login\` to sign in again.`,
          );
        }
        throw classifyHttpStatus(response.status, body.slice(0, 200));
      }

      const payload = parseJsonOrEmpty<TokenResponse>(await readBodyWithin(response, deadline));
      if (!payload.access_token) {
        throw new AuthExpired("Token refresh returned no access token. Run `codex login`.");
      }

      // The token we now hold was minted for the account named in the PRE-exchange
      // snapshot. That binding is fixed at the moment of the exchange and nothing
      // read afterwards can change it. Pairing this access token with an account id
      // read later is how you hand account A's token to callers labelled account B.
      const myAccountId = typeof tokens.account_id === "string" ? tokens.account_id : undefined;
      const mine: CodexAuth = {
        path,
        accountId: myAccountId,
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token ?? refreshToken,
        idToken: payload.id_token,
        lastRefresh: undefined,
      };

      // Another `spx` would have queued on the lock; Codex would not. Either way the
      // snapshot from before the exchange is now stale, so throw it away and look again.
      await lock.assertHeld();
      let latest: Record<string, unknown>;
      try {
        latest = await readRecord();
      } catch (err) {
        // The file was deleted, replaced with something unreadable, or the user ran
        // `codex logout` mid-exchange. There is no safe merge target: writing `record`
        // back would resurrect credentials the user just removed. Keep our token for
        // this run, persist nothing.
        options.logger?.warn(
          `${path} became unreadable while the token refresh was in flight (${redact(err)}), ` +
            "so nothing was written back. This run uses the token we obtained.",
        );
        return mine;
      }
      const latestTokens = (latest.tokens ?? {}) as Record<string, unknown>;
      const latestAccountId =
        typeof latestTokens.account_id === "string" ? latestTokens.account_id : undefined;

      if (
        latestAccountId !== myAccountId ||
        latestTokens.refresh_token !== refreshToken ||
        latestTokens.access_token !== current
      ) {
        options.logger?.warn(
          `${path} changed while the token refresh was in flight, so it was left alone. ` +
            "This run uses the token we obtained; the file keeps the newer credentials.",
        );
        return mine;
      }

      const nextTokens: Record<string, unknown> = {
        ...latestTokens,
        access_token: payload.access_token,
        // The server rotates the refresh token only sometimes. Keep the old one otherwise.
        refresh_token: payload.refresh_token ?? refreshToken,
      };
      if (payload.id_token) nextTokens.id_token = payload.id_token;

      // Spread `latest`, not the pre-exchange snapshot: unrelated top-level fields
      // written during the exchange survive.
      const next = {
        ...latest,
        tokens: nextTokens,
        last_refresh: new Date().toISOString(),
      };

      // A persist failure is a warning, not a run failure: we hold a working token
      // in memory, and this file belongs to the user's Codex install.
      try {
        // Last check before the only mutation in this function. It re-reads the lock
        // record, so it is current as of this line, not as of a heartbeat.
        await lock.assertHeld();
        await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      } catch (err) {
        options.logger?.warn(
          `Could not write refreshed credentials to ${path}: ${redact(err)}. ` +
            "This run continues; Codex will refresh again on its own.",
        );
      }

      return {
        path,
        // Still the identity the token was minted for. `nextTokens.account_id` is
        // the same value here — the guard above proved it — but reading it from the
        // snapshot keeps that true by construction rather than by coincidence.
        accountId: myAccountId,
        accessToken: payload.access_token,
        refreshToken: nextTokens.refresh_token as string,
        idToken: typeof nextTokens.id_token === "string" ? nextTokens.id_token : undefined,
        lastRefresh: next.last_refresh,
      };
    },
    {
      // No staleness window to configure: `withFileLock` never breaks a lock on
      // elapsed time, so a refresh waiting on a slow token endpoint cannot be
      // stolen out from under itself. `await lock.assertHeld()` above is what stops
      // a lock lost some other way from writing.
      //
      // Queue time is not free time. Waiting for the lock spends the caller's
      // budget, so a request that is already out of time never reaches the network.
      timeoutMs: Math.min(deadline.remainingMs, (options.timeoutMs ?? 30_000) + 15_000),
    },
  );
}

function toCodexAuth(
  path: string,
  record: Record<string, unknown>,
  tokens: Record<string, unknown>,
  accessToken: string,
): CodexAuth {
  return {
    path,
    accountId: typeof tokens.account_id === "string" ? tokens.account_id : undefined,
    accessToken,
    refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined,
    idToken: typeof tokens.id_token === "string" ? tokens.id_token : undefined,
    lastRefresh: typeof record.last_refresh === "string" ? record.last_refresh : undefined,
  };
}

/**
 * Read a response body under the same deadline that covered the request.
 *
 * `response.text()` is a second network operation. Leaving it unbounded is how an
 * advertised 30-second budget turns into an unbounded hang: the headers arrive in
 * 200 ms and the body never finishes.
 */
async function readBodyWithin(response: Response, deadline: Deadline): Promise<string> {
  try {
    return await deadline.race(response.text(), "reading the response body");
  } catch {
    return "";
  }
}

function parseJsonOrEmpty<T>(text: string): Partial<T> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Partial<T>) : {};
  } catch {
    return {};
  }
}

/** Return live credentials, refreshing only when the access token is expired. */
export async function ensureFreshAuth(
  path: string = authPath(),
  options: RefreshOptions = {},
): Promise<CodexAuth> {
  const auth = await readAuth(path);
  if (!isExpired(auth.accessToken)) return auth;
  return refreshAuth(path, options);
}
