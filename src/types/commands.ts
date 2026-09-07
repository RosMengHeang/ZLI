/** Canonical Tauri command and event names. Git names match `src-tauri/src/git/commands.rs`. */

export const GIT_COMMANDS = {
  validateRepository: "git_validate_repository",
  createWorktree: "git_create_worktree",
  listWorktrees: "git_list_worktrees",
  removeWorktree: "git_remove_worktree",
  deleteBranch: "git_delete_branch",
  status: "git_status",
  diff: "git_diff",
  commit: "git_commit",
  merge: "git_merge",
  abortMerge: "git_abort_merge",
} as const;

/** PTY / agent commands owned by the terminal backend engineer. */
export const PTY_COMMANDS = {
  create: "pty_create",
  write: "pty_write",
  resize: "pty_resize",
  close: "pty_close",
  kill: "pty_kill",
} as const;

export const AGENT_COMMANDS = {
  listProviders: "list_agent_providers",
  detectProviders: "detect_agent_providers",
  launch: "launch_agent",
  stop: "stop_agent",
  list: "list_agents",
} as const;

export const PTY_EVENTS = {
  output: "pty-output",
  status: "pty-status",
  exit: "pty-exit",
  error: "pty-error",
} as const;

export interface PtyOutputPayload {
  id: string;
  data: string | number[];
}

export interface PtyExitPayload {
  id: string;
  exitCode: number | null;
}

export interface PtyErrorPayload {
  id: string;
  message: string;
}
