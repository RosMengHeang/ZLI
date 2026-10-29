import type { PlanLimitProvider } from "@zli-v2/contracts";

import { readClaudeLimits } from "./claudeLimits.js";
import { type CodexLimitClient, readCodexLimits } from "./codexLimits.js";
import { readCursorLimits } from "./cursorLimits.js";
import { readDroidLimits } from "./droidLimits.js";
import { findGeminiOAuthClient, readGeminiLimits } from "./geminiLimits.js";
import { readKimiLimits } from "./kimiLimits.js";
import { openCodeCredentials, readOpenCodeLimits } from "./openCodeLimits.js";
import type { LimitRead, LimitReader, LimitTarget } from "./PlanLimits.js";
import { defaultLimitReaderDeps, keyringSecret, runCli } from "./readerDeps.js";

/** Reads each provider's limits the way its own CLI stores the login. */
export function planLimitReader(options: {
  home: string;
  /** The installed CLI's path, or undefined when it is not installed. */
  resolveCli(provider: PlanLimitProvider): Promise<string | undefined>;
  connectCodex(command: string, codexHome: string | undefined): Promise<CodexLimitClient>;
}): LimitReader {
  const deps = defaultLimitReaderDeps(options.home);
  return async (target: LimitTarget): Promise<LimitRead> => {
    switch (target.provider) {
      case "claude-code":
        return readClaudeLimits(target.configDir ?? process.env.CLAUDE_CONFIG_DIR, deps);
      case "codex": {
        const command = await options.resolveCli("codex");
        if (!command) return { state: "unavailable", message: "Codex is not installed.", windows: [] };
        return readCodexLimits(() => options.connectCodex(command, target.configDir));
      }
      case "gemini":
        return readGeminiLimits(target.configDir ?? process.env.GEMINI_CLI_HOME, {
          ...deps,
          oauthClient: async () => {
            const command = await options.resolveCli("gemini");
            return command ? findGeminiOAuthClient(command) : undefined;
          },
        });
      case "cursor-agent":
        return readCursorLimits(target.configDir, deps);
      case "droid":
        return readDroidLimits({
          ...deps,
          secretStore: (service, account) => keyringSecret(deps, service, account),
          // Droid's own auth check renews an expired sign-in through Droid, which saves the new tokens.
          refreshLogin: async () => {
            const command = await options.resolveCli("droid");
            if (command) await runCli(command, ["doctor", "--checks", "auth", "--json"]);
          },
        });
      case "kimi":
        return readKimiLimits(target.configDir, deps);
      case "opencode":
        return readOpenCodeLimits({ ...deps, credentials: openCodeCredentials });
    }
  };
}
