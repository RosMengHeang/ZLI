import { createHash } from "node:crypto";
import { join } from "node:path";

import { FIVE_HOUR_WINDOW, type PlanLimitWindow, WEEKLY_WINDOW } from "@zli-v2/contracts";

import { clamp, isoTime, number, numeric, parseJson, record, retryAfterMs, secret } from "./answerFields.js";
import type { LimitRead } from "./PlanLimits.js";
import { jsonBody, type LimitReaderDeps, send } from "./readerDeps.js";

const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
/** Kimi Code renews a token this close to expiry on its next run, so ZLI waits for that. */
const EXPIRY_SKEW_S = 5;

/**
 * Reads the weekly and shorter rolling windows for the Kimi Code login in `kimiHome`
 * (KIMI_CODE_HOME, or ~/.kimi-code). Kimi rotates its refresh token, so ZLI never refreshes: an
 * expired token waits until Kimi Code runs again.
 */
export async function readKimiLimits(kimiHome: string | undefined, deps: LimitReaderDeps): Promise<LimitRead> {
  const home = kimiHome ?? secret(deps.env.KIMI_CODE_HOME) ?? join(deps.home, ".kimi-code");
  const config = await deps.readFile(join(home, "config.toml")).catch(() => "");
  const { tokenName, usageUrl } = kimiEndpoint(config, deps.env);
  const file = await deps.readFile(join(home, "credentials", `${tokenName}.json`)).catch(() => undefined);
  const credentials = record(file ? parseJson(file) : undefined);
  const token = secret(credentials?.access_token);
  if (!token) return { state: "signed-out", message: "Not signed in to Kimi Code.", windows: [] };
  const expiresAt = number(credentials?.expires_at);
  if (expiresAt !== undefined && expiresAt - deps.now() / 1000 <= EXPIRY_SKEW_S) return expired();
  const response = await send(deps, usageUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!response) return { state: "error", message: "Could not reach Kimi. ZLI will try again.", windows: [] };
  if (response.status === 401 || response.status === 403) return expired();
  if (response.status === 429) {
    return {
      state: "error",
      message: "Kimi is limiting usage checks. ZLI will try again later.",
      windows: [],
      retryAfterMs: retryAfterMs(response.headers.get("retry-after"), deps.now()),
    };
  }
  if (!response.ok) return { state: "error", message: "Kimi did not report usage. ZLI will try again.", windows: [] };
  return kimiLimitRead(await jsonBody(response));
}

function expired(): LimitRead {
  return {
    state: "expired",
    message: "The Kimi sign-in needs a refresh. Open Kimi Code with this account once.",
    windows: [],
  };
}

/** `usage` is the weekly window; `limits[]` holds the shorter rolling ones, such as 5 hours. */
export function kimiLimitRead(body: unknown): LimitRead {
  const answer = record(body);
  const byLength = new Map<number, PlanLimitWindow>();
  const add = (detail: unknown, minutes: number) => {
    const window = kimiWindow(detail, minutes);
    if (window && !byLength.has(minutes)) byLength.set(minutes, window);
  };
  add(answer?.usage, WEEKLY_WINDOW);
  for (const value of Array.isArray(answer?.limits) ? answer.limits : []) {
    const limit = record(value);
    add(limit?.detail, windowMinutes(limit?.window) ?? FIVE_HOUR_WINDOW);
  }
  const windows = [...byLength.values()].sort(
    (left, right) => (left.durationMinutes ?? 0) - (right.durationMinutes ?? 0),
  );
  if (windows.length === 0)
    return { state: "unavailable", message: "This Kimi plan reports no usage limits.", windows: [] };
  return { state: "ok", windows: windows.slice(0, 8) };
}

function kimiWindow(value: unknown, durationMinutes: number): PlanLimitWindow | undefined {
  const detail = record(value);
  const limit = numeric(detail?.limit);
  const remaining = numeric(detail?.remaining);
  const used =
    numeric(detail?.used) ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined);
  if (!limit || limit <= 0 || used === undefined) return undefined;
  const resetsAt = isoTime(detail?.resetTime ?? detail?.resetAt);
  return { durationMinutes, usedPercent: clamp((used / limit) * 100), ...(resetsAt ? { resetsAt } : {}) };
}

function windowMinutes(value: unknown): number | undefined {
  const window = record(value);
  const duration = numeric(window?.duration);
  if (duration === undefined || duration <= 0) return undefined;
  const unit = typeof window?.timeUnit === "string" ? window.timeUnit.toUpperCase() : "";
  const minutes = unit.includes("SECOND")
    ? duration / 60
    : unit.includes("HOUR")
      ? duration * 60
      : unit.includes("DAY")
        ? duration * 1_440
        : duration;
  return Math.max(1, Math.round(minutes));
}

/**
 * Which credentials file and usage URL Kimi Code uses. The default host keeps "kimi-code.json"; a
 * custom host or base URL, from the environment or config.toml, gets a file named after a hash of
 * both, the way Kimi Code 2 names it.
 */
export function kimiEndpoint(configToml: string, env: NodeJS.ProcessEnv): { tokenName: string; usageUrl: string } {
  const config = managedProvider(configToml);
  const envBaseUrl = env.KIMI_CODE_BASE_URL;
  const envOAuthHost = env.KIMI_CODE_OAUTH_HOST ?? env.KIMI_OAUTH_HOST;
  const fromEnv = envBaseUrl !== undefined || envOAuthHost !== undefined;
  const trim = (value: string) => value.trim().replace(/\/+$/u, "");
  const baseUrl = trim((envBaseUrl ?? config.baseUrl) || DEFAULT_BASE_URL);
  const oauthHost = trim((fromEnv ? envOAuthHost : config.oauthHost) || DEFAULT_OAUTH_HOST);
  const shared = baseUrl === DEFAULT_BASE_URL && oauthHost === DEFAULT_OAUTH_HOST;
  // Key order matters: Kimi Code hashes JSON.stringify({ oauthHost, baseUrl }).
  const hash = createHash("sha256").update(JSON.stringify({ oauthHost, baseUrl })).digest("hex").slice(0, 16);
  return { tokenName: shared ? "kimi-code" : `kimi-code-env-${hash}`, usageUrl: `${baseUrl}/usages` };
}

/**
 * `base_url` and `oauth.oauth_host` of `[providers."managed:kimi-code"]`. Only these two keys matter
 * here, so a full TOML parser is not worth a dependency; anything unusual falls back to the defaults.
 */
function managedProvider(toml: string): { baseUrl?: string; oauthHost?: string } {
  const found: { baseUrl?: string; oauthHost?: string } = {};
  let section = "";
  for (const raw of toml.split(/\r?\n/u)) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/u.exec(line);
    if (header?.[1]) {
      section = header[1].replace(/\s+/gu, "").replace(/'/gu, '"');
      continue;
    }
    const [, key, value = ""] = /^([A-Za-z_]+)\s*=\s*["']([^"']*)["']/u.exec(line) ?? [];
    if (section === 'providers."managed:kimi-code"' && key === "base_url") found.baseUrl = value;
    if (section === 'providers."managed:kimi-code".oauth' && key === "oauth_host") found.oauthHost = value;
  }
  return found;
}
