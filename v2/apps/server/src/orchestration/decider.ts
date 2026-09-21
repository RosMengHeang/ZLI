import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

import {
  ProjectId,
  type ProjectProjection,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeProjection,
} from "@zli-v2/contracts";

export type DomainErrorCode =
  | "project_exists"
  | "project_missing"
  | "worktree_exists"
  | "worktree_missing"
  | "terminal_exists"
  | "terminal_missing"
  | "unsupported_command";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export type ProjectRegisteredDecision = {
  type: "project.registered";
  project: ProjectProjection;
};

export type DomainDecision = Extract<
  RuntimeEvent,
  {
    type:
      | "project.registered"
      | "worktree.create.requested"
      | "worktree.status.changed"
      | "worktree.remove.requested"
      | "worktree.archive.requested"
      | "worktree.removed"
      | "worktree.archived"
      | "terminal.create.requested"
      | "terminal.write.requested"
      | "terminal.resize.requested"
      | "terminal.stop.requested"
      | "review.refresh.requested"
      | "review.commit.requested"
      | "review.merge.requested"
      | "review.abortMerge.requested"
      | "review.updated"
      | "review.archived"
      | "terminal.status.changed";
  }
>;

export function decide(
  projection: RuntimeProjection,
  command: RuntimeCommand,
): DomainDecision[] {
  switch (command.type) {
    case "project.register": {
      const path = canonicalPath(command.path);
      if (projection.projects.some((project) => canonicalPath(project.path) === path)) {
        throw new DomainError("project_exists", `Project is already registered: ${command.path}`);
      }
      const projectId = ProjectId.parse(stableProjectId(path));
      return [
        {
          type: "project.registered",
          project: {
            projectId,
            path: command.path,
            name: projectName(command.path),
          },
        },
      ];
    }
    case "worktree.create": {
      const project = projection.projects.find((entry) => entry.projectId === command.projectId);
      if (!project) throw new DomainError("project_missing", `Project does not exist: ${command.projectId}`);
      if (projection.worktrees.some((worktree) => worktree.worktreeId === command.worktreeId)) {
        throw new DomainError("worktree_exists", `Worktree already exists: ${command.worktreeId}`);
      }
      return [
        {
          type: "worktree.create.requested",
          workspaceRoot: command.workspaceRoot,
          ...(command.baseRef ? { baseRef: command.baseRef } : {}),
          ...(command.checkoutExistingBranch ? { checkoutExistingBranch: true } : {}),
          worktree: {
            worktreeId: command.worktreeId,
            projectId: command.projectId,
            path: command.path,
            branch: command.branch,
            status: "queued",
          },
        },
      ];
    }
    case "worktree.status":
      assertWorktree(projection, command.worktreeId);
      return [
        {
          type: "worktree.status.changed",
          worktreeId: command.worktreeId,
          status: command.status,
          ...(command.errorMessage ? { errorMessage: command.errorMessage } : {}),
        },
      ];
    case "worktree.cancel":
      assertWorktree(projection, command.worktreeId);
      return [{ type: "worktree.status.changed", worktreeId: command.worktreeId, status: "cancelling" }];
    case "worktree.retry":
      assertWorktree(projection, command.worktreeId);
      return [{ type: "worktree.status.changed", worktreeId: command.worktreeId, status: "queued" }];
    case "worktree.remove":
      assertWorktree(projection, command.worktreeId);
      return [{ type: "worktree.remove.requested", worktreeId: command.worktreeId, force: command.force ?? false }];
    case "worktree.archive":
      assertWorktree(projection, command.worktreeId);
      return [{ type: "worktree.archive.requested", worktreeId: command.worktreeId }];
    case "worktree.removed":
      assertWorktree(projection, command.worktreeId);
      return [{ type: "worktree.removed", worktreeId: command.worktreeId }];
    case "worktree.archived":
      assertWorktree(projection, command.worktreeId);
      return [{ type: "worktree.archived", worktreeId: command.worktreeId }];
    case "terminal.create": {
      if (!projection.worktrees.some((worktree) => worktree.worktreeId === command.worktreeId)) {
        throw new DomainError("worktree_missing", `Worktree does not exist: ${command.worktreeId}`);
      }
      if (projection.terminals.some((terminal) => terminal.terminalId === command.terminalId)) {
        throw new DomainError("terminal_exists", `Terminal already exists: ${command.terminalId}`);
      }
      return [
        {
          type: "terminal.create.requested",
          terminal: {
            terminalId: command.terminalId,
            worktreeId: command.worktreeId,
            title: command.title,
            status: "starting",
            lastSequence: 0,
          },
          cwd: command.cwd,
          shell: command.shell,
          cols: command.cols,
          rows: command.rows,
        },
      ];
    }
    case "terminal.write":
      assertTerminal(projection, command.terminalId);
      return [{ type: "terminal.write.requested", terminalId: command.terminalId, data: command.data }];
    case "terminal.resize":
      assertTerminal(projection, command.terminalId);
      return [
        {
          type: "terminal.resize.requested",
          terminalId: command.terminalId,
          cols: command.cols,
          rows: command.rows,
        },
      ];
    case "terminal.stop":
      assertTerminal(projection, command.terminalId);
      return [{ type: "terminal.stop.requested", terminalId: command.terminalId }];
    case "terminal.status":
      assertTerminal(projection, command.terminalId);
      return [
        {
          type: "terminal.status.changed",
          terminalId: command.terminalId,
          status: command.status,
          ...(command.lastSequence === undefined ? {} : { lastSequence: command.lastSequence }),
          ...(command.errorMessage ? { errorMessage: command.errorMessage } : {}),
        },
      ];
    case "terminal.attach":
    case "terminal.list":
      return [];
    case "review.refresh":
      assertWorktree(projection, command.worktreeId);
      return [{ type: "review.refresh.requested", worktreeId: command.worktreeId, baseRef: command.baseRef }];
    case "review.commit":
      assertWorktree(projection, command.worktreeId);
      return [{ type: "review.commit.requested", worktreeId: command.worktreeId, message: command.message }];
    case "review.merge":
      assertWorktree(projection, command.worktreeId);
      assertSafeRef(command.targetRef);
      return [{ type: "review.merge.requested", worktreeId: command.worktreeId, targetRef: command.targetRef }];
    case "review.abortMerge":
      assertWorktree(projection, command.worktreeId);
      return [{ type: "review.abortMerge.requested", worktreeId: command.worktreeId }];
    case "review.updated":
      assertWorktree(projection, command.review.worktreeId);
      return [{ type: "review.updated", review: command.review }];
    case "review.archive":
      assertWorktree(projection, command.worktreeId);
      return [{ type: "review.archived", worktreeId: command.worktreeId }];
    default:
      throw new DomainError("unsupported_command", `Command ${command.type} is not a domain mutation.`);
  }
}

function assertWorktree(projection: RuntimeProjection, worktreeId: string): void {
  if (!projection.worktrees.some((worktree) => worktree.worktreeId === worktreeId)) {
    throw new DomainError("worktree_missing", `Worktree does not exist: ${worktreeId}`);
  }
}

function assertTerminal(projection: RuntimeProjection, terminalId: string): void {
  if (!projection.terminals.some((terminal) => terminal.terminalId === terminalId)) {
    throw new DomainError("terminal_missing", `Terminal does not exist: ${terminalId}`);
  }
}

function assertSafeRef(ref: string): void {
  if (!ref || ref.startsWith("-") || ref.includes("\0") || ref.includes("\\") || /(^|\/)\.\.?($|\/)/u.test(ref) || /[~^:?*\[]/u.test(ref) || ref.endsWith(".lock") || ref.endsWith(".")) {
    throw new DomainError("unsupported_command", `Unsafe Git ref: ${ref}`);
  }
}

export function canonicalPath(path: string): string {
  const normalized = path.replaceAll("/", "\\");
  return win32.normalize(normalized).replace(/[\\/]$/, "").toLowerCase();
}

function projectName(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const name = posix.basename(normalized);
  return name || normalized;
}

function stableProjectId(path: string): `${string}-${string}-${string}-${string}-${string}` {
  const bytes = createHash("sha256").update(path).digest("hex").slice(0, 32).split("");
  bytes[12] = "4";
  bytes[16] = ((Number.parseInt(bytes[16] ?? "8", 16) & 0x3) | 0x8).toString(16);
  const hex = bytes.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
