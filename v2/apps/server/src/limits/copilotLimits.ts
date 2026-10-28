import { join } from "node:path";

import { MONTHLY_WINDOW, type PlanLimitWindow } from "@zli-v2/contracts";

import { clamp, isoTime, number, numeric, parseJson, record, retryAfterMs, secret, text } from "./answerFields.js";
import type { LimitRead } from "./PlanLimits.js";
import { jsonBody, type LimitReaderDeps, send } from "./readerDeps.js";

/** What Copilot CLI's /usage and the VS Code extension read. It is not documented. */
export const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";
/** Copilot CLI's service name in the system credential store. */
const KEYCHAIN_SERVICE = "copilot-cli";
/** Where Copilot CLI writes tokens in config.json when there is no credential store. */
const CONFIG_TOKEN_KEYS = ["copilot_tokens", "copilotTokens"] as const;

export type CopilotLimitDeps = LimitReaderDeps & {
  /** `gh auth token`, which Copilot CLI falls back to, or undefined when GitHub CLI has no login. */
  ghToken(): Promise<string | undefined>;
};

type Token = { found: string } | { unavailable: string } | undefined;

/**
 * Reads this month's Copilot allowances (premium requests, and chat and completions on plans that cap
 * them) with the GitHub token Copilot CLI uses. `configDir` is a saved account's COPILOT_HOME.
 */
export async function readCopilotLimits(
  target: { configDir?: string; apiKey?: string },
  deps: CopilotLimitDeps,
): Promise<LimitRead> {
  const token = target.apiKey ? { found: target.apiKey } : await copilotToken(target.configDir, deps);
  if (token && "unavailable" in token) return { state: "unavailable", message: token.unavailable, windows: [] };
  if (!token) return { state: "signed-out", message: "Not signed in to GitHub Copilot.", windows: [] };
  const response = await send(deps, COPILOT_USER_URL, {
    headers: { Authorization: `token ${token.found}`, Accept: "application/json", "User-Agent": "zli" },
  });
  if (!response) return { state: "error", message: "Could not reach GitHub. ZLI will try again.", windows: [] };
  if (response.status === 401) {
    return {
      state: "expired",
      message: "The GitHub sign-in for Copilot needs a refresh. Run copilot login.",
      windows: [],
    };
  }
  if (response.status === 403 || response.status === 404) {
    return { state: "unavailable", message: "This GitHub login has no Copilot plan to read.", windows: [] };
  }
  if (response.status === 429) {
    return {
      state: "error",
      message: "GitHub is limiting usage checks. ZLI will try again later.",
      windows: [],
      retryAfterMs: retryAfterMs(response.headers.get("retry-after"), deps.now()),
    };
  }
  if (!response.ok) return { state: "error", message: "GitHub did not report usage. ZLI will try again.", windows: [] };
  return copilotLimitRead(await jsonBody(response));
}

/**
 * One monthly window per capped allowance. Unlimited ones and ones the plan does not include (no
 * premium requests on Copilot Free) have nothing to show.
 */
export function copilotLimitRead(body: unknown): LimitRead {
  const answer = record(body);
  const snapshots = record(answer?.quota_snapshots);
  const resetsAt = isoTime(answer?.quota_reset_date_utc ?? answer?.quota_reset_date);
  const plan = text(answer?.copilot_plan);
  const windows: PlanLimitWindow[] = [];
  for (const [key, scope] of [
    ["premium_interactions", "Premium"],
    ["chat", "Chat"],
    ["completions", "Completions"],
  ] as const) {
    const snapshot = record(snapshots?.[key]);
    if (!snapshot || snapshot.unlimited === true) continue;
    const entitlement = numeric(snapshot.entitlement);
    if (!entitlement || entitlement <= 0) continue;
    const remaining = numeric(snapshot.remaining);
    const percentRemaining = number(snapshot.percent_remaining);
    const used =
      percentRemaining !== undefined
        ? 100 - percentRemaining
        : remaining !== undefined
          ? ((entitlement - remaining) / entitlement) * 100
          : undefined;
    if (used === undefined) continue;
    windows.push({
      scope,
      durationMinutes: MONTHLY_WINDOW,
      usedPercent: clamp(used),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  if (windows.length === 0) {
    return {
      state: "unavailable",
      message: "This Copilot plan reports no usage limits.",
      windows: [],
      ...(plan ? { plan } : {}),
    };
  }
  return { state: "ok", windows, ...(plan ? { plan } : {}) };
}

/**
 * The order Copilot CLI uses: COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, its credential store entry,
 * config.json, then GitHub CLI. The store entry has one name for every login, so a saved account is
 * read only from its own folder.
 */
async function copilotToken(configDir: string | undefined, deps: CopilotLimitDeps): Promise<Token> {
  if (configDir) {
    const token = await configToken(configDir, deps);
    if (token) return { found: token };
    return deps.platform === "linux"
      ? undefined
      : { unavailable: "Copilot keeps this account's sign-in in the system keychain, which ZLI cannot tell apart." };
  }
  const fromEnv = secret(deps.env.COPILOT_GITHUB_TOKEN) ?? secret(deps.env.GH_TOKEN) ?? secret(deps.env.GITHUB_TOKEN);
  if (fromEnv) return { found: fromEnv };
  const stored = secret(await deps.secretStore(KEYCHAIN_SERVICE).catch(() => undefined));
  if (stored) return { found: stored };
  const fromFile = await configToken(secret(deps.env.COPILOT_HOME) ?? join(deps.home, ".copilot"), deps);
  if (fromFile) return { found: fromFile };
  const fromGh = secret(await deps.ghToken().catch(() => undefined));
  return fromGh ? { found: fromGh } : undefined;
}

async function configToken(dir: string, deps: LimitReaderDeps): Promise<string | undefined> {
  const file = await deps.readFile(join(dir, "config.json")).catch(() => undefined);
  const config = record(file ? parseJson(file) : undefined);
  for (const key of CONFIG_TOKEN_KEYS) {
    const tokens = record(config?.[key]);
    for (const value of Object.values(tokens ?? {})) {
      const token = secret(value);
      if (token) return token;
    }
  }
  return undefined;
}
