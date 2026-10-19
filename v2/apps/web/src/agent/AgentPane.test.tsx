// @vitest-environment jsdom

import {
  CommandId,
  EnvironmentId,
  ProjectId,
  type ProviderDiscovery,
  type RuntimeProjection,
  ThreadId,
  WorktreeId,
  type WorktreeProjection,
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
  hooks: {
    onSelectWorktree?: (worktreeId: string) => void;
    onCreateWorktree?: () => void;
  } = {},
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
        <AgentPane
          projection={next}
          worktree={worktree}
          {...(hooks.onSelectWorktree
            ? { onSelectWorktree: (selected: WorktreeProjection) => hooks.onSelectWorktree?.(selected.worktreeId) }
            : {})}
          {...(hooks.onCreateWorktree ? { onCreateWorktree: hooks.onCreateWorktree } : {})}
        />
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

  it("starts a changed provider on a free worktree instead of the live one", async () => {
    const codexThread = ThreadId.parse("00000000-0000-4000-8000-000000000021");
    const freeWorktree = WorktreeId.parse("00000000-0000-4000-8000-000000000012");
    const calls: unknown[] = [];
    const selected: string[] = [];
    const container = renderPane(
      projection({
        worktrees: [
          { worktreeId, projectId, path: "/repo/feature", branch: "feature", status: "ready" },
          { worktreeId: freeWorktree, projectId, path: "/repo/other", branch: "other", status: "ready" },
        ],
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
      { onSelectWorktree: (id) => selected.push(id) },
    );

    expect(container.textContent).toContain("codex only reply");
    expect(container.querySelector("textarea")?.getAttribute("aria-label")).toBe("Message Codex");
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="claude-code"]')?.click();
    });
    expect(container.textContent).not.toContain("codex only reply");
    expect(container.textContent).toContain("No Claude Code session");
    expect(container.textContent).toContain("gets its own worktree");
    expect(container.textContent).toContain("does not continue the session already here");
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Start Claude Code in other")
        ?.click();
    });
    const command = (calls[0] as { command: { type: string; threadId: string; provider: string; cwd: string } })
      .command;
    expect(command).toMatchObject({
      type: "thread.start",
      provider: "claude-code",
      cwd: "/repo/other",
      worktreeId: freeWorktree,
    });
    expect(command).not.toHaveProperty("shareWorktree");
    expect(command.threadId).not.toBe(codexThread);
    expect(selected).toEqual([freeWorktree]);
  });

  it("asks for a new worktree when every ready checkout already has a live agent", async () => {
    const calls: unknown[] = [];
    let created = 0;
    const container = renderPane(
      projection({
        threads: [
          {
            threadId: ThreadId.parse("00000000-0000-4000-8000-000000000021"),
            worktreeId,
            provider: "codex",
            status: "working",
            capabilities: {},
          },
        ],
      }),
      async (request) => {
        calls.push(request);
        return { commandId, accepted: true as const };
      },
      { onCreateWorktree: () => (created += 1) },
    );
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="claude-code"]')?.click();
    });
    expect(container.textContent).toContain("Create a worktree, then start Claude Code there.");
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Create worktree")?.click();
    });
    expect(created).toBe(1);
    expect(calls).toEqual([]);
  });

  it("shares the current worktree only after confirm", async () => {
    const calls: unknown[] = [];
    const container = renderPane(
      projection({
        threads: [
          {
            threadId: ThreadId.parse("00000000-0000-4000-8000-000000000021"),
            worktreeId,
            provider: "codex",
            status: "idle",
            capabilities: {},
          },
        ],
      }),
      async (request) => {
        calls.push(request);
        return { commandId, accepted: true as const };
      },
    );
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="cursor-agent"]')?.click();
    });
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Share this worktree")?.click();
    });
    expect(calls).toEqual([]);
    const confirm = container.querySelector('[aria-label="Confirm shared worktree"]');
    expect(confirm).not.toBeNull();
    await act(async () => {
      confirm?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector('[aria-label="Confirm shared worktree"]')).toBeNull();
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Share this worktree")?.click();
    });
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Cancel")?.click();
    });
    expect(container.querySelector('[aria-label="Confirm shared worktree"]')).toBeNull();
    expect(calls).toEqual([]);

    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Share this worktree")?.click();
    });
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Share worktree")?.click();
    });
    expect(calls).toEqual([
      expect.objectContaining({
        command: expect.objectContaining({
          type: "thread.start",
          provider: "cursor-agent",
          worktreeId,
          cwd: "/repo/feature",
          shareWorktree: true,
        }),
      }),
    ]);
  });

  it("treats a stopped thread as free so a single-agent restart stays on that worktree", async () => {
    const calls: unknown[] = [];
    const container = renderPane(
      projection({
        threads: [
          {
            threadId: ThreadId.parse("00000000-0000-4000-8000-000000000021"),
            worktreeId,
            provider: "codex",
            status: "stopped",
            capabilities: {},
          },
        ],
      }),
      async (request) => {
        calls.push(request);
        return { commandId, accepted: true as const };
      },
    );
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="claude-code"]')?.click();
    });
    expect(container.textContent).toContain("Start a new thread in this worktree.");
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Start Claude Code")?.click();
    });
    expect(calls).toEqual([
      expect.objectContaining({
        command: expect.objectContaining({
          type: "thread.start",
          provider: "claude-code",
          worktreeId,
        }),
      }),
    ]);
    expect((calls[0] as { command: object }).command).not.toHaveProperty("shareWorktree");
  });

  it("shows inbound agent text as text and sends only inside the project", async () => {
    const source = ThreadId.parse("00000000-0000-4000-8000-000000000021");
    const target = ThreadId.parse("00000000-0000-4000-8000-000000000022");
    const otherWorktree = WorktreeId.parse("00000000-0000-4000-8000-000000000012");
    const otherProject = ProjectId.parse("00000000-0000-4000-8000-000000000013");
    const outside = ThreadId.parse("00000000-0000-4000-8000-000000000023");
    const payload = '<img src="x" onerror="alert(1)"><script>alert(1)</script>';
    const calls: unknown[] = [];
    const container = renderPane(
      projection({
        worktrees: [
          { worktreeId, projectId, path: "/repo/feature", branch: "feature", status: "ready" },
          {
            worktreeId: otherWorktree,
            projectId: otherProject,
            path: "/other",
            branch: "outside-project",
            status: "ready",
          },
        ],
        projects: [
          { projectId, path: "/repo", name: "repo" },
          { projectId: otherProject, path: "/other", name: "other" },
        ],
        threads: [
          { threadId: source, worktreeId, provider: "codex", status: "idle", capabilities: {} },
          { threadId: target, worktreeId, provider: "claude-code", status: "idle", capabilities: {} },
          { threadId: outside, worktreeId: otherWorktree, provider: "cursor-agent", status: "idle", capabilities: {} },
        ],
        messages: [
          {
            messageId: "inbound-agent",
            threadId: source,
            role: "agent",
            sourceThreadId: target,
            text: payload,
          },
        ],
      }),
      async (request) => {
        calls.push(request);
        return { commandId, accepted: true as const };
      },
    );

    const inbound = container.querySelector('[data-trust="untrusted"]');
    expect(inbound?.querySelector("script")).toBeNull();
    expect(inbound?.querySelector("img")).toBeNull();
    expect(inbound?.querySelector("p")?.innerHTML).toContain("&lt;script&gt;");
    expect(inbound?.textContent).toContain(payload);
    expect(inbound?.textContent).toContain("From another agent, feature");
    const options = [...container.querySelectorAll("#agent-peer-target option")].map((option) => option.textContent);
    expect(options).toEqual(["feature (claude-code)"]);
    expect(container.textContent).not.toContain("outside-project");

    const peerText = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message for the other agent"]');
    expect(peerText).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(peerText, "check the migration");
      peerText?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Send to thread")?.click();
    });
    expect(calls).toEqual([
      expect.objectContaining({
        command: expect.objectContaining({
          type: "thread.a2a",
          sourceThreadId: source,
          targetThreadId: target,
          text: "check the migration",
        }),
      }),
    ]);
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

  it("selects the agent already running in the worktree instead of the first found CLI", () => {
    const claudeThread = ThreadId.parse("00000000-0000-4000-8000-000000000031");
    const container = renderPane(
      projection({
        threads: [{ threadId: claudeThread, worktreeId, provider: "claude-code", status: "working", capabilities: {} }],
      }),
    );
    expect(container.querySelector<HTMLInputElement>('input[value="claude-code"]')?.checked).toBe(true);
    expect(container.querySelector("textarea")?.getAttribute("aria-label")).toBe("Message Claude Code");
  });
});
