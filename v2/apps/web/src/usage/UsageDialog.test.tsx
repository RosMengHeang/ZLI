// @vitest-environment jsdom

import { CommandId, EnvironmentId, ProjectId, type RuntimeProjection, ThreadId, WorktreeId } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { UsageDialog } from "./UsageDialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000011");
const liveThread = ThreadId.parse("00000000-0000-4000-8000-000000000401");
const deletedThread = ThreadId.parse("00000000-0000-4000-8000-000000000402");
const recent = new Date(Date.now() - 60_000).toISOString();

function projectionWith(overrides: Partial<RuntimeProjection> = {}): RuntimeProjection {
  return {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [{ projectId, path: "C:/repo", name: "repo" }],
    worktrees: [
      { worktreeId, projectId, path: "C:/repo", branch: "main", status: "ready" },
    ] as RuntimeProjection["worktrees"],
    threads: [{ threadId: liveThread, worktreeId, provider: "claude-code", status: "idle", capabilities: {} }],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
    providers: [
      { provider: "claude-code", displayName: "Claude Code", status: "found", path: "claude" },
      { provider: "codex", displayName: "Codex", status: "found", path: "codex" },
    ],
    ...overrides,
  };
}

async function render(projection: RuntimeProjection) {
  const bridge = {
    runtime: {
      dispatch: async () => ({ commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"), accepted: true }),
      getProjection: async () => projection,
      onProjection: () => () => undefined,
      attachTerminal: async () => ({ accepted: true }),
      onTerminal: () => () => undefined,
    },
  } as unknown as ZliBridge;
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <RuntimeProvider bridge={bridge}>
        <UsageDialog projection={projection} onClose={() => undefined} />
      </RuntimeProvider>,
    );
  });
  return container;
}

afterEach(() => document.body.replaceChildren());

describe("UsageDialog", () => {
  it("explains where numbers come from when nothing is recorded", async () => {
    const container = await render(projectionWith());
    expect(container.textContent).toContain("No usage yet.");
    expect(container.querySelector("table")).toBeNull();
  });

  it("totals tokens and reported cost by agent and chat, and marks deleted chats", async () => {
    const container = await render(
      projectionWith({
        messages: [{ messageId: "m1", threadId: liveThread, role: "user", text: "Fix the login flow\nmore" }],
        usage: [
          {
            usageId: `${liveThread}:t1`,
            threadId: liveThread,
            turnId: "t1",
            provider: "claude-code",
            projectId,
            recordedAt: recent,
            usage: { inputTokens: 12_000, cachedInputTokens: 8_000, outputTokens: 1_500, costUsd: 0.42 },
          },
          {
            usageId: `${deletedThread}:t2`,
            threadId: deletedThread,
            turnId: "t2",
            provider: "codex",
            projectId,
            recordedAt: recent,
            usage: { inputTokens: 30_000, outputTokens: 2_000 },
          },
        ],
      }),
    );
    const summary = container.querySelector(".usage-summary")?.textContent ?? "";
    expect(summary).toContain("Turns2");
    expect(summary).toContain("42k8k cached");
    expect(summary).toContain("$0.421 of 2 turns");
    const rows = [...container.querySelectorAll("tbody tr")].map((row) => row.textContent);
    expect(rows[0]).toContain("Codex");
    expect(rows[0]).toContain("Not reported");
    expect(rows.some((row) => row?.includes("Fix the login flow") && row.includes("$0.42"))).toBe(true);
    expect(rows.some((row) => row?.includes("Deleted"))).toBe(true);
    expect(container.querySelector(".usage-note")?.textContent).toContain("Codex does not report cost.");
  });
});
