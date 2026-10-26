import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { FIVE_HOUR_WINDOW, MONTHLY_WINDOW, type PlanLimitWindow, WEEKLY_WINDOW } from "@zli-v2/contracts";

import type { LimitRead } from "./PlanLimits.js";

const execFileAsync = promisify(execFile);

/**
 * Anthropic's endpoint behind Claude Code's /usage. It is not documented; the beta header and a
 * claude-code User-Agent are what Claude Code itself sends, and without that agent Anthropic answers
 * 429 at once.
 */
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_USAGE_HEADERS = { "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" };
const READ_TIMEOUT_MS = 15_000;
/** Anthropic limits this endpoint per token, so a 429 waits at least this long before the next try. */
export const CLAUDE_BACKOFF_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 24 * 3_600_000;

type Credentials = { accessToken: string; plan?: string };

export type ClaudeLimitDeps = {
  fetch: typeof fetch;
  platform: NodeJS.Platform;
  home: string;
  readFile(path: string): Promise<string>;
  /** The macOS Keychain item's password, or undefined when there is none. */
  keychain(service: string): Promise<string | undefined>;
  url?: string;
};

export const defaultClaudeLimitDeps = (home: string): ClaudeLimitDeps => ({
  fetch: (input, init) => fetch(input, init),
  platform: process.platform,
  home,
  readFile: (path) => readFile(path, "utf8"),
  keychain: async (service) => {
    try {
      const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", service, "-w"], {
        timeout: 5_000,
        windowsHide: true,
      });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  },
});

/**
 * Reads the 5-hour and weekly windows for the Claude login in `configDir` (the usual ~/.claude when
 * undefined). The token is read where Claude Code keeps it and sent only to Anthropic. ZLI never
 * refreshes it: a refresh would rotate the login Claude Code itself depends on.
 */
export async function readClaudeLimits(configDir: string | undefined, deps: ClaudeLimitDeps): Promise<LimitRead> {
  const credentials = await claudeCredentials(configDir, deps);
  if (!credentials) return { state: "signed-out", message: "Not signed in to Claude Code.", windows: [] };
  const plan = credentials.plan ? { plan: credentials.plan } : {};
  let response: Response;
  try {
    response = await deps.fetch(deps.url ?? CLAUDE_USAGE_URL, {
      headers: {
        ...CLAUDE_USAGE_HEADERS,
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch {
    return { state: "error", message: "Could not reach Anthropic. ZLI will try again.", windows: [], ...plan };
  }
  if (response.status === 403 && (await response.text().catch(() => "")).includes("user:profile")) {
    // Tokens made by `claude setup-token` can run Claude but cannot read the plan's usage.
    return { state: "unavailable", message: "This Claude sign-in cannot read plan limits.", windows: [], ...plan };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      state: "expired",
      message: "The Claude sign-in needs a refresh. Open Claude Code with this account once.",
      windows: [],
      ...plan,
    };
  }
  if (response.status === 429) {
    return {
      state: "error",
      message: "Anthropic is limiting usage checks. ZLI will try again later.",
      windows: [],
      retryAfterMs: retryAfter(response.headers.get("retry-after")),
      ...plan,
    };
  }
  if (!response.ok) {
    return { state: "error", message: "Anthropic did not report usage. ZLI will try again.", windows: [], ...plan };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { state: "error", message: "Anthropic sent an unexpected answer.", windows: [], ...plan };
  }
  return { ...claudeLimitRead(body), ...plan };
}

function retryAfter(header: string | null): number {
  const seconds = header ? Number(header) : Number.NaN;
  const at = header && Number.isNaN(seconds) ? Date.parse(header) - Date.now() : seconds * 1000;
  return Number.isFinite(at) ? Math.min(MAX_BACKOFF_MS, Math.max(CLAUDE_BACKOFF_MS, at)) : CLAUDE_BACKOFF_MS;
}

/**
 * The whole-plan 5-hour and weekly windows, any weekly limit kept to one model, and the monthly
 * extra-usage cap. Anthropic moved per-model limits from `seven_day_opus` and `seven_day_sonnet`
 * into `limits[]`; both shapes are read, and `limits[]` wins for a model both name.
 */
export function claudeLimitRead(body: unknown): LimitRead {
  const answer = record(body);
  const windows: PlanLimitWindow[] = [];
  const push = (window: PlanLimitWindow | undefined) => {
    if (window) windows.push(window);
  };
  push(claudeWindow(answer?.five_hour, FIVE_HOUR_WINDOW));
  push(claudeWindow(answer?.seven_day, WEEKLY_WINDOW));
  const scoped = new Map<string, PlanLimitWindow>();
  for (const limit of Array.isArray(answer?.limits) ? answer.limits : []) {
    const entry = record(limit);
    const name = text(record(record(entry?.scope)?.model)?.display_name);
    if (entry?.kind !== "weekly_scoped" || !name) continue;
    const window = claudeWindow({ utilization: entry.percent, resets_at: entry.resets_at }, WEEKLY_WINDOW, name);
    if (window && !scoped.has(name.toLowerCase())) scoped.set(name.toLowerCase(), window);
  }
  for (const [key, name] of [
    ["seven_day_opus", "Opus"],
    ["seven_day_sonnet", "Sonnet"],
  ] as const) {
    const window = claudeWindow(answer?.[key], WEEKLY_WINDOW, name);
    if (window && !scoped.has(name.toLowerCase())) scoped.set(name.toLowerCase(), window);
  }
  windows.push(...scoped.values());
  push(claudeSpend(answer));
  if (windows.length === 0) {
    return { state: "unavailable", message: "This Claude login has no plan limits.", windows: [] };
  }
  return { state: "ok", windows };
}

function claudeWindow(value: unknown, durationMinutes: number, scope?: string): PlanLimitWindow | undefined {
  const window = record(value);
  const used = number(window?.utilization) ?? number(window?.used_percentage);
  if (used === undefined) return undefined;
  const resetsAt = claudeTime(window?.resets_at);
  return {
    ...(scope ? { scope } : {}),
    durationMinutes,
    usedPercent: clamp(used),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/** The newer `spend` object first, then the older `extra_usage`; either counts only while switched on. */
function claudeSpend(answer: Record<string, unknown> | undefined): PlanLimitWindow | undefined {
  const spend = record(answer?.spend);
  if (spend && spend.enabled !== false) {
    const used = minor(spend.used);
    const limit = minor(spend.limit) ?? minor(record(spend.cap)?.money);
    const percent = used !== undefined && limit ? (used / limit) * 100 : number(spend.percent);
    if (percent !== undefined) return { kind: "spend", durationMinutes: MONTHLY_WINDOW, usedPercent: clamp(percent) };
  }
  const extra = record(answer?.extra_usage);
  if (extra?.is_enabled !== true) return undefined;
  const used = number(extra.used_credits);
  const limit = number(extra.monthly_limit);
  const percent = used !== undefined && limit ? (used / limit) * 100 : number(extra.utilization);
  return percent === undefined
    ? undefined
    : { kind: "spend", durationMinutes: MONTHLY_WINDOW, usedPercent: clamp(percent) };
}

/** Anthropic sends ISO strings, and sometimes Unix seconds or milliseconds. */
function claudeTime(value: unknown): string | undefined {
  const at =
    typeof value === "number" && value > 0
      ? value > 1e10
        ? value
        : value * 1000
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

function minor(value: unknown): number | undefined {
  const amount = record(value);
  const units = number(amount?.amount_minor);
  if (units === undefined) return undefined;
  return units / 10 ** (number(amount?.exponent) ?? 2);
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 60) : undefined;
}

/**
 * Claude Code keeps its login in `<config dir>/.credentials.json`, except on macOS, where it uses the
 * Keychain: "Claude Code-credentials" for ~/.claude, and the same name plus the first 8 hex digits of
 * the SHA-256 of the directory when CLAUDE_CONFIG_DIR points elsewhere.
 */
async function claudeCredentials(
  configDir: string | undefined,
  deps: ClaudeLimitDeps,
): Promise<Credentials | undefined> {
  const dir = configDir ?? join(deps.home, ".claude");
  const file = await deps.readFile(join(dir, ".credentials.json")).catch(() => undefined);
  const fromFile = file ? parseCredentials(file) : undefined;
  if (fromFile || deps.platform !== "darwin") return fromFile;
  const service = configDir
    ? `Claude Code-credentials-${createHash("sha256").update(configDir.normalize("NFC")).digest("hex").slice(0, 8)}`
    : "Claude Code-credentials";
  const secret = await deps.keychain(service);
  return secret ? parseCredentials(secret) : undefined;
}

function parseCredentials(text: string): Credentials | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const oauth = record(record(parsed)?.claudeAiOauth);
  const accessToken = typeof oauth?.accessToken === "string" ? oauth.accessToken.trim() : "";
  if (!accessToken) return undefined;
  const plan = typeof oauth?.subscriptionType === "string" ? oauth.subscriptionType.trim().slice(0, 60) : "";
  return { accessToken, ...(plan ? { plan } : {}) };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
