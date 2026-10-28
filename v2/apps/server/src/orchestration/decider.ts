import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

import {
  agentNameTaken,
  type PermissionMode,
  ProjectId,
  type ProjectProjection,
  parseDevServerUrl,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeProjection,
  type ThreadAttachment,
  type ThreadAttachmentUpload,
  type ThreadId,
  type ThreadProjection,
  type ThreadQueuedMessage,
  type TurnUsage,
  threadOccupiesWorktree,
} from "@zli-v2/contracts";

import { resolveTerminalCwd, TerminalCwdError } from "../terminal/terminalCwd.js";
import { NOT_GIT_WORKTREE_MESSAGE } from "../worktrees/WorktreeService.js";

export type DomainErrorCode =
  | "project_exists"
  | "project_missing"
  | "worktree_exists"
  | "worktree_missing"
  | "terminal_exists"
  | "terminal_missing"
  | "terminal_cwd_rejected"
  | "thread_exists"
  | "thread_missing"
  | "session_missing"
  | "worktree_occupied"
  | "agent_name_taken"
  | "agent_missing"
  | "a2a_cross_project"
  | "a2a_invalid_target"
  | "setup_not_waiting"
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
      | "project.archived"
      | "project.git.changed"
      | "project.renamed"
      | "worktree.create.requested"
      | "worktree.imported"
      | "worktree.status.changed"
      | "worktree.branch.changed"
      | "worktree.remove.requested"
      | "worktree.archive.requested"
      | "worktree.removed"
      | "worktree.archived"
      | "terminal.create.requested"
      | "terminal.write.requested"
      | "terminal.resize.requested"
      | "terminal.stop.requested"
      | "terminal.renamed"
      | "browser.updated"
      | "browser.closed"
      | "review.refresh.requested"
      | "review.diff.requested"
      | "review.commit.requested"
      | "review.merge.requested"
      | "review.abortMerge.requested"
      | "review.updated"
      | "review.archived"
      | "diagnostics.bundle.requested"
      | "diagnostics.bundle.created"
      | "diagnostics.bundle.failed"
      | "legacy.scan.requested"
      | "legacy.scan.completed"
      | "legacy.import.requested"
      | "legacy.import.completed"
      | "legacy.rollback.requested"
      | "legacy.rollback.completed"
      | "legacy.operation.failed"
      | "terminal.status.changed"
      | "thread.start.requested"
      | "thread.send.requested"
      | "thread.queued"
      | "thread.usage.recorded"
      | "thread.checkpoint.recorded"
      | "thread.queue.removed"
      | "thread.queue.prioritized"
      | "thread.a2a.delivered"
      | "thread.interrupt.requested"
      | "thread.stop.requested"
      | "thread.renamed"
      | "thread.resume.requested"
      | "session.deleted"
      | "thread.status.changed"
      | "thread.message.appended"
      | "thread.provider-session.recorded"
      | "thread.request.requested"
      | "thread.activity.updated"
      | "thread.request.resolved"
      | "thread.respond.requested"
      | "thread.user-input.requested"
      | "devserver.detected"
      | "devserver.stopped"
      | "worktree.setup.changed"
      | "worktree.setup.responded"
      | "project.setup.trusted";
  }
>;

const busyWorktreeStatuses = new Set<string>(["queued", "fetching", "creating", "bootstrapping", "cancelling"]);

export function decide(projection: RuntimeProjection, command: RuntimeCommand): DomainDecision[] {
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
    case "project.archive": {
      assertProject(projection, command.projectId);
      const worktrees = projection.worktrees.filter((worktree) => worktree.projectId === command.projectId);
      const worktreeIds = new Set<string>(worktrees.map((worktree) => worktree.worktreeId));
      if (worktrees.some((worktree) => busyWorktreeStatuses.has(worktree.status))) {
        throw new DomainError(
          "unsupported_command",
          "A worktree in this project is still being set up. Try again when it is ready.",
        );
      }
      const running =
        projection.terminals.some(
          (terminal) =>
            worktreeIds.has(terminal.worktreeId) && (terminal.status === "running" || terminal.status === "starting"),
        ) ||
        projection.threads.some(
          (thread) => worktreeIds.has(thread.worktreeId) && threadOccupiesWorktree(thread.status),
        );
      if (running) {
        throw new DomainError("unsupported_command", "Stop the agents and terminals in this project first.");
      }
      // Archiving only forgets the worktrees. Their folders, and the project's own folder, stay on disk.
      return [
        ...worktrees.map((worktree) => ({ type: "worktree.archived" as const, worktreeId: worktree.worktreeId })),
        { type: "project.archived", projectId: command.projectId },
      ];
    }
    case "project.git":
      assertProject(projection, command.projectId);
      return [{ type: "project.git.changed", projectId: command.projectId, git: command.git }];
    case "project.rename":
      assertProject(projection, command.projectId);
      return [{ type: "project.renamed", projectId: command.projectId, name: command.name }];
    case "worktree.create": {
      const project = projection.projects.find((entry) => entry.projectId === command.projectId);
      if (!project) throw new DomainError("project_missing", `Project does not exist: ${command.projectId}`);
      if (project.git === false) throw new DomainError("unsupported_command", NOT_GIT_WORKTREE_MESSAGE);
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
    case "worktree.import": {
      assertProject(projection, command.projectId);
      if (!win32.isAbsolute(command.path) && !posix.isAbsolute(command.path)) {
        throw new DomainError("unsupported_command", "Imported worktree path must be absolute.");
      }
      assertSafeRef(command.branch);
      if (projection.worktrees.some((worktree) => worktree.worktreeId === command.worktreeId)) {
        throw new DomainError("worktree_exists", `Worktree already exists: ${command.worktreeId}`);
      }
      if (
        command.kind === "checkout" &&
        projection.worktrees.some(
          (worktree) =>
            worktree.projectId === command.projectId && worktree.kind === "checkout" && worktree.status !== "cancelled",
        )
      ) {
        throw new DomainError("worktree_exists", "This project's checkout is already in the workspace.");
      }
      return [
        {
          type: "worktree.imported",
          worktree: {
            worktreeId: command.worktreeId,
            projectId: command.projectId,
            path: command.path,
            branch: command.branch,
            status: "ready",
            ...(command.kind ? { kind: command.kind } : {}),
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
          ...(command.branch ? { branch: command.branch } : {}),
        },
      ];
    case "worktree.branch": {
      assertWorktree(projection, command.worktreeId);
      assertSafeRef(command.branch);
      const current = projection.worktrees.find((worktree) => worktree.worktreeId === command.worktreeId);
      if (current?.branch === command.branch) return [];
      return [{ type: "worktree.branch.changed", worktreeId: command.worktreeId, branch: command.branch }];
    }
    case "worktree.cancel":
      assertWorktree(projection, command.worktreeId);
      return [{ type: "worktree.status.changed", worktreeId: command.worktreeId, status: "cancelling" }];
    case "worktree.retry":
      assertWorktree(projection, command.worktreeId);
      return [{ type: "worktree.status.changed", worktreeId: command.worktreeId, status: "queued" }];
    case "worktree.remove":
      assertWorktree(projection, command.worktreeId);
      return [
        {
          type: "worktree.remove.requested",
          worktreeId: command.worktreeId,
          force: command.force ?? false,
          ...(command.deleteBranch ? { deleteBranch: true } : {}),
        },
      ];
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
      const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === command.worktreeId);
      if (!worktree) {
        throw new DomainError("worktree_missing", `Worktree does not exist: ${command.worktreeId}`);
      }
      if (projection.terminals.some((terminal) => terminal.terminalId === command.terminalId)) {
        throw new DomainError("terminal_exists", `Terminal already exists: ${command.terminalId}`);
      }
      let cwd: string;
      try {
        cwd = resolveTerminalCwd(worktree.path, command.cwd);
      } catch (error) {
        if (error instanceof TerminalCwdError) throw new DomainError("terminal_cwd_rejected", error.message);
        throw error;
      }
      if (command.name !== undefined) {
        if (!command.agent) throw new DomainError("unsupported_command", "Only agent terminals take a name.");
        assertAgentNameFree(projection, worktree.projectId, command.name);
      }
      if (command.startedBy !== undefined) {
        if (!command.agent) throw new DomainError("unsupported_command", "Only agent terminals can be sub-agents.");
        assertStartedBy(projection, worktree.projectId, command.startedBy);
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
            kind: command.agent ? "agent" : "shell",
            ...(command.agent ? { agent: command.agent } : {}),
            ...(command.name !== undefined ? { name: command.name } : {}),
            ...(command.startedBy !== undefined ? { startedBy: command.startedBy } : {}),
            ...(command.sessionId ? { sessionId: command.sessionId } : {}),
          },
          cwd,
          worktreePath: worktree.path,
          shell: command.shell,
          cols: command.cols,
          rows: command.rows,
          ...(command.args ? { args: command.args } : {}),
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
    case "terminal.rename": {
      const terminal = projection.terminals.find((candidate) => candidate.terminalId === command.terminalId);
      if (!terminal) throw new DomainError("terminal_missing", `Terminal does not exist: ${command.terminalId}`);
      if (!terminal.agent) throw new DomainError("unsupported_command", "Only agent terminals take a name.");
      if (command.name !== null)
        assertAgentNameFree(
          projection,
          worktreeProjectId(projection, terminal.worktreeId),
          command.name,
          terminal.terminalId,
        );
      return [
        {
          type: "terminal.renamed",
          terminalId: command.terminalId,
          ...(command.name !== null ? { name: command.name } : {}),
        },
      ];
    }
    case "thread.start": {
      const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === command.worktreeId);
      if (!worktree) throw new DomainError("worktree_missing", `Worktree does not exist: ${command.worktreeId}`);
      if (projection.threads.some((thread) => thread.threadId === command.threadId)) {
        throw new DomainError("thread_exists", `Thread already exists: ${command.threadId}`);
      }
      // Existing threads that already share a worktree are left alone. Only this new bind is checked.
      const occupied = projection.threads.some(
        (thread) => thread.worktreeId === command.worktreeId && threadOccupiesWorktree(thread.status),
      );
      if (occupied && command.shareWorktree !== true) {
        throw new DomainError(
          "worktree_occupied",
          "This worktree already has a live agent. Start on a free worktree, or confirm sharing it.",
        );
      }
      if (command.name !== undefined) assertAgentNameFree(projection, worktree.projectId, command.name);
      if (command.startedBy !== undefined) assertStartedBy(projection, worktree.projectId, command.startedBy);
      return [
        {
          type: "thread.start.requested",
          // Bind the session to the worktree projection. A client cwd cannot move it.
          cwd: worktree.path,
          ...(command.shareWorktree === true ? { shareWorktree: true as const } : {}),
          thread: {
            threadId: command.threadId,
            worktreeId: command.worktreeId,
            provider: command.provider,
            status: "starting",
            capabilities: {},
            ...(command.permissionMode ? { permissionMode: command.permissionMode } : {}),
            ...(command.model ? { model: command.model } : {}),
            ...(command.name !== undefined ? { name: command.name } : {}),
            ...(command.startedBy !== undefined ? { startedBy: command.startedBy } : {}),
            ...(command.sessionId ? { sessionId: command.sessionId } : {}),
            ...(command.accountId ? { accountId: command.accountId } : {}),
          },
        },
      ];
    }
    case "thread.send": {
      assertThread(projection, command.threadId);
      return [sendRequested(projection, { ...command, attachments: storedAttachments(command.attachments) })];
    }
    case "thread.queue": {
      const thread = requireThread(projection, command.threadId);
      const ended = thread.status === "stopped" || thread.status === "failed";
      if (ended && !thread.providerSessionId)
        throw new DomainError("unsupported_command", "This agent has ended. Start a new chat to send it more.");
      const queue = queuedFor(projection, command.threadId);
      if (queue.some((queued) => queued.queueId === command.queueId)) return [];
      if (queue.length >= MAX_QUEUED_PER_THREAD)
        throw new DomainError(
          "unsupported_command",
          `An agent can hold up to ${MAX_QUEUED_PER_THREAD} queued messages.`,
        );
      // Rejected now so a queued change does not fail later, when nobody is watching.
      assertPermissionChange(thread, command.permissionMode);
      const attachments = storedAttachments(command.attachments);
      const message = {
        queueId: command.queueId,
        threadId: command.threadId,
        text: command.text,
        ...(command.model ? { model: command.model } : {}),
        ...(command.reasoningEffort ? { reasoningEffort: command.reasoningEffort } : {}),
        ...(command.permissionMode ? { permissionMode: command.permissionMode } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      if (ended) {
        const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === thread.worktreeId);
        if (!worktree) throw new DomainError("worktree_missing", "This chat's worktree is gone. Start a new chat.");
        // A stopped agent gives up its name, so another agent may hold it now. That agent keeps it and
        // this one comes back without a name, rather than refusing the message.
        const nameTaken =
          thread.name !== undefined &&
          agentNameTaken(projection, { projectId: worktree.projectId, name: thread.name, exceptId: thread.threadId });
        // The message waits in the queue and goes out once the resumed agent reports idle.
        return [
          ...(nameTaken ? [{ type: "thread.renamed" as const, threadId: command.threadId }] : []),
          { type: "thread.queued", message },
          { type: "thread.resume.requested", threadId: command.threadId, cwd: worktree.path },
        ];
      }
      if (!readyForNext(projection, thread)) return [{ type: "thread.queued", message }];
      if (queue.length === 0) return [sendRequested(projection, message)];
      return [{ type: "thread.queued", message }, ...sendQueued(projection, queue[0] as ThreadQueuedMessage)];
    }
    case "thread.queue.remove":
      requireThread(projection, command.threadId);
      if (!queuedFor(projection, command.threadId).some((queued) => queued.queueId === command.queueId)) return [];
      return [{ type: "thread.queue.removed", threadId: command.threadId, queueId: command.queueId }];
    case "thread.steer": {
      const thread = requireThread(projection, command.threadId);
      const queued = queuedFor(projection, command.threadId).find((entry) => entry.queueId === command.queueId);
      if (!queued) throw new DomainError("unsupported_command", "That message is no longer queued.");
      if (readyForNext(projection, thread)) return sendQueued(projection, queued);
      if (thread.status !== "working")
        throw new DomainError("unsupported_command", "Answer the agent's request first, then send this message.");
      return [
        { type: "thread.queue.prioritized", threadId: command.threadId, queueId: command.queueId },
        {
          type: "thread.interrupt.requested",
          threadId: command.threadId,
          ...(thread.activeTurnId ? { turnId: thread.activeTurnId } : {}),
        },
      ];
    }
    case "thread.queue.flush": {
      const thread = requireThread(projection, command.threadId);
      const [next] = queuedFor(projection, command.threadId);
      if (!next || !readyForNext(projection, thread)) return [];
      return sendQueued(projection, next);
    }
    case "thread.a2a":
      return [deliverAgentMessage(projection, command)];
    case "thread.interrupt":
      assertThread(projection, command.threadId);
      return [
        {
          type: "thread.interrupt.requested",
          threadId: command.threadId,
          ...(command.turnId ? { turnId: command.turnId } : {}),
        },
      ];
    case "thread.stop":
      assertThread(projection, command.threadId);
      return [{ type: "thread.stop.requested", threadId: command.threadId }];
    case "thread.rename": {
      const thread = requireThread(projection, command.threadId);
      if (command.name !== null)
        assertAgentNameFree(
          projection,
          worktreeProjectId(projection, thread.worktreeId),
          command.name,
          thread.threadId,
        );
      return [
        {
          type: "thread.renamed",
          threadId: command.threadId,
          ...(command.name !== null ? { name: command.name } : {}),
        },
      ];
    }
    case "session.delete": {
      // The session's drawer shells go with it. Agent records from before sessions existed are
      // their own session, keyed by their own id.
      const terminalIds = projection.terminals
        .filter(
          (terminal) =>
            terminal.sessionId === command.sessionId ||
            (terminal.kind === "agent" &&
              terminal.sessionId === undefined &&
              String(terminal.terminalId) === command.sessionId),
        )
        .map((terminal) => terminal.terminalId);
      const threadIds = projection.threads
        .filter((thread) => (thread.sessionId ?? thread.threadId) === command.sessionId)
        .map((thread) => thread.threadId);
      if (terminalIds.length === 0 && threadIds.length === 0) {
        throw new DomainError("session_missing", `Session does not exist: ${command.sessionId}`);
      }
      return [{ type: "session.deleted", sessionId: command.sessionId, terminalIds, threadIds }];
    }
    case "thread.status":
      assertThread(projection, command.threadId);
      return [
        {
          type: "thread.status.changed",
          threadId: command.threadId,
          status: command.status,
          ...(command.turnId ? { turnId: command.turnId } : {}),
          ...(command.capabilities ? { capabilities: command.capabilities } : {}),
          ...(command.errorMessage ? { errorMessage: command.errorMessage } : {}),
        },
      ];
    case "thread.provider-session": {
      const thread = requireThread(projection, command.threadId);
      if (thread.providerSessionId === command.providerSessionId) return [];
      return [
        {
          type: "thread.provider-session.recorded",
          threadId: command.threadId,
          providerSessionId: command.providerSessionId,
        },
      ];
    }
    case "thread.message":
      assertThread(projection, command.message.threadId);
      return [{ type: "thread.message.appended", message: command.message }];
    case "thread.usage":
      return decideUsage(projection, command);
    case "thread.checkpoint":
      assertThread(projection, command.checkpoint.threadId);
      return [{ type: "thread.checkpoint.recorded", checkpoint: command.checkpoint }];
    case "thread.request":
      assertThread(projection, command.request.threadId);
      return [{ type: "thread.request.requested", request: command.request }];
    case "thread.activity":
      assertThread(projection, command.activity.threadId);
      return [{ type: "thread.activity.updated", activity: command.activity }];
    case "thread.request.resolved":
      assertThread(projection, command.threadId);
      assertRequest(projection, command.requestId);
      return [{ type: "thread.request.resolved", threadId: command.threadId, requestId: command.requestId }];
    case "thread.respond":
      assertThread(projection, command.threadId);
      assertRequest(projection, command.requestId);
      return [
        {
          type: "thread.respond.requested",
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
        },
      ];
    case "thread.user-input":
      assertThread(projection, command.threadId);
      assertRequest(projection, command.requestId);
      return [
        {
          type: "thread.user-input.requested",
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
        },
      ];
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
    case "browser.updated":
      assertWorktree(projection, command.tab.worktreeId);
      return [{ type: "browser.updated", tab: command.tab }];
    case "browser.closed":
      return [{ type: "browser.closed", browserTabId: command.browserTabId }];
    case "review.refresh":
      assertWorktree(projection, command.worktreeId);
      return [{ type: "review.refresh.requested", worktreeId: command.worktreeId, baseRef: command.baseRef }];
    case "review.diff":
      assertWorktree(projection, command.worktreeId);
      return [{ type: "review.diff.requested", worktreeId: command.worktreeId, path: command.path }];
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
    case "diagnostics.createSupportBundle":
      return [
        {
          type: "diagnostics.bundle.requested",
          destinationPath: command.destinationPath,
          ...(command.allowedRoot ? { allowedRoot: command.allowedRoot } : {}),
          ...(command.desktopLogs ? { desktopLogs: command.desktopLogs } : {}),
          ...(command.desktopApp ? { desktopApp: command.desktopApp } : {}),
        },
      ];
    case "diagnostics.bundle.created":
      return [{ type: "diagnostics.bundle.created", bundle: command.bundle }];
    case "diagnostics.bundle.failed":
      return [{ type: "diagnostics.bundle.failed", message: command.message }];
    case "legacy.scan":
      return [{ type: "legacy.scan.requested", batchId: command.batchId, snapshotPath: command.snapshotPath }];
    case "legacy.scan.completed":
      return [{ type: "legacy.scan.completed", preview: command.preview }];
    case "legacy.import":
      return [
        { type: "legacy.import.requested", batchId: command.batchId, selectedRecordIds: command.selectedRecordIds },
      ];
    case "legacy.import.completed":
      return [
        {
          type: "legacy.import.completed",
          batchId: command.batchId,
          importedProjectIds: command.importedProjectIds,
          importedWorktreeIds: command.importedWorktreeIds,
        },
      ];
    case "legacy.rollbackImport":
      return [{ type: "legacy.rollback.requested", batchId: command.batchId }];
    case "legacy.rollback.completed":
      return [{ type: "legacy.rollback.completed", batchId: command.batchId }];
    case "legacy.operation.failed":
      return [{ type: "legacy.operation.failed", batchId: command.batchId, message: command.message }];
    case "devserver.detected": {
      const terminal = projection.terminals.find((candidate) => candidate.terminalId === command.terminalId);
      if (!terminal) throw new DomainError("terminal_missing", `Terminal does not exist: ${command.terminalId}`);
      const parsed = parseDevServerUrl(command.url);
      if (!parsed) throw new DomainError("unsupported_command", "Dev server URLs must be local http(s) addresses.");
      if (terminal.status === "exited" || terminal.status === "failed") return [];
      const known = (projection.devServers ?? []).find(
        (devServer) => devServer.terminalId === command.terminalId && devServer.port === parsed.port,
      );
      // Servers reprint their address on every restart and rebuild; only a new address is an event.
      if (known?.url === parsed.url) return [];
      return [
        {
          type: "devserver.detected",
          devServer: { worktreeId: terminal.worktreeId, terminalId: terminal.terminalId, ...parsed },
        },
      ];
    }
    case "devserver.stopped":
      if (
        !(projection.devServers ?? []).some(
          (devServer) => devServer.terminalId === command.terminalId && devServer.port === command.port,
        )
      ) {
        return [];
      }
      return [{ type: "devserver.stopped", terminalId: command.terminalId, port: command.port }];
    case "worktree.setup":
      assertWorktree(projection, command.setup.worktreeId);
      return [{ type: "worktree.setup.changed", setup: command.setup }];
    case "worktree.setup.respond":
      return decideSetupResponse(projection, command);
    default:
      throw new DomainError("unsupported_command", `Command ${command.type} is not a domain mutation.`);
  }
}

function decideSetupResponse(
  projection: RuntimeProjection,
  command: Extract<RuntimeCommand, { type: "worktree.setup.respond" }>,
): DomainDecision[] {
  const setup = projection.worktreeSetups?.find((entry) => entry.worktreeId === command.worktreeId);
  if (setup?.status !== "waiting") {
    throw new DomainError("setup_not_waiting", "This worktree is not waiting for setup approval.");
  }
  // The hash pins the list the person read; a changed zli.json has to be shown again.
  if (setup.commandsHash !== command.commandsHash) {
    throw new DomainError("setup_not_waiting", "The setup commands changed. Review them again.");
  }
  return [
    {
      type: "worktree.setup.responded",
      worktreeId: command.worktreeId,
      commandsHash: command.commandsHash,
      decision: command.decision,
    },
    ...(command.decision === "always"
      ? [{ type: "project.setup.trusted" as const, projectId: setup.projectId, commandsHash: command.commandsHash }]
      : []),
  ];
}

function decideUsage(
  projection: RuntimeProjection,
  command: Extract<RuntimeCommand, { type: "thread.usage" }>,
): DomainDecision[] {
  const thread = requireThread(projection, command.threadId);
  const usageId = `${command.threadId}:${command.turnId}`;
  const known = (projection.usage ?? []).find((record) => record.usageId === usageId);
  if (known && sameUsage(known.usage, command.usage)) return [];
  const projectId = projection.worktrees.find((worktree) => worktree.worktreeId === thread.worktreeId)?.projectId;
  return [
    {
      type: "thread.usage.recorded",
      record: {
        usageId,
        threadId: command.threadId,
        turnId: command.turnId,
        provider: thread.provider,
        ...(projectId ? { projectId } : {}),
        ...(thread.model ? { model: thread.model } : {}),
        ...(thread.accountId ? { accountId: thread.accountId } : {}),
        usage: command.usage,
      },
    },
  ];
}

function sameUsage(left: TurnUsage, right: TurnUsage): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as Array<keyof TurnUsage>);
  return [...keys].every((key) => left[key] === right[key]);
}

function assertWorktree(projection: RuntimeProjection, worktreeId: string): void {
  if (!projection.worktrees.some((worktree) => worktree.worktreeId === worktreeId)) {
    throw new DomainError("worktree_missing", `Worktree does not exist: ${worktreeId}`);
  }
}

function assertProject(projection: RuntimeProjection, projectId: string): void {
  if (!projection.projects.some((project) => project.projectId === projectId)) {
    throw new DomainError("project_missing", `Project does not exist: ${projectId}`);
  }
}

function worktreeProjectId(projection: RuntimeProjection, worktreeId: string): string | undefined {
  return projection.worktrees.find((worktree) => worktree.worktreeId === worktreeId)?.projectId;
}

/** Agents reach each other by name, so two listed agents in one project cannot share one. */
function assertAgentNameFree(
  projection: RuntimeProjection,
  projectId: string | undefined,
  name: string,
  exceptId?: string,
): void {
  if (projectId === undefined) return;
  if (agentNameTaken(projection, { projectId, name, ...(exceptId ? { exceptId } : {}) }))
    throw new DomainError(
      "agent_name_taken",
      `Another agent in this project is already called ${name}. Pick a different name.`,
    );
}

/** A sub-agent's parent must be a chat or agent terminal in the same project, since agents start others only there. */
function assertStartedBy(projection: RuntimeProjection, projectId: string, startedBy: string): void {
  const worktreeId =
    projection.threads.find((thread) => thread.threadId === startedBy)?.worktreeId ??
    projection.terminals.find((terminal) => terminal.terminalId === startedBy && terminal.agent)?.worktreeId;
  if (worktreeId === undefined)
    throw new DomainError("agent_missing", `The agent that started this one does not exist: ${startedBy}`);
  if (worktreeProjectId(projection, worktreeId) !== projectId)
    throw new DomainError(
      "unsupported_command",
      "A sub-agent has to start in the same project as the agent that started it.",
    );
}

function assertTerminal(projection: RuntimeProjection, terminalId: string): void {
  if (!projection.terminals.some((terminal) => terminal.terminalId === terminalId)) {
    throw new DomainError("terminal_missing", `Terminal does not exist: ${terminalId}`);
  }
}

function deliverAgentMessage(
  projection: RuntimeProjection,
  command: Extract<RuntimeCommand, { type: "thread.a2a" }>,
): Extract<DomainDecision, { type: "thread.a2a.delivered" }> {
  if (command.sourceThreadId === command.targetThreadId) {
    throw new DomainError("a2a_invalid_target", "Agent messages must target a different thread in the same project.");
  }
  const text = command.text.trim();
  if (text.length === 0) {
    throw new DomainError("a2a_invalid_target", "Agent messages need text.");
  }
  if ((projection.messages ?? []).some((message) => message.messageId === command.messageId)) {
    throw new DomainError("a2a_invalid_target", `Agent message id is already in use: ${command.messageId}`);
  }
  const sourceProjectId = threadProjectId(projection, command.sourceThreadId);
  const targetProjectId = threadProjectId(projection, command.targetThreadId);
  if (sourceProjectId !== targetProjectId) {
    throw new DomainError("a2a_cross_project", "Agent messages can only be sent between threads in the same project.");
  }
  return {
    type: "thread.a2a.delivered",
    projectId: sourceProjectId,
    message: {
      messageId: command.messageId,
      threadId: command.targetThreadId,
      role: "agent",
      text,
      sourceThreadId: command.sourceThreadId,
    },
  };
}

function threadProjectId(projection: RuntimeProjection, threadId: string): ProjectId {
  const thread = projection.threads.find((candidate) => candidate.threadId === threadId);
  if (!thread) throw new DomainError("thread_missing", `Thread does not exist: ${threadId}`);
  const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === thread.worktreeId);
  if (!worktree) {
    throw new DomainError("worktree_missing", `Thread is not attached to a worktree: ${threadId}`);
  }
  return worktree.projectId;
}

const MAX_QUEUED_PER_THREAD = 20;

function requireThread(projection: RuntimeProjection, threadId: string): ThreadProjection {
  const thread = projection.threads.find((entry) => entry.threadId === threadId);
  if (!thread) throw new DomainError("thread_missing", `Thread does not exist: ${threadId}`);
  return thread;
}

function queuedFor(projection: RuntimeProjection, threadId: string): ThreadQueuedMessage[] {
  return (projection.queuedMessages ?? []).filter((queued) => queued.threadId === threadId);
}

/** An agent takes its next message only between turns, with nothing waiting on the person. */
function readyForNext(projection: RuntimeProjection, thread: ThreadProjection): boolean {
  return (
    thread.status === "idle" && !(projection.requests ?? []).some((request) => request.threadId === thread.threadId)
  );
}

function permissionChanged(thread: ThreadProjection | undefined, mode: PermissionMode | undefined): boolean {
  return mode !== undefined && mode !== (thread?.permissionMode ?? "full-access");
}

function assertPermissionChange(thread: ThreadProjection | undefined, mode: PermissionMode | undefined): void {
  if (permissionChanged(thread, mode) && thread?.capabilities.permissionSwitch !== "in-session") {
    throw new DomainError(
      "unsupported_command",
      "This agent keeps its permission mode for the whole session. Start a new chat to change it.",
    );
  }
}

/** The RPC layer writes uploaded bytes to disk first, so the event log never stores image data. */
function storedAttachments(attachments: readonly ThreadAttachmentUpload[] | undefined): ThreadAttachment[] {
  return (attachments ?? []).map((attachment) => {
    if (!attachment.path) throw new DomainError("unsupported_command", "Attachments must be stored before sending.");
    return { name: attachment.name, mimeType: attachment.mimeType, path: attachment.path };
  });
}

function sendRequested(
  projection: RuntimeProjection,
  input: {
    threadId: ThreadId;
    text: string;
    model?: string | undefined;
    reasoningEffort?: string | undefined;
    permissionMode?: PermissionMode | undefined;
    attachments?: readonly ThreadAttachment[] | undefined;
  },
): Extract<DomainDecision, { type: "thread.send.requested" }> {
  const thread = projection.threads.find((entry) => entry.threadId === input.threadId);
  assertPermissionChange(thread, input.permissionMode);
  const attachments = input.attachments ?? [];
  return {
    type: "thread.send.requested",
    threadId: input.threadId,
    text: input.text,
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(permissionChanged(thread, input.permissionMode) && input.permissionMode
      ? { permissionMode: input.permissionMode }
      : {}),
    ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
  };
}

function sendQueued(projection: RuntimeProjection, queued: ThreadQueuedMessage): DomainDecision[] {
  return [
    { type: "thread.queue.removed", threadId: queued.threadId, queueId: queued.queueId },
    sendRequested(projection, queued),
  ];
}

function assertThread(projection: RuntimeProjection, threadId: string): void {
  if (!projection.threads.some((thread) => thread.threadId === threadId)) {
    throw new DomainError("thread_missing", `Thread does not exist: ${threadId}`);
  }
}

function assertRequest(projection: RuntimeProjection, requestId: string): void {
  if (!(projection.requests ?? []).some((request) => request.requestId === requestId)) {
    throw new DomainError("thread_missing", `Thread request does not exist: ${requestId}`);
  }
}

function assertSafeRef(ref: string): void {
  if (
    !ref ||
    ref.startsWith("-") ||
    ref.includes("\0") ||
    ref.includes("\\") ||
    /(^|\/)\.\.?($|\/)/u.test(ref) ||
    /[~^:?*[]/u.test(ref) ||
    ref.endsWith(".lock") ||
    ref.endsWith(".")
  ) {
    throw new DomainError("unsupported_command", `Unsafe Git ref: ${ref}`);
  }
}

export function canonicalPath(path: string): string {
  const normalized = path.replaceAll("/", "\\");
  return win32
    .normalize(normalized)
    .replace(/[\\/]$/, "")
    .toLowerCase();
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
