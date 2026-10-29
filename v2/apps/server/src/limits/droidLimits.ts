import { createDecipheriv } from "node:crypto";
import { join } from "node:path";

import { FIVE_HOUR_WINDOW, MONTHLY_WINDOW, type PlanLimitWindow, WEEKLY_WINDOW } from "@zli-v2/contracts";

import { clamp, isoTime, number, parseJson, record, retryAfterMs, secret } from "./answerFields.js";
import { jwtExpiry } from "./cursorLimits.js";
import type { LimitRead } from "./PlanLimits.js";
import { jsonBody, type LimitReaderDeps, send } from "./readerDeps.js";

const DEFAULT_API_BASE_URL = "https://api.factory.ai";
/** The endpoint behind Droid's own "you have used N% of your limit" messages. It is not documented. */
const LIMITS_PATH = "/api/billing/limits";
/** Droid renews its token a minute before it expires, so ZLI treats it as expired from then on. */
const EXPIRY_SKEW_MS = 60_000;
const KEY_SERVICE = "Factory CLI";
const KEY_BYTES = 32;
const IV_BYTES = 16;
const TAG_BYTES = 16;

export type DroidLimitDeps = LimitReaderDeps & {
  /** A password from the OS keyring, as keytar stores it, or undefined when there is none. */
  secretStore(service: string, account: string): Promise<string | undefined>;
  /** Has Droid renew its own sign-in. Undefined when Droid is not installed. */
  refreshLogin?(): Promise<void>;
};

type Login = { token: string; fromLogin: boolean };
/** `locked` when Droid saved a login whose key ZLI cannot reach, such as one in the Windows Credential Manager. */
type Saved = { token: string } | { locked: true } | undefined;

/**
 * Reads the 5-hour, weekly, and monthly windows of the Droid login. Droid rotates its refresh token,
 * so ZLI never refreshes it: when the saved token has expired, Droid renews it, then ZLI reads again.
 */
export async function readDroidLimits(deps: DroidLimitDeps): Promise<LimitRead> {
  let login = await droidLogin(deps);
  if (login === "locked") {
    return { state: "unavailable", message: "ZLI cannot open the Droid sign-in on this computer.", windows: [] };
  }
  if (!login) return { state: "signed-out", message: "Not signed in to Droid.", windows: [] };
  let refreshed = false;
  if (login.fromLogin && isExpired(login.token, deps.now())) {
    login = await renewedLogin(deps, login);
    refreshed = true;
    if (isExpired(login.token, deps.now())) return expired();
  }

  const url = `${apiBaseUrl(deps.env)}${LIMITS_PATH}`;
  const get = (token: string) =>
    send(deps, url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  let response = await get(login.token);
  if ((response?.status === 401 || response?.status === 403) && login.fromLogin && !refreshed) {
    login = await renewedLogin(deps, login);
    response = await get(login.token);
  }
  if (!response) return { state: "error", message: "Could not reach Factory. ZLI will try again.", windows: [] };
  if (response.status === 401 || response.status === 403) return expired();
  if (response.status === 429) {
    return {
      state: "error",
      message: "Factory is limiting usage checks. ZLI will try again later.",
      windows: [],
      retryAfterMs: retryAfterMs(response.headers.get("retry-after"), deps.now()),
    };
  }
  if (!response.ok)
    return { state: "error", message: "Factory did not report usage. ZLI will try again.", windows: [] };
  return droidLimitRead(await jsonBody(response));
}

async function renewedLogin(deps: DroidLimitDeps, current: Login): Promise<Login> {
  await deps.refreshLogin?.().catch(() => undefined);
  const next = await droidLogin(deps);
  return next && next !== "locked" ? next : current;
}

function expired(): LimitRead {
  return { state: "expired", message: "The Droid sign-in needs a refresh. Open Droid once.", windows: [] };
}

/** Only the standard pool, the one every Droid model draws from by default. */
export function droidLimitRead(body: unknown): LimitRead {
  const standard = record(record(record(body)?.limits)?.standard);
  const windows: PlanLimitWindow[] = [];
  for (const [key, durationMinutes] of [
    ["fiveHour", FIVE_HOUR_WINDOW],
    ["weekly", WEEKLY_WINDOW],
    ["monthly", MONTHLY_WINDOW],
  ] as const) {
    const window = record(standard?.[key]);
    const used = number(window?.usedPercent);
    if (used === undefined) continue;
    const resetsAt = isoTime(window?.windowEnd);
    windows.push({ durationMinutes, usedPercent: clamp(used), ...(resetsAt ? { resetsAt } : {}) });
  }
  if (windows.length === 0) {
    return { state: "unavailable", message: "This Factory plan reports no usage limits.", windows: [] };
  }
  return { state: "ok", windows };
}

/**
 * The token Droid itself would use: FACTORY_API_KEY when set, since it overrides the saved login,
 * then the saved login in ~/.factory.
 */
async function droidLogin(deps: DroidLimitDeps): Promise<Login | "locked" | undefined> {
  const apiKey = secret(deps.env.FACTORY_API_KEY);
  if (apiKey) return { token: apiKey, fromLogin: false };
  const saved = await savedLogin(deps);
  if (!saved) return undefined;
  return "locked" in saved ? "locked" : { token: saved.token, fromLogin: true };
}

/**
 * Droid encrypts its login with AES-256-GCM and keeps the key apart from it: in the OS keyring for
 * auth.v2.keyring, in the macOS login Keychain for auth.v2.loginkeychain, or in auth.v2.key next to
 * auth.v2.file. Droid tries them in this order.
 */
async function savedLogin(deps: DroidLimitDeps): Promise<Saved> {
  const dir = join(deps.home, ".factory");
  const stores: Array<{ file: string; key: () => Promise<string | undefined> }> = [
    { file: "auth.v2.keyring", key: () => deps.secretStore(KEY_SERVICE, "auth-encryption-key") },
    { file: "auth.v2.loginkeychain", key: () => deps.secretStore(KEY_SERVICE, "auth-encryption-key-security-cli") },
    { file: "auth.v2.file", key: () => deps.readFile(join(dir, "auth.v2.key")).catch(() => undefined) },
  ];
  let locked = false;
  for (const store of stores) {
    const sealed = await deps.readFile(join(dir, store.file)).catch(() => undefined);
    if (!sealed) continue;
    const key = await store.key().catch(() => undefined);
    const token = key ? accessToken(sealed, key) : undefined;
    if (token) return { token };
    locked = true;
  }
  return locked ? { locked: true } : undefined;
}

/** The access token in one of Droid's sealed login files, or undefined when it cannot be opened. */
export function accessToken(sealed: string, base64Key: string): string | undefined {
  const key = Buffer.from(base64Key.trim(), "base64");
  const parts = sealed.trim().split(":");
  if (key.length !== KEY_BYTES || parts.length !== 3) return undefined;
  const [iv, tag, data] = parts.map((part) => Buffer.from(part, "base64"));
  if (!iv || !tag || !data || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    return secret(record(parseJson(json))?.access_token);
  } catch {
    return undefined;
  }
}

function isExpired(token: string, now: number): boolean {
  const expiresAt = jwtExpiry(token);
  return expiresAt !== undefined && expiresAt - EXPIRY_SKEW_MS <= now;
}

function apiBaseUrl(env: NodeJS.ProcessEnv): string {
  return (secret(env.FACTORY_API_BASE_URL) ?? DEFAULT_API_BASE_URL).replace(/\/+$/u, "");
}
