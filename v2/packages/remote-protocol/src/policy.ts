import { ClientWireMessage, type RpcRequest, type RuntimeCommand, type RuntimeProjection } from "@zli-v2/contracts";

/**
 * Commands a paired phone may send. This is an allowlist: a command type added to the runtime stays
 * blocked for phones until it is listed here. Runtime-internal reports (thread.status, thread.message,
 * worktree.status, browser.*, and the rest) are what the runtime itself records, so a phone that could
 * send them could forge history.
 */
export const PHONE_COMMANDS = [
  "thread.start",
  "thread.send",
  "thread.queue",
  "thread.queue.remove",
  "thread.steer",
  "thread.interrupt",
  "thread.stop",
  "thread.rename",
  "thread.respond",
  "thread.user-input",
  "session.delete",
  "worktree.create",
  "worktree.import",
  "terminal.create",
  "terminal.write",
  "terminal.resize",
  "terminal.read",
  "terminal.attach",
  "terminal.stop",
  "review.refresh",
  "review.commit",
  "review.git.branches",
  "review.pr.push",
  "files.diff",
] as const satisfies readonly RuntimeCommand["type"][];

export type PhoneCommandType = (typeof PHONE_COMMANDS)[number];

const phoneCommands = new Set<string>(PHONE_COMMANDS);

export function isPhoneCommand(type: string): type is PhoneCommandType {
  return phoneCommands.has(type);
}

export type PhoneMessageDecision =
  | { kind: "forward"; message: ClientWireMessage }
  | { kind: "reject"; commandId: string; reason: string }
  | { kind: "invalid"; reason: string };

/** What the policy reads to check where a command points. */
export type PhonePolicyProjection = Pick<RuntimeProjection, "projects" | "worktrees" | "reviews">;

type PolicyProjection = PhonePolicyProjection | undefined;

/**
 * Decides what the gateway does with one decrypted message from a phone. `forward` passes it to the
 * runtime, `reject` answers the command with an error, and `invalid` closes the connection, because a
 * well-behaved phone app never sends a message that does not parse.
 */
export function checkPhoneMessage(input: unknown, projection: PolicyProjection): PhoneMessageDecision {
  const parsed = ClientWireMessage.safeParse(input);
  if (!parsed.success) return { kind: "invalid", reason: "The message does not match the runtime protocol." };
  const message = parsed.data;
  switch (message.type) {
    case "hello":
      // The gateway sends its own hello upstream; a phone never holds the runtime token.
      return { kind: "invalid", reason: "Phones do not send a runtime hello directly." };
    case "subscribe":
    case "projection.get":
    case "terminal.attach":
      return { kind: "forward", message };
    case "command": {
      const reason = commandRejection(message.request, projection);
      return reason === undefined
        ? { kind: "forward", message }
        : { kind: "reject", commandId: message.request.commandId, reason };
    }
  }
}

function commandRejection(request: RpcRequest, projection: PolicyProjection): string | undefined {
  const command = request.command;
  if (!isPhoneCommand(command.type)) return `Phones cannot send ${command.type}.`;
  switch (command.type) {
    case "thread.send":
    case "thread.queue":
      // A path attachment can name any file on the desktop, so phones send the file's bytes instead.
      return command.attachments?.some((attachment) => attachment.path !== undefined)
        ? "Phones send attachments as file contents, not desktop paths."
        : undefined;
    case "thread.start": {
      const worktree = projection?.worktrees.find((candidate) => candidate.worktreeId === command.worktreeId);
      if (!worktree) return "That worktree does not exist.";
      if (!samePath(worktree.path, command.cwd)) return "An agent started from a phone runs in its worktree folder.";
      return undefined;
    }
    case "terminal.create": {
      const worktree = projection?.worktrees.find((candidate) => candidate.worktreeId === command.worktreeId);
      if (!worktree) return "That worktree does not exist.";
      if (!samePath(worktree.path, command.cwd)) return "A terminal opened from a phone starts in its worktree folder.";
      if (command.agent || command.args?.length) return "Phones open interactive shells only.";
      return undefined;
    }
    case "worktree.import": {
      // Only the project's own folder, so an agent can work in the current checkout as on the desktop.
      const project = projection?.projects.find((candidate) => candidate.projectId === command.projectId);
      if (!project) return "That project does not exist.";
      if (command.kind !== "checkout" || !samePath(command.path, project.path)) {
        return "Phones can only add the project's own checkout.";
      }
      return undefined;
    }
    case "worktree.create": {
      const project = projection?.projects.find((candidate) => candidate.projectId === command.projectId);
      if (!project) return "That project does not exist.";
      const root = worktreeRoot(project.path);
      if (!samePath(command.workspaceRoot, root)) return "New worktrees go in the project's worktrees folder.";
      if (!isDirectChild(root, command.path)) return "New worktrees go in the project's worktrees folder.";
      return undefined;
    }
    case "review.refresh": {
      if (!hasWorktree(projection, command.worktreeId)) return "That worktree does not exist.";
      // Another base would change what the desktop's Changes panel compares against.
      const review = reviewOf(projection, command.worktreeId);
      if (command.baseRef !== "HEAD" && command.baseRef !== review?.baseRef) {
        return "Phones read changes against the last commit or the base the desktop already compares against.";
      }
      return undefined;
    }
    case "review.commit":
    case "review.git.branches":
    case "review.pr.push":
      return hasWorktree(projection, command.worktreeId) ? undefined : "That worktree does not exist.";
    case "files.diff": {
      if (!hasWorktree(projection, command.worktreeId)) return "That worktree does not exist.";
      // In a folder without Git history the diff of any file is its whole contents, so phones only
      // read files the review already lists as changed.
      const listed = reviewOf(projection, command.worktreeId)?.files.some((file) => file.path === command.path);
      return listed ? undefined : "Phones read diffs of changed files only.";
    }
    default:
      return undefined;
  }
}

function hasWorktree(projection: PolicyProjection, worktreeId: string): boolean {
  return projection?.worktrees.some((candidate) => candidate.worktreeId === worktreeId) ?? false;
}

function reviewOf(projection: PolicyProjection, worktreeId: string) {
  return projection?.reviews?.find((candidate) => candidate.worktreeId === worktreeId);
}

function trimSeparators(path: string): string {
  return path.replace(/[\\/]+$/u, "");
}

/** Windows paths reach the runtime with either separator, so both compare equal. */
function samePath(left: string, right: string): boolean {
  const normalize = (path: string) => trimSeparators(path).replaceAll("\\", "/");
  return normalize(left) === normalize(right);
}

/** The folder the desktop app creates worktrees in, next to the project folder. */
export function worktreeRoot(projectPath: string): string {
  return `${trimSeparators(projectPath)}-worktrees`;
}

function isDirectChild(root: string, path: string): boolean {
  if (!path.startsWith(root)) return false;
  const separator = path.charAt(root.length);
  if (separator !== "/" && separator !== "\\") return false;
  const name = path.slice(root.length + 1);
  return name.length > 0 && !/[\\/]/u.test(name) && name !== "." && name !== "..";
}
