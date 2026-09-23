import {
  EnvironmentId,
  EventId,
  ProjectId,
  ThreadId,
  WorktreeId,
  type RuntimeEvent,
  type RuntimeEventEnvelope,
  type RuntimeProjection,
} from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { createEmptyProjection, projectEvent } from "./projector.js";

const environment = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000801"),
  label: "Project context",
  protocolVersion: 1 as const,
  capabilities: {},
};

const projectA = ProjectId.parse("00000000-0000-4000-8000-000000000811");
const projectB = ProjectId.parse("00000000-0000-4000-8000-000000000812");
const worktreeA = WorktreeId.parse("00000000-0000-4000-8000-000000000821");
const worktreeB = WorktreeId.parse("00000000-0000-4000-8000-000000000822");
const threadA = ThreadId.parse("00000000-0000-4000-8000-000000000831");
const threadB = ThreadId.parse("00000000-0000-4000-8000-000000000832");

function envelope(sequence: number, event: RuntimeEvent): RuntimeEventEnvelope {
  return {
    protocolVersion: 1,
    sequence,
    eventId: EventId.parse(`00000000-0000-4000-8000-0000000008${String(sequence).padStart(2, "0")}`),
    occurredAt: "2026-09-23T12:00:00.000Z",
    event,
  };
}

function project(events: RuntimeEvent[]): RuntimeProjection {
  return events.reduce(
    (current, event, index) => projectEvent(current, envelope(index + 1, event)),
    createEmptyProjection(environment),
  );
}

const registerA: RuntimeEvent = {
  type: "project.registered",
  project: { projectId: projectA, path: "C:\\work\\alpha", name: "alpha" },
};
const registerB: RuntimeEvent = {
  type: "project.registered",
  project: { projectId: projectB, path: "C:\\work\\beta", name: "beta" },
};
const createA: RuntimeEvent = {
  type: "worktree.create.requested",
  worktree: {
    worktreeId: worktreeA,
    projectId: projectA,
    path: "C:\\work\\alpha\\a",
    branch: "feature-a",
    status: "queued",
  },
  workspaceRoot: "C:\\work",
};
const createB: RuntimeEvent = {
  type: "worktree.create.requested",
  worktree: {
    worktreeId: worktreeB,
    projectId: projectB,
    path: "C:\\work\\beta\\b",
    branch: "feature-b",
    status: "ready",
  },
  workspaceRoot: "C:\\work",
};
const startA: RuntimeEvent = {
  type: "thread.start.requested",
  thread: { threadId: threadA, worktreeId: worktreeA, provider: "codex", status: "idle", capabilities: {} },
  cwd: "C:\\work\\alpha\\a",
};
const startB: RuntimeEvent = {
  type: "thread.start.requested",
  thread: { threadId: threadB, worktreeId: worktreeB, provider: "cursor-agent", status: "working", capabilities: {} },
  cwd: "C:\\work\\beta\\b",
};

describe("shared project context projection", () => {
  it("starts empty and fills one card per registered project", () => {
    expect(createEmptyProjection(environment).projectContexts).toEqual([]);
    const projection = project([registerA, registerB]);
    expect(projection.projectContexts).toEqual([
      { projectId: projectA, repoRoot: "C:\\work\\alpha", worktrees: [], threads: [] },
      { projectId: projectB, repoRoot: "C:\\work\\beta", worktrees: [], threads: [] },
    ]);
  });

  it("updates a project's card when its worktrees or threads change", () => {
    const seeded = project([registerA, registerB, createA, createB, startA, startB]);
    expect(seeded.projectContexts?.[0]).toEqual({
      projectId: projectA,
      repoRoot: "C:\\work\\alpha",
      worktrees: [{ worktreeId: worktreeA, path: "C:\\work\\alpha\\a", branch: "feature-a", status: "queued" }],
      threads: [{ threadId: threadA, worktreeId: worktreeA, provider: "codex", status: "idle" }],
    });

    const ready = projectEvent(
      seeded,
      envelope(7, { type: "worktree.status.changed", worktreeId: worktreeA, status: "ready" }),
    );
    expect(ready.projectContexts?.[0]?.worktrees[0]?.status).toBe("ready");
    expect(ready.projectContexts?.[1]).toEqual(seeded.projectContexts?.[1]);

    const working = projectEvent(
      ready,
      envelope(8, { type: "thread.status.changed", threadId: threadA, status: "working" }),
    );
    expect(working.projectContexts?.[0]?.threads).toEqual([
      { threadId: threadA, worktreeId: worktreeA, provider: "codex", status: "working" },
    ]);
    expect(working.projectContexts?.[1]?.threads).toEqual([
      { threadId: threadB, worktreeId: worktreeB, provider: "cursor-agent", status: "working" },
    ]);
  });

  it("drops cancelled worktrees and stopped threads without moving them to another project", () => {
    const seeded = project([registerA, registerB, createA, createB, startA, startB]);
    const stopped = projectEvent(
      seeded,
      envelope(7, { type: "thread.status.changed", threadId: threadA, status: "stopped" }),
    );
    expect(stopped.projectContexts?.[0]?.threads).toEqual([]);
    expect(stopped.projectContexts?.[1]?.threads.map((thread) => thread.threadId)).toEqual([threadB]);
    expect(stopped.threads).toHaveLength(2);

    const cancelled = projectEvent(
      stopped,
      envelope(8, {
        type: "worktree.status.changed",
        worktreeId: worktreeA,
        status: "cancelled",
        errorMessage: "checkout removed",
      }),
    );
    expect(cancelled.projectContexts?.[0]?.worktrees).toEqual([]);
    expect(JSON.stringify(cancelled.projectContexts)).not.toContain("checkout removed");
    expect(cancelled.projectContexts?.[1]?.worktrees.map((worktree) => worktree.worktreeId)).toEqual([worktreeB]);
  });

  it("removes a worktree from its project card and does not leak the orphaned thread", () => {
    const seeded = project([registerA, registerB, createA, createB, startA, startB]);
    const removed = projectEvent(seeded, envelope(7, { type: "worktree.removed", worktreeId: worktreeA }));
    expect(removed.projectContexts?.[0]).toEqual({
      projectId: projectA,
      repoRoot: "C:\\work\\alpha",
      worktrees: [],
      threads: [],
    });
    expect(removed.threads.some((thread) => thread.threadId === threadA)).toBe(true);
    expect(JSON.stringify(removed.projectContexts)).not.toContain(threadA);
    expect(removed.projectContexts?.[1]?.threads.map((thread) => thread.threadId)).toEqual([threadB]);
  });

  it("keeps agent-to-agent delivery on the transcript and out of the project card", () => {
    const seeded = project([registerA, registerB, createA, createB, startA, startB]);
    const note = "look at the failing test";
    const delivered = projectEvent(
      seeded,
      envelope(7, {
        type: "thread.a2a.delivered",
        projectId: projectA,
        message: {
          messageId: "agent-message-1",
          threadId: threadA,
          role: "agent",
          text: note,
          sourceThreadId: threadA,
        },
      }),
    );
    expect(delivered.messages).toEqual([
      {
        messageId: "agent-message-1",
        threadId: threadA,
        role: "agent",
        text: note,
        sourceThreadId: threadA,
      },
    ]);
    expect(delivered.projectContexts).toEqual(seeded.projectContexts);
    expect(JSON.stringify(delivered.projectContexts)).not.toContain(note);

    const appended = projectEvent(
      delivered,
      envelope(8, {
        type: "thread.message.appended",
        message: { messageId: "user-1", threadId: threadA, role: "user", text: "full user transcript" },
      }),
    );
    expect(appended.messages?.map((message) => message.text)).toEqual([note, "full user transcript"]);
    expect(JSON.stringify(appended.projectContexts)).not.toContain("full user transcript");
    expect(appended.projectContexts?.[0]?.threads[0]).toEqual({
      threadId: threadA,
      worktreeId: worktreeA,
      provider: "codex",
      status: "idle",
    });
  });
});
