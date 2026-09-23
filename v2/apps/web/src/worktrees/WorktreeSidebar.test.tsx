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
    expect(row?.textContent).toContain("Claude Code");
    expect(row?.getAttribute("title")).toBe("/repo/feature · Claude Code");
    expect(container.textContent).not.toContain("OpenCode");
    expect(container.textContent).not.toContain("opencode");
  });
});
