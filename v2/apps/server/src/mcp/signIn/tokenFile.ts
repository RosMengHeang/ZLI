import { mkdir, readFile, rm, stat } from "node:fs/promises";

import { isPlainObject, writeFileAtomic } from "../../browser-tool/browserTool.js";
import { type ClientAuth, type FetchLike, oauthErrorCode, tokenRequest } from "./oauth.js";

export type SignInMethod = "browser" | "github-cli" | "github-code";

/** One saved login, shared by ZLI and every connect bridge an agent starts. */
export type StoredSignIn = {
  version: 1;
  serverUrl: string;
  via: SignInMethod;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  scope?: string;
  account?: string;
  signedInAt: string;
  /** Set when the server turned the login down; signing in again clears it. */
  expiredAt?: string;
  /** What a refresh needs. Missing for logins that cannot be refreshed. */
  refresh?: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    auth: ClientAuth;
    resource: string;
  };
};

/** Refresh this long before the access token runs out, so a request in flight does not hit the edge. */
const EXPIRY_MARGIN_MS = 60_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 150;

export async function readSignIn(path: string): Promise<StoredSignIn | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed) || parsed.version !== 1 || typeof parsed.accessToken !== "string") return undefined;
    return parsed as StoredSignIn;
  } catch {
    return undefined;
  }
}

export async function writeSignIn(path: string, value: StoredSignIn): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function needsRefresh(stored: StoredSignIn, now: number): boolean {
  return stored.expiresAt !== undefined && stored.expiresAt - EXPIRY_MARGIN_MS <= now;
}

/** Whether the login can still produce a working token. */
export function signInUsable(stored: StoredSignIn, now: number): boolean {
  return !needsRefresh(stored, now) || (stored.refreshToken !== undefined && stored.refresh !== undefined);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Holds a lock directory beside the file while `work` runs. Several agents can share one login, and many
 * servers rotate the refresh token on use, so only one process may refresh at a time.
 */
async function withLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      await mkdir(lock);
      held = true;
    } catch (error) {
      if (!(isPlainObject(error) && error.code === "EEXIST")) break;
      const age = await stat(lock).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) break;
      await sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await work();
  } finally {
    if (held) await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Whether a failed token request means the login itself is no longer accepted, not a passing network problem. */
export function refreshRejected(error: unknown): boolean {
  if (oauthErrorCode(error) === "invalid_grant") return true;
  const status = isPlainObject(error) ? error.status : undefined;
  return status === 400 || status === 401;
}

/**
 * Trades the refresh token for new tokens and saves them. Keeps the old refresh token when none comes back.
 * When the server turns the refresh token down, the login is marked expired before the error is thrown.
 */
export async function refreshSignIn(
  path: string,
  stored: StoredSignIn,
  options: { fetch?: FetchLike; now?: () => number } = {},
): Promise<StoredSignIn> {
  const refresh = stored.refresh;
  if (!refresh || !stored.refreshToken) return stored;
  let tokens: Awaited<ReturnType<typeof tokenRequest>>;
  try {
    tokens = await tokenRequest(
      refresh.tokenEndpoint,
      { grant_type: "refresh_token", refresh_token: stored.refreshToken, resource: refresh.resource },
      {
        clientId: refresh.clientId,
        auth: refresh.auth,
        ...(refresh.clientSecret ? { clientSecret: refresh.clientSecret } : {}),
      },
      options.fetch,
      options.now,
    );
  } catch (error) {
    if (refreshRejected(error) && !stored.expiredAt) {
      const now = options.now ?? Date.now;
      await writeSignIn(path, { ...stored, expiredAt: new Date(now()).toISOString() }).catch(() => undefined);
    }
    throw error;
  }
  const next: StoredSignIn = {
    ...stored,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? stored.refreshToken,
    ...(tokens.scope ? { scope: tokens.scope } : {}),
  };
  delete next.expiredAt;
  if (tokens.expiresAt === undefined) delete next.expiresAt;
  else next.expiresAt = tokens.expiresAt;
  await writeSignIn(path, next);
  return next;
}

/**
 * Marks the login expired after the server turned `rejectedToken` down. Does nothing when another process
 * saved a different token meanwhile, since that one may still work.
 */
export async function markSignInExpired(
  path: string,
  rejectedToken: string,
  options: { now?: () => number } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  await withLock(path, async () => {
    const current = await readSignIn(path);
    if (!current || current.expiredAt || current.accessToken !== rejectedToken) return;
    await writeSignIn(path, { ...current, expiredAt: new Date(now()).toISOString() });
  });
}

/**
 * A working access token from the saved login, refreshed first when it is about to run out or when
 * `force` says the server just turned it down. Undefined when there is no usable login. An expired login
 * gives no token unless `force` asks to try its refresh token once more.
 */
export async function freshAccessToken(
  path: string,
  options: { force?: boolean; fetch?: FetchLike; now?: () => number } = {},
): Promise<string | undefined> {
  const now = options.now ?? Date.now;
  const first = await readSignIn(path);
  if (!first) return undefined;
  if (first.expiredAt && !options.force) return undefined;
  if (!options.force && !needsRefresh(first, now())) return first.accessToken;
  if (!first.refreshToken || !first.refresh) return options.force ? undefined : first.accessToken;
  return withLock(path, async () => {
    const current = await readSignIn(path);
    if (!current) return undefined;
    // Another process refreshed while this one waited for the lock.
    if (current.accessToken !== first.accessToken && !current.expiredAt && !needsRefresh(current, now())) {
      return current.accessToken;
    }
    try {
      return (await refreshSignIn(path, current, options)).accessToken;
    } catch (error) {
      return options.force || refreshRejected(error) ? undefined : current.accessToken;
    }
  });
}
