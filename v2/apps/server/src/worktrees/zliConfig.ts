import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { MAX_ZLI_CONFIG_BYTES, type ProjectConfigResult, parseZliConfig, ZLI_CONFIG_FILE } from "@zli-v2/contracts";

/** Pins an exact, ordered list of setup commands. Trust is granted per project per hash. */
export function setupCommandsHash(commands: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(commands)).digest("hex");
}

/** Reads zli.json from the root of `repoPath`. A missing file is normal; anything unreadable is reported. */
export async function readZliConfig(repoPath: string): Promise<ProjectConfigResult> {
  let text: string;
  try {
    const handle = await open(join(repoPath, ZLI_CONFIG_FILE), "r");
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) return { status: "invalid", message: "zli.json is not a file." };
      if (stats.size > MAX_ZLI_CONFIG_BYTES) {
        return { status: "invalid", message: `zli.json is larger than ${MAX_ZLI_CONFIG_BYTES / 1024} KB.` };
      }
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "missing" };
    if (code === "EISDIR") return { status: "invalid", message: "zli.json is not a file." };
    return {
      status: "invalid",
      message: `zli.json could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
  const parsed = parseZliConfig(text.replace(/^\uFEFF/u, ""));
  if (!parsed.ok) return { status: "invalid", message: parsed.message };
  const commands = parsed.config.worktree?.setup ?? [];
  return {
    status: "valid",
    config: parsed.config,
    ...(commands.length > 0 ? { commandsHash: setupCommandsHash(commands) } : {}),
  };
}
