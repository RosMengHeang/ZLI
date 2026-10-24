import {
  type ListedProviderKind,
  type PermissionMode,
  type ProjectProjection,
  type RpcResponse,
  type RuntimeProjection,
  type WorktreeProjection,
  worktreeHasLiveThread,
} from "@zli-v2/contracts";

import { providerDisplayName } from "../agent/providers.js";
import { makeCommandId } from "../runtime/commandId.js";
import type { SessionMode } from "./sessions.js";

export type Dispatch = (request: unknown) => Promise<RpcResponse | undefined>;

export type Placement =
  | { kind: "new"; branch: string; baseRef: string }
  | { kind: "checkout" }
  | { kind: "existing"; worktreeId: string };

export type LaunchOptions = {
  provider: ListedProviderKind;
  mode: SessionMode;
  model?: string;
  permissionMode: PermissionMode;
  /** Unset when the agent has no saved accounts, so it starts with the usual login. */
  accountId?: string;
};

export function shellForPlatform(): string {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Windows") ? "powershell.exe" : "/bin/bash";
}

export function safeBranchName(branch: string): string {
  return branch
    .trim()
    .replace(/[^a-zA-Z0-9._/-]/gu, "-")
    .replace(/^[-/]+|[-/]+$/gu, "");
}

export function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
  return normalize(left) === normalize(right);
}

/** The project's own working copy, if it is already in the workspace. */
export function checkoutWorktree(
  projection: Pick<RuntimeProjection, "worktrees">,
  project: ProjectProjection,
): WorktreeProjection | undefined {
  return projection.worktrees.find(
    (worktree) =>
      worktree.projectId === project.projectId &&
      worktree.status !== "cancelled" &&
      (worktree.kind === "checkout" || samePath(worktree.path, project.path)),
  );
}

export async function createWorktree(
  dispatch: Dispatch,
  project: ProjectProjection,
  branch: string,
  baseRef: string,
): Promise<{ worktreeId: string } | { error: string }> {
  const safeBranch = safeBranchName(branch);
  if (!safeBranch) return { error: "Choose a branch name before creating a worktree." };
  const worktreeId = makeCommandId();
  const workspaceRoot = `${project.path.replace(/[\\/]+$/u, "")}-worktrees`;
  const response = await dispatch({
    protocolVersion: 1,
    commandId: makeCommandId(),
    command: {
      type: "worktree.create",
      worktreeId,
      projectId: project.projectId,
      path: `${workspaceRoot}/${safeBranch.replace(/[\\/]/gu, "-")}`,
      workspaceRoot,
      branch: safeBranch,
      ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}),
    },
  });
  if (response?.accepted === false) return { error: response.error.message };
  return { worktreeId };
}

export async function ensureCheckout(
  dispatch: Dispatch,
  projection: Pick<RuntimeProjection, "worktrees">,
  project: ProjectProjection,
): Promise<{ worktreeId: string; path: string } | { error: string }> {
  const existing = checkoutWorktree(projection, project);
  if (existing) return { worktreeId: existing.worktreeId, path: existing.path };
  const worktreeId = makeCommandId();
  const response = await dispatch({
    protocolVersion: 1,
    commandId: makeCommandId(),
    command: {
      type: "worktree.import",
      worktreeId,
      projectId: project.projectId,
      path: project.path,
      // The runtime replaces this with the checked-out branch once it reads the repository.
      branch: "HEAD",
      kind: "checkout",
    },
  });
  if (response?.accepted === false) return { error: response.error.message };
  return { worktreeId, path: project.path };
}

/** Opens a terminal tile that runs the agent's own sign-in with an account's private config folder. */
export async function startAccountSignIn(
  dispatch: Dispatch,
  projection: Pick<RuntimeProjection, "providers">,
  input: { provider: ListedProviderKind; accountId: string; sessionId: string; worktreeId: string; cwd: string },
): Promise<string | undefined> {
  const command = {
    type: "terminal.create",
    terminalId: makeCommandId(),
    worktreeId: input.worktreeId,
    cwd: input.cwd,
    shell: shellForPlatform(),
    title: `Sign in to ${providerDisplayName(input.provider, projection.providers)}`,
    cols: 120,
    rows: 32,
    sessionId: input.sessionId,
    agent: { provider: input.provider, accountId: input.accountId, login: true },
  };
  try {
    const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
    return response?.accepted === false ? response.error.message : undefined;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "The sign-in could not start.";
  }
}

/** Starts the agent for a session in a worktree that is ready. */
export async function startSessionAgent(
  dispatch: Dispatch,
  projection: Pick<RuntimeProjection, "threads" | "providers">,
  input: LaunchOptions & { sessionId: string; worktreeId: string; cwd: string },
): Promise<string | undefined> {
  const command =
    input.mode === "chat"
      ? {
          type: "thread.start",
          threadId: makeCommandId(),
          worktreeId: input.worktreeId,
          provider: input.provider,
          cwd: input.cwd,
          sessionId: input.sessionId,
          permissionMode: input.permissionMode,
          ...(input.model ? { model: input.model } : {}),
          ...(input.accountId ? { accountId: input.accountId } : {}),
          // The person picked this placement, so a second agent in the same checkout is intended.
          ...(worktreeHasLiveThread(projection.threads, input.worktreeId) ? { shareWorktree: true } : {}),
        }
      : {
          type: "terminal.create",
          terminalId: makeCommandId(),
          worktreeId: input.worktreeId,
          cwd: input.cwd,
          shell: shellForPlatform(),
          title: providerDisplayName(input.provider, projection.providers),
          cols: 120,
          rows: 32,
          sessionId: input.sessionId,
          agent: {
            provider: input.provider,
            permissionMode: input.permissionMode,
            ...(input.model ? { model: input.model } : {}),
            ...(input.accountId ? { accountId: input.accountId } : {}),
          },
        };
  try {
    const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
    return response?.accepted === false ? response.error.message : undefined;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "The agent could not start.";
  }
}
