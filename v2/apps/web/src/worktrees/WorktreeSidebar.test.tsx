// @vitest-environment jsdom

import { EnvironmentId, ProjectId, type RuntimeProjection, ThreadId, WorktreeId } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { WorktreeSidebar } from "./WorktreeSidebar.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000011");

const projection: RuntimeProjection = {
  environment: {
    environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
    label: "Local",
    protocolVersion: 1,
    capabilities: {},
  },
  projects: [{ projectId: ProjectId.parse("00000000-0000-4000-8000-000000000010"), path: "/repo", name: "repo" }],
  worktrees: [
    {
      worktreeId,
      projectId: ProjectId.parse("00000000-0000-4000-8000-000000000010"),
      path: "/repo/feature",
      branch: "feature",
      status: "ready",
    },
  ],
  threads: [
    {
      threadId: ThreadId.parse("00000000-0000-4000-8000-000000000021"),
      worktreeId,
      provider: "claude-code",
      status: "idle",
      capabilities: {},
    },
    {
      threadId: ThreadId.parse("00000000-0000-4000-8000-000000000022"),
      worktreeId,
      provider: "opencode",
      status: "idle",
      capabilities: {},
    },
  ],
  providers: [
    {
      provider: "claude-code",
      displayName: "Claude Code",
      status: "found",
      path: "/home/dev/.local/bin/claude",
    },
  ],
  terminals: [],
  browserTabs: [],
  attention: [],
  lastSequence: 1,
};

afterEach(() => document.body.replaceChildren());

describe("WorktreeSidebar", () => {
  it("shows the selectable agent bound to the worktree", () => {
    const container = document.createElement("div");
    document.body.append(container);
    act(() => {
      createRoot(container).render(
        <WorktreeSidebar
          projection={projection}
          activeWorktreeId={worktreeId}
          onSelect={() => undefined}
          onOpenProject={() => undefined}
          onCreateWorktree={() => undefined}
        />,
      );
    });
    const row = container.querySelector(".worktree-row");
    expect(row?.getAttribute("data-live-agent")).toBe("true");
    expect(row?.textContent).toContain("Claude Code");
    expect(row?.getAttribute("title")).toBe("/repo/feature · Claude Code");
    expect(row?.textContent).not.toContain("OpenCode");
    expect(row?.textContent).not.toContain("opencode");
    expect(container.textContent).not.toContain("OpenCode");
  });

  it("shows a git failure on the worktree row and leaves a stopped agent unmarked", () => {
    const stopped = structuredClone(projection);
    const worktree = stopped.worktrees[0];
    if (!worktree) throw new Error("Fixture is incomplete.");
    worktree.status = "failed";
    worktree.errorMessage =
      "Git could not create the worktree because a lock is held. Git said: fatal: Unable to create index.lock: File exists.";
    for (const entry of stopped.threads) entry.status = "stopped";
    const container = document.createElement("div");
    document.body.append(container);
    act(() => {
      createRoot(container).render(
        <WorktreeSidebar
          projection={stopped}
          activeWorktreeId={worktreeId}
          onSelect={() => undefined}
          onOpenProject={() => undefined}
          onCreateWorktree={() => undefined}
        />,
      );
    });
    const row = container.querySelector(".worktree-row");
    expect(row?.getAttribute("data-live-agent")).toBe("false");
    expect(row?.textContent).not.toContain("Claude Code");
    expect(container.querySelector(".tree-note")?.textContent).toContain("index.lock");
  });

  it("shows a read-only context card for the active project only", () => {
    const projectA = ProjectId.parse("00000000-0000-4000-8000-000000000010");
    const projectB = ProjectId.parse("00000000-0000-4000-8000-000000000012");
    const worktreeB = WorktreeId.parse("00000000-0000-4000-8000-000000000013");
    const threadA = ThreadId.parse("00000000-0000-4000-8000-000000000021");
    const threadB = ThreadId.parse("00000000-0000-4000-8000-000000000023");
    const scoped: RuntimeProjection = {
      ...projection,
      projects: [
        { projectId: projectA, path: "/repo/alpha", name: "alpha" },
        { projectId: projectB, path: "/repo/beta", name: "beta" },
      ],
      worktrees: [
        {
          worktreeId,
          projectId: projectA,
          path: "/repo/feature",
          branch: "feature",
          status: "ready",
        },
        {
          worktreeId: worktreeB,
          projectId: projectB,
          path: "/repo/beta/other",
          branch: "other",
          status: "ready",
        },
      ],
      threads: [
        {
          threadId: threadA,
          worktreeId,
          provider: "claude-code",
          status: "idle",
          capabilities: {},
        },
        {
          threadId: threadB,
          worktreeId: worktreeB,
          provider: "cursor-agent",
          status: "failed",
          capabilities: {},
          errorMessage: "provider crashed",
        },
      ],
      messages: [
        {
          messageId: "secret-1",
          threadId: threadA,
          role: "user",
          text: "do not copy this transcript",
        },
      ],
      projectContexts: [
        {
          projectId: projectA,
          repoRoot: "/repo/alpha",
          worktrees: [
            {
              worktreeId,
              path: "/repo/feature",
              branch: "feature",
              status: "ready",
            },
          ],
          threads: [{ threadId: threadA, worktreeId, provider: "claude-code", status: "idle" }],
        },
        {
          projectId: projectB,
          repoRoot: "/repo/beta",
          worktrees: [{ worktreeId: worktreeB, path: "/repo/beta/other", branch: "other", status: "ready" }],
          threads: [{ threadId: threadB, worktreeId: worktreeB, provider: "cursor-agent", status: "failed" }],
        },
      ],
    };
    const container = document.createElement("div");
    document.body.append(container);
    act(() => {
      createRoot(container).render(
        <WorktreeSidebar
          projection={scoped}
          activeWorktreeId={worktreeId}
          onSelect={() => undefined}
          onOpenProject={() => undefined}
          onCreateWorktree={() => undefined}
        />,
      );
    });
    const card = container.querySelector(".project-context");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("/repo/alpha");
    expect(card?.textContent).toContain("feature");
    expect(card?.textContent).toContain("Claude Code");
    expect(card?.textContent).toContain("Idle");
    expect(card?.textContent).toContain(threadA);
    expect(card?.textContent).not.toContain("/repo/beta");
    expect(card?.textContent).not.toContain("other");
    expect(card?.textContent).not.toContain("Cursor");
    expect(card?.textContent).not.toContain(threadB);
    expect(card?.textContent).not.toContain("do not copy this transcript");
    expect(card?.textContent).not.toContain("provider crashed");
    expect(card?.querySelector("button, input, textarea, a")).toBeNull();
  });

  it("states when the active project has no worktrees or threads", () => {
    const empty: RuntimeProjection = {
      ...projection,
      worktrees: [],
      threads: [],
      projectContexts: [
        {
          projectId: ProjectId.parse("00000000-0000-4000-8000-000000000010"),
          repoRoot: "/repo",
          worktrees: [],
          threads: [],
        },
      ],
    };
    const container = document.createElement("div");
    document.body.append(container);
    act(() => {
      createRoot(container).render(
        <WorktreeSidebar
          projection={empty}
          activeWorktreeId={undefined}
          onSelect={() => undefined}
          onOpenProject={() => undefined}
          onCreateWorktree={() => undefined}
        />,
      );
    });
    const card = container.querySelector(".project-context");
    expect(card?.textContent).toContain("No worktrees in this project.");
    expect(card?.textContent).toContain("No threads in this project.");
    expect(card?.querySelector("button, input, textarea, a")).toBeNull();
  });

  it("flags a worktree whose agent is waiting for input and shows loaded change counts elsewhere", () => {
    const waiting = structuredClone(projection);
    const second = WorktreeId.parse("00000000-0000-4000-8000-000000000014");
    const projectId = waiting.projects[0]?.projectId;
    if (!projectId) throw new Error("Fixture is incomplete.");
    waiting.worktrees.push({ worktreeId: second, projectId, path: "/repo/other", branch: "other", status: "ready" });
    for (const entry of waiting.threads) entry.status = "waiting";
    waiting.reviews = [
      {
        worktreeId: second,
        state: "ready",
        files: [
          { path: "a.ts", kind: "modified", additions: 1, deletions: 0, binary: false },
          { path: "b.ts", kind: "added", additions: 3, deletions: 0, binary: false },
        ],
        conflictFiles: [],
      },
    ] as unknown as RuntimeProjection["reviews"];
    const container = document.createElement("div");
    document.body.append(container);
    act(() => {
      createRoot(container).render(
        <WorktreeSidebar
          projection={waiting}
          activeWorktreeId={worktreeId}
          onSelect={() => undefined}
          onOpenProject={() => undefined}
          onCreateWorktree={() => undefined}
        />,
      );
    });
    const [first, other] = [...container.querySelectorAll(".worktree-row")];
    expect(first?.querySelector(".worktree-activity")?.textContent).toBe("Needs input");
    expect(other?.querySelector(".worktree-activity")).toBeNull();
    expect(other?.querySelector(".worktree-changes")?.textContent).toBe("2");
  });
});
