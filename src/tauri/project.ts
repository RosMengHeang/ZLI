import { open } from "@tauri-apps/plugin-dialog";
import { basename } from "../lib/format";
import { toAppError } from "../lib/errors";
import type { ProjectInfo, RepositoryInfo } from "../types";
import { GIT_COMMANDS } from "../types/commands";
import { invokeCmd, isTauriRuntime } from "./invoke";

const PICKER_UNAVAILABLE = {
  code: "plugin_unavailable",
  message: "Folder picker is unavailable. Enter a repository path instead.",
};

export async function pickProjectDirectory(): Promise<string | null> {
  if (!isTauriRuntime()) {
    throw PICKER_UNAVAILABLE;
  }
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open Project",
    });
    if (selected === null || selected === undefined) return null;
    if (Array.isArray(selected)) return selected[0] ?? null;
    return selected;
  } catch (err) {
    const parsed = toAppError(err);
    if (/invoke/i.test(parsed.message) || parsed.code === "plugin_unavailable") {
      throw PICKER_UNAVAILABLE;
    }
    throw parsed;
  }
}

export async function validateRepository(path: string): Promise<RepositoryInfo> {
  return invokeCmd<RepositoryInfo>(GIT_COMMANDS.validateRepository, { path });
}

export function repositoryToProject(info: RepositoryInfo): ProjectInfo {
  const path = info.path || info.repositoryRoot;
  return {
    path,
    name: basename(path),
    repositoryRoot: info.repositoryRoot,
    currentBranch: info.currentBranch ?? (info.detachedHead ? "HEAD" : "unknown"),
    baseBranch: info.baseBranch ?? info.currentBranch ?? "main",
    detachedHead: info.detachedHead,
    clean: info.clean,
  };
}
