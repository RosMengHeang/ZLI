import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { AgentLogin, ListedProviderKind } from "@zli-v2/contracts";

import { CONFIG_DIR_ENV } from "./accountEnv.js";

export type LoginContext = { home: string; env: NodeJS.ProcessEnv };

/**
 * Who an agent CLI is signed in as, from the files the CLI itself writes. Only reads; tokens are never
 * returned. Undefined means ZLI cannot tell, so the setup shows nothing rather than a wrong answer.
 */
export async function readAgentLogin(
  provider: ListedProviderKind,
  context: LoginContext,
): Promise<AgentLogin | undefined> {
  try {
    switch (provider) {
      case "claude-code":
        return await claudeLogin(context);
      case "codex":
        return await codexLogin(context);
      case "gemini":
        return await geminiLogin(context);
      case "droid":
        return await droidLogin(context);
      case "opencode":
        return await openCodeLogin(context);
      case "kimi":
        return await kimiLogin(context);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function configDir(provider: ListedProviderKind, context: LoginContext, fallback: string): string {
  const name = CONFIG_DIR_ENV[provider];
  const value = name ? context.env[name]?.trim() : undefined;
  return value || fallback;
}

/**
 * Claude Code writes the signed-in account to .claude.json (beside its config folder by default, inside
 * it when CLAUDE_CONFIG_DIR is set) on every platform, and the plan to .credentials.json outside macOS.
 */
async function claudeLogin(context: LoginContext): Promise<AgentLogin> {
  const custom = context.env.CLAUDE_CONFIG_DIR?.trim();
  const dir = custom || join(context.home, ".claude");
  const config = await readJson(custom ? join(dir, ".claude.json") : join(context.home, ".claude.json"));
  const credentials = await readJson(join(dir, ".credentials.json"));
  const account = record(config?.oauthAccount);
  const oauth = record(credentials?.claudeAiOauth);
  if (account || oauth) {
    return {
      status: "signed-in",
      method: "subscription",
      ...withEmail(text(account?.emailAddress)),
      ...withPlan(text(oauth?.subscriptionType)),
    };
  }
  if (context.env.ANTHROPIC_API_KEY?.trim() || text(config?.primaryApiKey)) {
    return { status: "signed-in", method: "api-key" };
  }
  return { status: "signed-out" };
}

/** Codex keeps its login in auth.json unless config.toml moves it to the system keychain. */
async function codexLogin(context: LoginContext): Promise<AgentLogin | undefined> {
  const dir = configDir("codex", context, join(context.home, ".codex"));
  const auth = await readJson(join(dir, "auth.json"));
  const tokens = record(auth?.tokens);
  const idToken = text(tokens?.id_token);
  if (idToken) {
    const claims = jwtClaims(idToken);
    const openai = record(claims?.["https://api.openai.com/auth"]);
    return {
      status: "signed-in",
      method: "subscription",
      ...withEmail(text(claims?.email)),
      ...withPlan(text(openai?.chatgpt_plan_type)),
    };
  }
  if (text(auth?.OPENAI_API_KEY)) return { status: "signed-in", method: "api-key" };
  const config = await readFile(join(dir, "config.toml"), "utf8").catch(() => "");
  if (/^\s*cli_auth_credentials_store\s*=\s*"(?:keyring|auto)"/mu.test(config)) return undefined;
  return { status: "signed-out" };
}

/** Gemini CLI records the Google account it signed in with; other ways to sign in leave nothing to read. */
async function geminiLogin(context: LoginContext): Promise<AgentLogin | undefined> {
  const dir = join(configDir("gemini", context, context.home), ".gemini");
  const accounts = await readJson(join(dir, "google_accounts.json"));
  const email = text(accounts?.active);
  if (email || (await isFile(join(dir, "oauth_creds.json")))) return { status: "signed-in", ...withEmail(email) };
  if (context.env.GEMINI_API_KEY?.trim()) return { status: "signed-in", method: "api-key" };
  return undefined;
}

/** Droid keeps its login in an encrypted keyring file in ~/.factory, or takes a key from FACTORY_API_KEY. */
async function droidLogin(context: LoginContext): Promise<AgentLogin> {
  const dir = join(context.home, ".factory");
  const names = await readdir(dir).catch(() => [] as string[]);
  if (names.some((name) => /^auth(\.|$)/u.test(name))) return { status: "signed-in", method: "subscription" };
  if (context.env.FACTORY_API_KEY?.trim()) return { status: "signed-in", method: "api-key" };
  return { status: "signed-out" };
}

/**
 * OpenCode lists every provider it is signed in to in auth.json under its data folder. OAuth entries are
 * subscriptions; the rest are keys. With no file it still runs its free models, so ZLI cannot tell.
 */
async function openCodeLogin(context: LoginContext): Promise<AgentLogin | undefined> {
  const data = context.env.XDG_DATA_HOME?.trim() || join(context.home, ".local", "share");
  const auth = await readJson(join(data, "opencode", "auth.json"));
  if (!auth) return undefined;
  const entries = Object.values(auth).map(record);
  if (entries.length === 0) return { status: "signed-out" };
  const oauth = entries.some((entry) => entry?.type === "oauth");
  return { status: "signed-in", method: oauth ? "subscription" : "api-key" };
}

/** Kimi Code saves its OAuth token as a JSON file in the credentials folder of its home. */
async function kimiLogin(context: LoginContext): Promise<AgentLogin> {
  const dir = join(configDir("kimi", context, join(context.home, ".kimi-code")), "credentials");
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    if (text((await readJson(join(dir, name)))?.access_token)) return { status: "signed-in", method: "subscription" };
  }
  return { status: "signed-out" };
}

/**
 * What `cursor-agent status` prints: "Logged in as kim@example.com", "Logged in (unable to fetch user
 * details)", or "Not logged in". Anything else is unknown.
 */
export function parseCursorStatus(output: string | undefined): AgentLogin | undefined {
  if (!output) return undefined;
  // Colour codes sit around whole lines, so the words still match without stripping them.
  if (/\bnot logged in\b/iu.test(output)) return { status: "signed-out" };
  const match = /\blogged in\b(?: as (\S+))?/iu.exec(output);
  if (!match) return undefined;
  return { status: "signed-in", method: "subscription", ...withEmail(match[1]?.replace(/[.,;]$/u, "")) };
}

/** The payload of a JWT, read without checking its signature: it only labels the account. */
export function jwtClaims(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    return record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

function withEmail(value: string | undefined): { email?: string } {
  return value?.includes("@") && value.length <= 320 ? { email: value } : {};
}

function withPlan(value: string | undefined): { plan?: string } {
  return value && value.length <= 40 ? { plan: value } : {};
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  const contents = await readFile(path, "utf8").catch(() => undefined);
  if (contents === undefined) return undefined;
  try {
    return record(JSON.parse(contents));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isFile(),
    () => false,
  );
}
