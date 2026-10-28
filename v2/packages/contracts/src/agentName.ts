import { z } from "zod";

export const MAX_AGENT_NAME_LENGTH = 40;

/**
 * A name the person gives an agent, such as "Bob". Agents use it in place of an id. A slash is not
 * allowed because `project/name` refers to an agent in another project.
 */
export const AgentName = z
  .string()
  .trim()
  .min(1, "Give the agent a name.")
  .max(MAX_AGENT_NAME_LENGTH, `Keep the name to ${MAX_AGENT_NAME_LENGTH} characters.`)
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u,
    "Use letters, digits, spaces, dots, dashes, or underscores, starting with a letter or digit.",
  );
export type AgentName = z.infer<typeof AgentName>;

/**
 * The thread or terminal id of the agent that started this one through the agent tools, which makes
 * this one its sub-agent. Agents the person starts have none.
 */
export const StartedBy = z.string().min(1).max(200);
export type StartedBy = z.infer<typeof StartedBy>;

/** Names compare without case and with runs of spaces counted as one, so "Bob" and "bob" clash. */
export function agentNameKey(name: string): string {
  return name.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

/** Chat threads that still show up as agents. A stopped thread is gone until it resumes. */
export function isListedThreadStatus(status: string): boolean {
  return status !== "stopped";
}

/** Terminal agents that are still running their CLI. */
export function isListedTerminalStatus(status: string): boolean {
  return status === "starting" || status === "running";
}

type NamedAgentState = {
  readonly worktrees: readonly { readonly worktreeId: string; readonly projectId: string }[];
  readonly threads: readonly {
    readonly threadId: string;
    readonly worktreeId: string;
    readonly status: string;
    readonly name?: string | undefined;
  }[];
  readonly terminals: readonly {
    readonly terminalId: string;
    readonly worktreeId: string;
    readonly status: string;
    readonly agent?: unknown;
    readonly name?: string | undefined;
  }[];
};

/**
 * True when another listed agent in the project already has this name. Names only have to be unique
 * within a project, since agents in other projects are always reached as `project/name`.
 */
export function agentNameTaken(
  state: NamedAgentState,
  options: { projectId: string; name: string; exceptId?: string },
): boolean {
  const key = agentNameKey(options.name);
  const inProject = new Set(
    state.worktrees.filter((worktree) => worktree.projectId === options.projectId).map((w) => w.worktreeId),
  );
  const clashes = (id: string, worktreeId: string, name: string | undefined) =>
    id !== options.exceptId && name !== undefined && inProject.has(worktreeId) && agentNameKey(name) === key;
  return (
    state.threads.some(
      (thread) => isListedThreadStatus(thread.status) && clashes(thread.threadId, thread.worktreeId, thread.name),
    ) ||
    state.terminals.some(
      (terminal) =>
        terminal.agent !== undefined &&
        isListedTerminalStatus(terminal.status) &&
        clashes(terminal.terminalId, terminal.worktreeId, terminal.name),
    )
  );
}

/** Sets or clears a thread's or terminal's name, as the projections fold a rename. */
export function withAgentName<T extends { name?: string | undefined; updatedAt?: string | undefined }>(
  record: T,
  name: string | undefined,
  updatedAt: string,
): T {
  const { name: _previous, ...rest } = record;
  return { ...rest, ...(name !== undefined ? { name } : {}), updatedAt } as T;
}
