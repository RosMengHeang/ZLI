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
  "thread.respond",
  "thread.user-input",
  "worktree.create",
  "terminal.create",
  "terminal.write",
  "terminal.resize",
  "terminal.read",
  "terminal.attach",
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

type PolicyProjection = Pick<RuntimeProjection, "projects" | "worktrees"> | undefined;

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
      // Attachments can name any file on the desktop by path, so phones send text only.
      return command.attachments?.length ? "Phones cannot send attachments." : undefined;
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
    case "worktree.create": {
      const project = projection?.projects.find((candidate) => candidate.projectId === command.projectId);
      if (!project) return "That project does not exist.";
      const root = worktreeRoot(project.path);
      if (!samePath(command.workspaceRoot, root)) return "New worktrees go in the project's worktrees folder.";
      if (!isDirectChild(root, command.path)) return "New worktrees go in the project's worktrees folder.";
      return undefined;
    }
    default:
      return undefined;
  }
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
