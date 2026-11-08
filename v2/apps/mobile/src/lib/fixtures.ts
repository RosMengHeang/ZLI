import type { RuntimeProjection } from "@zli-v2/contracts";
import { RuntimeProjection as RuntimeProjectionSchema } from "@zli-v2/contracts";

export const ids = {
  environment: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
  project: "0d3c1f8a-6b1e-4a35-9c2f-4f6e2c1a9b10",
  main: "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d",
  feature: "2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e",
  working: "3c4d5e6f-7a8b-4c3d-8e4f-5a6b7c8d9e0f",
  waiting: "4d5e6f7a-8b9c-4d4e-9f5a-6b7c8d9e0f1a",
  stopped: "5e6f7a8b-9c0d-4e5f-8a6b-7c8d9e0f1a2b",
  turn: "6f7a8b9c-0d1e-4f6a-9b7c-8d9e0f1a2b3c",
  shell: "7a8b9c0d-1e2f-4a7b-8c8d-9e0f1a2b3c4d",
};

export function sampleProjection(): RuntimeProjection {
  return RuntimeProjectionSchema.parse({
    environment: { environmentId: ids.environment, label: "Studio", protocolVersion: 1, capabilities: {} },
    projects: [{ projectId: ids.project, path: "/home/dev/app", name: "app" }],
    worktrees: [
      {
        worktreeId: ids.main,
        projectId: ids.project,
        path: "/home/dev/app",
        branch: "main",
        status: "ready",
        kind: "checkout",
      },
      {
        worktreeId: ids.feature,
        projectId: ids.project,
        path: "/home/dev/app-worktrees/feature-login",
        branch: "feature/login",
        status: "ready",
      },
    ],
    threads: [
      {
        threadId: ids.working,
        worktreeId: ids.feature,
        provider: "codex",
        status: "working",
        activeTurnId: ids.turn,
        capabilities: {},
      },
      { threadId: ids.waiting, worktreeId: ids.feature, provider: "claude-code", status: "idle", capabilities: {} },
      { threadId: ids.stopped, worktreeId: ids.main, provider: "codex", status: "stopped", capabilities: {} },
    ],
    providers: [
      {
        provider: "codex",
        displayName: "Codex",
        status: "found",
        path: "/bin/codex",
        models: [{ id: "o4", label: "o4" }],
      },
      { provider: "claude-code", displayName: "Claude Code", status: "found", path: "/bin/claude" },
      { provider: "droid", displayName: "Droid", status: "missing", reason: "Not installed" },
    ],
    messages: [
      { messageId: "m1", threadId: ids.working, role: "user", text: "Fix the login form" },
      {
        messageId: "m2",
        threadId: ids.working,
        role: "assistant",
        turnId: ids.turn,
        text: "Looking at it.\nRunning tests now",
      },
      { messageId: "m3", threadId: ids.working, role: "assistant", text: "   " },
    ],
    requests: [
      {
        requestId: "r1",
        threadId: ids.waiting,
        kind: "approval",
        payload: { toolName: "Bash", input: { command: "rm -rf build" } },
      },
    ],
    activities: [
      {
        activityId: "a1",
        threadId: ids.working,
        turnId: ids.turn,
        kind: "command",
        title: "npm test",
        status: "running",
      },
    ],
    terminals: [
      {
        terminalId: ids.shell,
        worktreeId: ids.feature,
        title: "Shell",
        status: "running",
        lastSequence: 4,
        kind: "shell",
      },
    ],
    browserTabs: [],
    attention: [],
    lastSequence: 10,
  });
}
