import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ListedProviderKind } from "@zli-v2/contracts";

/**
 * The variable that moves each CLI's config and login to another directory. Sources:
 * Codex CODEX_HOME (developers.openai.com/codex/environment-variables), Claude Code CLAUDE_CONFIG_DIR
 * (code.claude.com/docs/en/env-vars), Cursor CURSOR_CONFIG_DIR (cursor.com/docs/cli/reference/configuration),
 * Gemini GEMINI_CLI_HOME (geminicli.com/docs/reference/configuration), Copilot COPILOT_HOME
 * (docs.github.com copilot-cli config dir reference), Kimi KIMI_CODE_HOME (kimi.com/code/docs env-vars),
 * Qwen QWEN_HOME (packages/core/src/config/storage.ts in QwenLM/qwen-code).
 */
export const CONFIG_DIR_ENV: Partial<Record<ListedProviderKind, string>> = {
  codex: "CODEX_HOME",
  "claude-code": "CLAUDE_CONFIG_DIR",
  "cursor-agent": "CURSOR_CONFIG_DIR",
  gemini: "GEMINI_CLI_HOME",
  copilot: "COPILOT_HOME",
  kimi: "KIMI_CODE_HOME",
  qwen: "QWEN_HOME",
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
      default:
        return "not-checked";
    }
  } catch {
    return "not-checked";
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
