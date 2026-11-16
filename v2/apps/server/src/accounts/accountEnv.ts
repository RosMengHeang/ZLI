import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ListedProviderKind } from "@zli-v2/contracts";

/**
 * The variable that moves each CLI's config and login to another directory. Sources:
 * Codex CODEX_HOME (developers.openai.com/codex/environment-variables), Claude Code CLAUDE_CONFIG_DIR
 * (code.claude.com/docs/en/env-vars), Cursor CURSOR_CONFIG_DIR (cursor.com/docs/cli/reference/configuration),
 * Gemini GEMINI_CLI_HOME (geminicli.com/docs/reference/configuration), Copilot COPILOT_HOME
 * (docs.github.com copilot-cli config dir reference), Kimi KIMI_CODE_HOME (kimi.com/code/docs env-vars),
 * Qwen QWEN_HOME (packages/core/src/config/storage.ts in QwenLM/qwen-code), Grok GROK_HOME (user guide
 * 05-configuration.md, shipped in ~/.grok/docs).
 */
export const CONFIG_DIR_ENV: Partial<Record<ListedProviderKind, string>> = {
  codex: "CODEX_HOME",
  "claude-code": "CLAUDE_CONFIG_DIR",
  "cursor-agent": "CURSOR_CONFIG_DIR",
  gemini: "GEMINI_CLI_HOME",
  copilot: "COPILOT_HOME",
  kimi: "KIMI_CODE_HOME",
  qwen: "QWEN_HOME",
  grok: "GROK_HOME",
};

/**
 * Variables a sign-in account adds beside its config directory. Grok's updater installs into
 * GROK_HOME/bin, so without this an account folder could fill with its own copy of Grok.
 */
export const SIGN_IN_EXTRA_ENV: Partial<Record<ListedProviderKind, Readonly<Record<string, string>>>> = {
  grok: { GROK_DISABLE_AUTOUPDATER: "1" },
};

/**
 * The variable each CLI reads an API key from. Codex has none for its app server and TUI (CODEX_API_KEY
 * is for `codex exec` only), so a Codex key goes into auth.json in a private CODEX_HOME instead.
 */
export const API_KEY_ENV: Partial<Record<ListedProviderKind, string>> = {
  "claude-code": "ANTHROPIC_API_KEY",
  "cursor-agent": "CURSOR_API_KEY",
  droid: "FACTORY_API_KEY",
  gemini: "GEMINI_API_KEY",
  copilot: "COPILOT_GITHUB_TOKEN",
  grok: "XAI_API_KEY",
};

/**
 * Arguments that start each CLI's own sign-in. Claude Code, Gemini, and Qwen Code have no separate login
 * command; started with an empty config directory, they ask the person to sign in first.
 */
const LOGIN_ARGS: Partial<Record<ListedProviderKind, readonly string[]>> = {
  codex: ["login"],
  "claude-code": [],
  "cursor-agent": ["login"],
  gemini: [],
  copilot: ["login"],
  kimi: ["login"],
  qwen: [],
  grok: ["login"],
};

export function accountLoginArgs(provider: ListedProviderKind): string[] | undefined {
  const args = LOGIN_ARGS[provider];
  return args ? [...args] : undefined;
}

/** Files that exist only after a sign-in. Other CLIs keep their login where ZLI cannot look. */
export async function signInStatus(provider: ListedProviderKind, dir: string): Promise<"signed-in" | "not-checked"> {
  try {
    switch (provider) {
      case "codex":
        return (await isFile(join(dir, "auth.json"))) ? "signed-in" : "not-checked";
      case "claude-code": {
        // macOS keeps the token in the Keychain, but the account record lands in .claude.json everywhere.
        if (await isFile(join(dir, ".credentials.json"))) return "signed-in";
        const config = await readFile(join(dir, ".claude.json"), "utf8").catch(() => "");
        return config.includes('"oauthAccount"') ? "signed-in" : "not-checked";
      }
      case "gemini":
        return (await isFile(join(dir, ".gemini", "oauth_creds.json"))) ? "signed-in" : "not-checked";
      case "grok":
        return (await grokAuthEntries(dir)).length > 0 ? "signed-in" : "not-checked";
      default:
        return "not-checked";
    }
  } catch {
    return "not-checked";
  }
}

/**
 * The sign-ins in Grok's auth.json, one object per "issuer::id" key, each holding a refresh token or key.
 * Never returns tokens to callers outside the accounts code.
 */
export async function grokAuthEntries(dir: string): Promise<Array<Record<string, unknown>>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readFile(join(dir, "auth.json"), "utf8")).replace(/^﻿/u, ""));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  return Object.values(parsed).filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      ((typeof entry.refresh_token === "string" && entry.refresh_token.length > 0) ||
        (typeof entry.key === "string" && entry.key.length > 0)),
  );
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
