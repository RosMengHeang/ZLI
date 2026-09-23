// @vitest-environment jsdom

import {
  CommandId,
  EnvironmentId,
  ProjectId,
  type ProviderDiscovery,
  type RuntimeProjection,
  ThreadId,
  WorktreeId,
} from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { AgentPane } from "./AgentPane.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000011");
const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const commandId = CommandId.parse("00000000-0000-4000-8000-000000000099");

const discovered: ProviderDiscovery[] = [
  { provider: "codex", displayName: "Codex", status: "found", path: "/usr/local/bin/codex", version: "codex 0.1.0" },
  {
    provider: "claude-code",
    displayName: "Claude Code",
    status: "found",
    path: "/home/dev/.local/bin/claude",
    version: "claude 2.1.0",
  },
  {
    provider: "cursor-agent",
    displayName: "Cursor",
    status: "found",
    path: "/home/dev/.local/bin/cursor-agent",
  },
];

function projection(overrides: Partial<RuntimeProjection> = {}): RuntimeProjection {
  return {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [{ projectId, path: "/repo", name: "repo" }],
    worktrees: [{ worktreeId, projectId, path: "/repo/feature", branch: "feature", status: "ready" }],
    threads: [],
    providers: discovered,
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
    ...overrides,
  };
}

function renderPane(
  next: RuntimeProjection,
  dispatch: ZliBridge["runtime"]["dispatch"] = async () => ({
    commandId,
    accepted: true as const,
  }),
) {
  const bridge = {
    runtime: {
      dispatch,
      getProjection: async () => next,
      onProjection: () => () => undefined,
      attachTerminal: async () => ({ accepted: true }),
      onTerminal: () => () => undefined,
    },
  } as unknown as ZliBridge;
  const container = document.createElement("div");
  document.body.append(container);
  const worktree = next.worktrees[0];
  act(() => {
    createRoot(container).render(
      <RuntimeProvider bridge={bridge}>
        <AgentPane projection={next} worktree={worktree} />
      </RuntimeProvider>,
    );
  });
  return container;
}

afterEach(() => document.body.replaceChildren());

describe("AgentPane", () => {
  it("starts the chosen provider in the selected worktree", async () => {
    const calls: unknown[] = [];
    const container = renderPane(projection(), async (request) => {
      calls.push(request);
      return { commandId, accepted: true as const };
    });
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="cursor-agent"]')?.click();
    });
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Start Cursor")?.click();
    });

    expect(calls).toEqual([
      expect.objectContaining({
        command: expect.objectContaining({
          type: "thread.start",
          provider: "cursor-agent",
          worktreeId,
          cwd: "/repo/feature",
        }),
      }),
    ]);
    expect(container.textContent).not.toContain("OpenCode");
  });

  it("shows the discovery error and does not start when the CLI is missing", async () => {
    const calls: unknown[] = [];
    const missingCursor: ProviderDiscovery = {
      provider: "cursor-agent",
      displayName: "Cursor",
      status: "missing",
      reason: "Cursor CLI was not found on PATH or in known install locations.",
    };
    const codex = discovered[0];
    const claude = discovered[1];
    if (!codex || !claude) throw new Error("Discovery fixture is incomplete.");
    const container = renderPane(projection({ providers: [codex, claude, missingCursor] }), async (request) => {
      calls.push(request);
      return { commandId, accepted: true as const };
    });
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="cursor-agent"]')?.click();
    });
    const start = [...container.querySelectorAll("button")].find((button) => button.textContent === "Start Cursor");
    expect(start?.disabled).toBe(true);
    expect(container.textContent).toContain("Cursor CLI was not found on PATH or in known install locations.");
    expect(container.textContent).not.toContain("Starting");
    await act(async () => {
      start?.click();
    });
    expect(calls).toEqual([]);
  });

  it("opens a new thread when the provider changes instead of reusing another session", async () => {
    const codexThread = ThreadId.parse("00000000-0000-4000-8000-000000000021");
    const calls: unknown[] = [];
    const container = renderPane(
      projection({
        threads: [
          {
            threadId: codexThread,
            worktreeId,
            provider: "codex",
            status: "idle",
            capabilities: {},
          },
        ],
        messages: [
          {
            messageId: "message-1",
            threadId: codexThread,
            role: "assistant",
            text: "codex only reply",
          },
        ],
      }),
      async (request) => {
        calls.push(request);
        return { commandId, accepted: true as const };
      },
    );

    expect(container.textContent).toContain("codex only reply");
    expect(container.querySelector("textarea")?.getAttribute("aria-label")).toBe("Message Codex");
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="claude-code"]')?.click();
    });
    expect(container.textContent).not.toContain("codex only reply");
    expect(container.textContent).toContain("No Claude Code session");
    expect(container.textContent).toContain("does not continue the other agent's session");
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Start Claude Code")?.click();
    });
    const command = (calls[0] as { command: { type: string; threadId: string; provider: string; cwd: string } })
      .command;
    expect(command).toMatchObject({
      type: "thread.start",
      provider: "claude-code",
      cwd: "/repo/feature",
      worktreeId,
    });
    expect(command.threadId).not.toBe(codexThread);
  });

  it("does not offer OpenCode even when a stored discovery row includes it", () => {
    const container = renderPane(
      projection({
        providers: [
          ...discovered,
          { provider: "opencode", displayName: "OpenCode", status: "found", path: "/usr/local/bin/opencode" },
        ] as ProviderDiscovery[],
      }),
    );
    const values = [...container.querySelectorAll("input[type='radio']")].map((input) => input.getAttribute("value"));
    expect(values).toEqual(["codex", "claude-code", "cursor-agent"]);
    expect(container.textContent).not.toContain("OpenCode");
  });
});
