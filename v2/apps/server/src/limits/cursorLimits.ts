import { join } from "node:path";

import { MONTHLY_WINDOW, type PlanLimitWindow } from "@zli-v2/contracts";

import { clamp, isoTime, number, parseJson, record, retryAfterMs, secret } from "./answerFields.js";
import type { LimitRead } from "./PlanLimits.js";
import { jsonBody, type LimitReaderDeps, send } from "./readerDeps.js";

/** The Connect endpoint behind Cursor Agent's usage display. It is not documented. */
export const CURSOR_USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
/** Where cursor-agent 2026.06 and later keep the login on macOS. */
const KEYCHAIN_SERVICE = "cursor-access-token";
const KEYCHAIN_ACCOUNT = "cursor-user";

type Token = { found: string } | { unavailable: string } | undefined;

/**
 * Reads this billing month's plan use for the Cursor login in `configDir` (CURSOR_CONFIG_DIR, or the
 * usual login when undefined). The token is sent only to Cursor, and never refreshed: Cursor Agent
 * renews it the next time it runs.
 */
export async function readCursorLimits(configDir: string | undefined, deps: LimitReaderDeps): Promise<LimitRead> {
  const token = await cursorToken(configDir, deps);
  if (token && "unavailable" in token) return { state: "unavailable", message: token.unavailable, windows: [] };
  if (!token) return { state: "signed-out", message: "Not signed in to Cursor Agent.", windows: [] };
  const expiresAt = jwtExpiry(token.found);
  if (expiresAt !== undefined && expiresAt <= deps.now()) return expired();
  const response = await send(deps, CURSOR_USAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.found}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "connect-protocol-version": "1",
      "x-cursor-client-type": "cli",
    },
    body: "{}",
  });
  if (!response) return { state: "error", message: "Could not reach Cursor. ZLI will try again.", windows: [] };
  if (response.status === 401 || response.status === 403) return expired();
  if (response.status === 429) {
    return {
      state: "error",
      message: "Cursor is limiting usage checks. ZLI will try again later.",
      windows: [],
      retryAfterMs: retryAfterMs(response.headers.get("retry-after"), deps.now()),
    };
  }
  if (!response.ok) return { state: "error", message: "Cursor did not report usage. ZLI will try again.", windows: [] };
  return cursorLimitRead(await jsonBody(response));
}

/**
 * The plan's monthly share, then its two pools: Auto (Cursor's own models) and API (the providers'
 * models). Cursor's percentages count bonus use, so they match the dashboard where spend over limit
 * would not.
 */
export function cursorLimitRead(body: unknown): LimitRead {
  const answer = record(body);
  const usage = record(answer?.planUsage);
  const resetsAt = isoTime(answer?.billingCycleEnd);
  const windows: PlanLimitWindow[] = [];
  for (const [key, scope] of [
    ["totalPercentUsed", undefined],
    ["autoPercentUsed", "Auto"],
    ["apiPercentUsed", "API"],
  ] as const) {
    const used = number(usage?.[key]);
    if (used === undefined) continue;
    windows.push({
      ...(scope ? { scope } : {}),
      durationMinutes: MONTHLY_WINDOW,
      usedPercent: clamp(used),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  if (windows.length === 0) {
    return { state: "unavailable", message: "This Cursor plan reports no usage limits.", windows: [] };
  }
  return { state: "ok", windows };
}

function expired(): LimitRead {
  return {
    state: "expired",
    message: "The Cursor sign-in needs a refresh. Open Cursor Agent with this account once.",
    windows: [],
  };
}

/**
 * Cursor Agent's token: CURSOR_AUTH_TOKEN, then the macOS Keychain, then auth.json in its config
 * folder. The Keychain item has one name for every login, so a saved account is read only from its
 * own folder. An API key in CURSOR_API_KEY may belong to another account and has no plan limits.
 */
async function cursorToken(configDir: string | undefined, deps: LimitReaderDeps): Promise<Token> {
  if (configDir) {
    const token = await fileToken(join(configDir, "auth.json"), deps);
    if (token) return { found: token };
    return deps.platform === "darwin"
      ? { unavailable: "Cursor keeps this account's sign-in in the Keychain, which ZLI cannot tell apart." }
      : undefined;
  }
  const fromEnv = secret(deps.env.CURSOR_AUTH_TOKEN);
  if (fromEnv) return { found: fromEnv };
  if (secret(deps.env.CURSOR_API_KEY)) return { unavailable: "Cursor API keys have no plan limits." };
  if (deps.platform === "darwin") {
    const fromKeychain = secret(await deps.keychain(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT));
    if (fromKeychain) return { found: fromKeychain };
  }
  const fromFile = await fileToken(join(cursorConfigDir(deps), "auth.json"), deps);
  return fromFile ? { found: fromFile } : undefined;
}

function cursorConfigDir(deps: LimitReaderDeps): string {
  const fromEnv = secret(deps.env.CURSOR_CONFIG_DIR);
  if (fromEnv) return fromEnv;
  if (deps.platform === "darwin") return join(deps.home, ".cursor");
  if (deps.platform === "win32")
    return join(secret(deps.env.APPDATA) ?? join(deps.home, "AppData", "Roaming"), "Cursor");
  return join(secret(deps.env.XDG_CONFIG_HOME) ?? join(deps.home, ".config"), "cursor");
}

async function fileToken(path: string, deps: LimitReaderDeps): Promise<string | undefined> {
  const file = await deps.readFile(path).catch(() => undefined);
  return file ? secret(record(parseJson(file))?.accessToken) : undefined;
}

/** When a JWT expires, in milliseconds, or undefined when it does not say. */
export function jwtExpiry(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  const claims = record(parseJson(Buffer.from(payload, "base64url").toString("utf8")));
  const exp = number(claims?.exp);
  return exp === undefined ? undefined : exp * 1000;
}
