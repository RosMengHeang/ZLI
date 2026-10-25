import { describe, expect, it } from "vitest";

import { ids, sampleProjection } from "./fixtures.js";
import {
  currentActivity,
  installedProviders,
  newShellCommand,
  newWorktreeCommand,
  pendingRequests,
  projectSections,
  safeBranchName,
  shellForPath,
  startAgentCommand,
  threadMessages,
} from "./views.js";

describe("projectSections", () => {
  it("lists live agents with the one that needs a person first, and counts stopped ones", () => {
    const [section] = projectSections(sampleProjection());
    expect(section?.stoppedAgents).toBe(1);
    const feature = section?.worktrees[0];
    expect(feature?.worktree.branch).toBe("feature/login");
    expect(feature?.agents.map((agent) => [agent.name, agent.status.label])).toEqual([
      ["Claude Code", "Needs you"],
      ["Codex", "Working"],
    ]);
    expect(feature?.agents[1]?.preview).toBe("Running tests now");
    expect(feature?.shells.map((shell) => shell.terminalId)).toEqual([ids.shell]);
    expect(section?.worktrees[1]?.agents).toEqual([]);
  });
});

describe("thread details", () => {
  it("drops empty messages and finds the running tool call", () => {
    const projection = sampleProjection();
    expect(threadMessages(projection, ids.working).map((message) => message.messageId)).toEqual(["m1", "m2"]);
    const thread = projection.threads.find((candidate) => candidate.threadId === ids.working);
    expect(thread && currentActivity(projection, thread)?.title).toBe("npm test");
  });

  it("pairs requests with their agent", () => {
    expect(pendingRequests(sampleProjection()).map((pending) => [pending.request.requestId, pending.name])).toEqual([
      ["r1", "Claude Code"],
    ]);
    expect(pendingRequests(sampleProjection(), ids.working)).toEqual([]);
    expect(pendingRequests(undefined)).toEqual([]);
  });

  it("offers only installed agents", () => {
    expect(installedProviders(sampleProjection()).map((provider) => provider.provider)).toEqual([
      "codex",
      "claude-code",
    ]);
  });
});

describe("commands", () => {
  it("puts a new worktree where the desktop and the gateway expect it", () => {
    const project = sampleProjection().projects[0];
    if (!project) throw new Error("fixture has a project");
    expect(newWorktreeCommand(project, " fix/Login page ", "wt")).toEqual({
      type: "worktree.create",
      worktreeId: "wt",
      projectId: ids.project,
      path: "/home/dev/app-worktrees/fix-Login-page",
      workspaceRoot: "/home/dev/app-worktrees",
      branch: "fix/Login-page",
    });
    expect(safeBranchName("//")).toBe("");
  });

  it("starts an agent in its worktree folder and marks a shared worktree", () => {
    const projection = sampleProjection();
    const worktree = projection.worktrees[1];
    if (!worktree) throw new Error("fixture has a worktree");
    expect(
      startAgentCommand({
        threads: projection.threads,
        worktree,
        provider: "codex",
        model: undefined,
        permissionMode: "supervised",
        threadId: "t",
        sessionId: "s",
      }),
    ).toEqual({
      type: "thread.start",
      threadId: "t",
      worktreeId: ids.feature,
      provider: "codex",
      cwd: "/home/dev/app-worktrees/feature-login",
      sessionId: "s",
      permissionMode: "supervised",
      shareWorktree: true,
    });
  });

  it("opens a shell that suits the desktop's system", () => {
    expect(shellForPath("C:\\Users\\dev\\app")).toBe("powershell.exe");
    expect(shellForPath("/Users/dev/app")).toBe("/bin/bash");
    expect(newShellCommand({ worktreeId: ids.main, path: "/home/dev/app" }, "term")).toMatchObject({
      type: "terminal.create",
      cwd: "/home/dev/app",
      shell: "/bin/bash",
    });
  });
});
