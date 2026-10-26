import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { FIVE_HOUR_WINDOW, type PlanLimitWindow, WEEKLY_WINDOW } from "@zli-v2/contracts";

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
/** Anthropic limits this endpoint per token, so a 429 waits this long before the next try. */
export const CLAUDE_BACKOFF_MS = 15 * 60_000;

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
      retryAfterMs: CLAUDE_BACKOFF_MS,
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

export function claudeLimitRead(body: unknown): LimitRead {
  const answer = record(body);
  const windows = [
    claudeWindow(answer?.five_hour, FIVE_HOUR_WINDOW),
    claudeWindow(answer?.seven_day, WEEKLY_WINDOW),
  ].filter((window): window is PlanLimitWindow => window !== undefined);
  if (windows.length === 0) {
    return { state: "unavailable", message: "This Claude login has no plan limits.", windows: [] };
  }
  return { state: "ok", windows };
}

function claudeWindow(value: unknown, durationMinutes: number): PlanLimitWindow | undefined {
  const window = record(value);
  const used = typeof window?.utilization === "number" ? window.utilization : undefined;
  if (used === undefined || !Number.isFinite(used)) return undefined;
  const resetsAt = typeof window?.resets_at === "string" ? Date.parse(window.resets_at) : Number.NaN;
  return {
    durationMinutes,
    usedPercent: Math.min(100, Math.max(0, used)),
    ...(Number.isNaN(resetsAt) ? {} : { resetsAt: new Date(resetsAt).toISOString() }),
  };
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
    ? `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`
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
