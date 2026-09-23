import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  EnvironmentDescriptor,
  ProjectId,
  RpcRequest,
  RuntimeEventEnvelope,
  RuntimeProjection,
  SharedProjectContext,
  ThreadId,
  WorktreeId,
  deriveSharedProjectContexts,
} from "./index.js";

const commandId = "10000000-0000-4000-8000-000000000001";
const eventId = "20000000-0000-4000-8000-000000000001";
const environmentId = "30000000-0000-4000-8000-000000000001";
const projectId = "40000000-0000-4000-8000-000000000001";

describe("runtime contracts", () => {
  it("parses a versioned command request", () => {
    expect(
      RpcRequest.parse({
        protocolVersion: 1,
        commandId,
        command: { type: "project.register", path: "C:/work/example" },
      }),
    ).toEqual({
      protocolVersion: 1,
      commandId,
      command: { type: "project.register", path: "C:/work/example" },
    });
  });

  it("rejects malformed requests and unsupported protocol versions", () => {
    expect(() =>
      RpcRequest.parse({
        protocolVersion: 2,
        commandId: "not-a-command-id",
        command: { type: "project.register" },
      }),
    ).toThrowError(ZodError);
  });

  it("rejects unknown event variants instead of casting them", () => {
    expect(() =>
      RuntimeEventEnvelope.parse({
        protocolVersion: 1,
        sequence: 1,
        eventId,
        occurredAt: "2026-09-21T00:00:00.000Z",
        event: { type: "future.event", payload: {} },
      }),
    ).toThrowError(ZodError);
  });

  it("accepts descriptors that omit future optional capabilities", () => {
    expect(
      EnvironmentDescriptor.parse({
        environmentId,
        label: "Local",
        protocolVersion: 1,
        capabilities: {},
      }).capabilities,
    ).toEqual({});
  });

  it("parses a complete empty projection snapshot", () => {
    expect(
      RuntimeProjection.parse({
        environment: {
          environmentId,
          label: "Local",
          protocolVersion: 1,
          capabilities: { worktrees: true },
        },
        projects: [{ projectId, path: "C:/work/example", name: "example" }],
        worktrees: [],
        threads: [],
        terminals: [],
        browserTabs: [],
        attention: [],
        lastSequence: 0,
      }).projects,
    ).toHaveLength(1);
  });

  it("reports listed CLI discovery and rejects OpenCode in that list", () => {
    expect(
      RuntimeProjection.parse({
        environment: {
          environmentId,
          label: "Local",
          protocolVersion: 1,
          capabilities: {},
        },
        projects: [],
        worktrees: [],
        threads: [],
        providers: [
          {
            provider: "codex",
            displayName: "Codex",
            status: "found",
            path: "/usr/local/bin/codex",
            version: "codex 0.1.0",
          },
          {
            provider: "claude-code",
            displayName: "Claude Code",
            status: "missing",
            reason: "Claude Code CLI was not found on PATH or in known install locations.",
          },
          {
            provider: "cursor-agent",
            displayName: "Cursor",
            status: "missing",
            reason: "Cursor CLI was not found on PATH or in known install locations.",
          },
        ],
        terminals: [],
        browserTabs: [],
        attention: [],
        lastSequence: 0,
      }).providers?.map((provider) => provider.provider),
    ).toEqual(["codex", "claude-code", "cursor-agent"]);

    expect(() =>
      RuntimeProjection.parse({
        environment: {
          environmentId,
          label: "Local",
          protocolVersion: 1,
          capabilities: {},
        },
        projects: [],
        worktrees: [],
        threads: [],
        providers: [
          { provider: "opencode", displayName: "OpenCode", status: "found", path: "/usr/local/bin/opencode" },
        ],
        terminals: [],
        browserTabs: [],
        attention: [],
        lastSequence: 0,
      }),
    ).toThrowError(ZodError);
  });

  it("parses a shared project context card without transcript fields", () => {
    const threadId = "50000000-0000-4000-8000-000000000001";
    const worktreeId = "60000000-0000-4000-8000-000000000001";
    expect(
      SharedProjectContext.parse({
        projectId,
        repoRoot: "C:/work/example",
        worktrees: [{ worktreeId, path: "C:/work/example/feature", branch: "feature", status: "ready" }],
        threads: [{ threadId, worktreeId, provider: "codex", status: "idle" }],
      }),
    ).toEqual({
      projectId,
      repoRoot: "C:/work/example",
      worktrees: [{ worktreeId, path: "C:/work/example/feature", branch: "feature", status: "ready" }],
      threads: [{ threadId, worktreeId, provider: "codex", status: "idle" }],
    });
    expect(() =>
      SharedProjectContext.parse({
        projectId,
        repoRoot: "",
        worktrees: [],
        threads: [],
      }),
    ).toThrowError(ZodError);
  });

  it("keeps each project's card inside that project", () => {
    const ownerId = ProjectId.parse(projectId);
    const otherProjectId = ProjectId.parse("40000000-0000-4000-8000-000000000002");
    const worktreeId = WorktreeId.parse("60000000-0000-4000-8000-000000000001");
    const otherWorktreeId = WorktreeId.parse("60000000-0000-4000-8000-000000000002");
    const threadId = ThreadId.parse("50000000-0000-4000-8000-000000000001");
    const otherThreadId = ThreadId.parse("50000000-0000-4000-8000-000000000002");
    const contexts = deriveSharedProjectContexts({
      projects: [
        { projectId: ownerId, path: "C:/work/example", name: "example" },
        { projectId: otherProjectId, path: "C:/work/other", name: "other" },
      ],
      worktrees: [
        { worktreeId, projectId: ownerId, path: "C:/work/example/feature", branch: "feature", status: "ready" },
        {
          worktreeId: otherWorktreeId,
          projectId: otherProjectId,
          path: "C:/work/other/topic",
          branch: "topic",
          status: "cancelled",
        },
      ],
      threads: [
        { threadId, worktreeId, provider: "codex", status: "idle", capabilities: {} },
        {
          threadId: otherThreadId,
          worktreeId: otherWorktreeId,
          provider: "cursor-agent",
          status: "stopped",
          capabilities: {},
        },
      ],
    });
    expect(contexts[0]).toEqual({
      projectId,
      repoRoot: "C:/work/example",
      worktrees: [{ worktreeId, path: "C:/work/example/feature", branch: "feature", status: "ready" }],
      threads: [{ threadId, worktreeId, provider: "codex", status: "idle" }],
    });
    expect(contexts[1]).toEqual({
      projectId: otherProjectId,
      repoRoot: "C:/work/other",
      worktrees: [],
      threads: [],
    });
    expect(JSON.stringify(contexts)).not.toContain("transcript");
  });
});
