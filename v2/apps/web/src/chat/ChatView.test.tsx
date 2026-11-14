// @vitest-environment jsdom

import { CommandId, EnvironmentId, ProjectId, type RuntimeProjection, type ThreadProjection } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { onIssueRequest } from "../issues/issueRequest.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { ChatView } from "./ChatView.js";
import { addCodeReference } from "./codeReferences.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const worktreeId = "00000000-0000-4000-8000-000000000011";
const threadId = "00000000-0000-4000-8000-000000000401";

const thread = {
  threadId,
  worktreeId,
  provider: "droid",
  status: "waiting",
  activeTurnId: "00000000-0000-4000-8000-000000000501",
  capabilities: {},
  permissionMode: "supervised",
} as ThreadProjection;

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
    threads: [thread],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
    providers: [{ provider: "droid", displayName: "Droid", status: "found", path: "droid" }],
    ...overrides,
  };
}

async function render(
  projection: RuntimeProjection,
  onOpenDiff = vi.fn(),
  results: (command: Record<string, unknown>) => unknown = () => undefined,
  active = false,
  bridgeExtras: Partial<ZliBridge> = {},
  onSwitchAgent?: (provider: string, model: string | undefined) => Promise<string | undefined>,
) {
  const dispatched: Array<{ command: Record<string, unknown> }> = [];
  const bridge = {
    runtime: {
      dispatch: async (request: { command: Record<string, unknown> }) => {
        dispatched.push(request);
        return {
          commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"),
          accepted: true as const,
          result: results(request.command),
        };
      },
      getProjection: async () => projection,
      onProjection: () => () => undefined,
      attachTerminal: async () => ({ accepted: true }),
      onTerminal: () => () => undefined,
    },
    ...bridgeExtras,
  } as unknown as ZliBridge;
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <RuntimeProvider bridge={bridge}>
        <ChatView
          projection={projection}
          thread={projection.threads[0] as ThreadProjection}
          worktree={projection.worktrees[0]}
          onOpenDiff={onOpenDiff}
          onRestart={() => undefined}
          onSwitchAgent={onSwitchAgent}
          active={active}
        />
      </RuntimeProvider>,
    );
  });
  return { container, dispatched, onOpenDiff };
}

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );

afterEach(() => document.body.replaceChildren());

describe("ChatView", () => {
  it("offers the signed-in agents' models before the first message and moves the chat to the one picked", async () => {
    const idle = { ...thread, status: "idle", activeTurnId: undefined } as ThreadProjection;
    const onSwitchAgent = vi.fn(async () => undefined);
    const { container } = await render(
      projectionWith({
        threads: [idle],
        providers: [
          { provider: "droid", displayName: "Droid", status: "found", path: "droid" },
          {
            provider: "claude-code",
            displayName: "Claude Code",
            status: "found",
            path: "claude",
            models: [{ id: "opus", label: "Opus" }],
            login: { status: "signed-in", method: "subscription", plan: "max" },
          },
          { provider: "gemini", displayName: "Gemini", status: "found", path: "gemini" },
          {
            provider: "codex",
            displayName: "Codex",
            status: "found",
            path: "codex",
            login: { status: "signed-out" },
          },
        ],
      }),
      vi.fn(),
      () => undefined,
      false,
      {},
      onSwitchAgent,
    );
    await act(async () => button(container, "Model: Default model")?.click());
    const agents = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Agent"] [role="option"]')];
    // Gemini's login cannot be read, so it is given the chance; Codex is signed out, so it is left out.
    expect(agents.map((agent) => agent.dataset.label)).toEqual(["Droid", "Claude Code", "Gemini"]);
    expect(agents[1]?.textContent).toContain("Max");
    const models = () =>
      [...document.querySelectorAll<HTMLButtonElement>('[aria-label$=" models"] [role="option"]')].map(
        (option) => option.dataset.label,
      );
    expect(models()).toEqual(["Default model"]);
    await act(async () => agents[1]?.focus());
    expect(models()).toEqual(["Default model", "Opus"]);
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
        .find((option) => option.dataset.label === "Opus")
        ?.click(),
    );
    expect(onSwitchAgent).toHaveBeenCalledWith("claude-code", "opus");
  });

  it("offers other agents in a started chat once the agent is idle, but not while it works", async () => {
    const providers = [
      { provider: "droid", displayName: "Droid", status: "found", path: "droid" },
      {
        provider: "claude-code",
        displayName: "Claude Code",
        status: "found",
        path: "claude",
        models: [{ id: "opus", label: "Opus" }],
        login: { status: "signed-in", method: "subscription" },
      },
    ] as RuntimeProjection["providers"];
    const messages = [
      { messageId: "m1", threadId, role: "user", text: "Check the cache" },
      { messageId: "m2", threadId, turnId: "t1", role: "assistant", text: "It is stale." },
    ] as RuntimeProjection["messages"];
    const agentNames = () =>
      [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Agent"] [role="option"]')].map(
        (agent) => agent.dataset.label,
      );
    const onSwitchAgent = vi.fn(async () => undefined);
    const idle = await render(
      projectionWith({ threads: [{ ...thread, status: "idle", activeTurnId: undefined }], providers, messages }),
      vi.fn(),
      () => undefined,
      false,
      {},
      onSwitchAgent,
    );
    const trigger = idle.container.querySelector<HTMLButtonElement>(".composer-model");
    expect(trigger?.dataset.tooltip).toContain("goes with your next message");
    await act(async () => trigger?.click());
    expect(agentNames()).toEqual(["Droid", "Claude Code"]);
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
        .find((option) => option.dataset.agent === "claude-code")
        ?.focus(),
    );
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
        .find((option) => option.dataset.label === "Opus")
        ?.click(),
    );
    expect(onSwitchAgent).toHaveBeenCalledWith("claude-code", "opus");

    const busy = await render(
      projectionWith({ threads: [{ ...thread, status: "working" }], providers, messages }),
      vi.fn(),
      () => undefined,
      false,
      {},
      vi.fn(async () => undefined),
    );
    await act(async () => busy.container.querySelector<HTMLButtonElement>(".composer-model")?.click());
    expect(document.querySelector('[aria-label="Agent"]')).toBeNull();
  });

  it("tells the person to sign in when the chat's agent is signed out", async () => {
    const { container } = await render(
      projectionWith({
        providers: [
          { provider: "codex", displayName: "Codex", status: "found", path: "codex", login: { status: "signed-out" } },
        ],
        threads: [{ ...thread, provider: "codex" } as ThreadProjection],
      }),
    );
    const notice = container.querySelector(".chat-sign-in");
    expect(notice?.textContent).toContain("Codex is not signed in");
    expect(notice?.querySelector("code")?.textContent).toBe("codex login");
    expect(button(container, "Check again")).toBeDefined();
    expect(button(container, "Accounts")).toBeDefined();
    // The message box still takes typing, but nothing can be sent until the agent can run.
    expect(container.querySelector<HTMLButtonElement>(".send-button")?.disabled).toBe(true);
  });

  it("says the agent has no active plan when its last run said so, and lets the person try again", async () => {
    const { container } = await render(
      projectionWith({
        providers: [
          {
            provider: "codex",
            displayName: "Codex",
            status: "found",
            path: "codex",
            login: { status: "signed-in", method: "subscription", email: "kim@example.com", plan: "free" },
            problem: { kind: "no-plan", message: "Upgrade to Plus to use Codex.", at: "2026-11-12T10:00:00.000Z" },
          },
        ],
        threads: [{ ...thread, provider: "codex" } as ThreadProjection],
      }),
    );
    const notice = container.querySelector(".chat-sign-in");
    expect(notice?.textContent).toContain("Codex has no active plan");
    expect(notice?.textContent).toContain("“Upgrade to Plus to use Codex.”");
    expect(button(container, "Try again")).toBeDefined();
    expect(container.querySelector<HTMLButtonElement>(".send-button")?.disabled).toBe(true);
  });

  it("keeps the composer for a stopped chat that can resume, and offers New chat otherwise", async () => {
    const stopped = { ...thread, status: "stopped", providerSessionId: "conv-1" } as ThreadProjection;
    const resumable = await render(projectionWith({ threads: [stopped] }));
    // A stopped chat says nothing about being stopped; the message box is the way on.
    expect(resumable.container.querySelector(".chat-note")).toBeNull();
    expect(resumable.container.querySelector('textarea[aria-label="Message Droid"]')).not.toBeNull();
    expect(button(resumable.container, "New chat")).toBeUndefined();
    document.body.replaceChildren();

    const { providerSessionId: _id, ...withoutId } = stopped;
    const ended = await render(projectionWith({ threads: [withoutId as ThreadProjection] }));
    expect(ended.container.querySelector(".chat-note")).toBeNull();
    expect(ended.container.querySelector('textarea[aria-label="Message Droid"]')).toBeNull();
    expect(button(ended.container, "New chat")).toBeDefined();
  });

  it("shows the turn's work log and changed files, and opens a diff from them", async () => {
    const turnId = thread.activeTurnId as string;
    const { container, onOpenDiff } = await render(
      projectionWith({
        messages: [
          { messageId: "m1", threadId, turnId, role: "user", text: "Rename the helper" },
          { messageId: "m2", threadId, turnId, role: "assistant", text: "Renamed **helper**." },
        ] as RuntimeProjection["messages"],
        activities: [
          { activityId: "a1", threadId, turnId, kind: "command", title: "npm test", status: "completed" },
          {
            activityId: "a2",
            threadId,
            turnId,
            kind: "file-edit",
            title: "Edit src/helper.ts",
            status: "completed",
            files: ["src/helper.ts"],
          },
        ] as RuntimeProjection["activities"],
      }),
    );
    expect(container.querySelector('[aria-label="Steps"]')?.textContent).toContain("npm test");
    const changed = container.querySelector('[aria-label="Changed files"]');
    expect(changed?.textContent).toContain("1 file changed");
    expect(container.querySelector(".markdown strong")?.textContent).toBe("helper");
    await act(async () => button(container, "Open diff")?.click());
    expect(onOpenDiff).toHaveBeenCalledWith();
    await act(async () => changed?.querySelector<HTMLButtonElement>("li button")?.click());
    expect(onOpenDiff).toHaveBeenLastCalledWith("src/helper.ts");
  });

  it("offers a sign-in for the latest call that needed one, and hides it on Not now", async () => {
    const turnId = thread.activeTurnId as string;
    const linear = {
      name: "linear",
      enabled: true,
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      headers: {},
      oauth: true,
    };
    const { container, dispatched } = await render(
      projectionWith({
        threads: [{ ...thread, status: "idle" }],
        activities: [
          {
            activityId: "a1",
            threadId,
            turnId,
            kind: "tool",
            title: "list_issues",
            status: "failed",
            connector: { server: "linear", reason: "sign-in" },
          },
        ] as RuntimeProjection["activities"],
      }),
      vi.fn(),
      (command) =>
        command.type === "mcp.list"
          ? {
              servers: [linear],
              agentAccess: "full",
              signIns: [{ name: "linear", url: linear.url, signedIn: false }],
            }
          : undefined,
    );
    expect(dispatched.map((request) => request.command.type)).toContain("mcp.list");
    expect(container.querySelector(".chat-connector")?.textContent).toContain("Linear needs you to sign in");
    await act(async () => button(container, "Not now")?.click());
    expect(container.querySelector(".chat-connector")).toBeNull();
  });

  it("places steps inside the reply, shows the running step, and stops the turn", async () => {
    const turnId = thread.activeTurnId as string;
    const { container, dispatched } = await render(
      projectionWith({
        threads: [{ ...thread, status: "working" }],
        messages: [
          { messageId: "m1", threadId, turnId, role: "user", text: "Fix the tests" },
          { messageId: "m2", threadId, turnId, role: "assistant", text: "Looking first.Fixed the helper." },
        ] as RuntimeProjection["messages"],
        activities: [
          {
            activityId: "a1",
            threadId,
            turnId,
            kind: "file-edit",
            title: "Edit src/helper.ts",
            status: "completed",
            files: ["src/helper.ts"],
            lines: { added: 3, removed: 1 },
            textOffset: 14,
          },
          {
            activityId: "a2",
            threadId,
            turnId,
            kind: "command",
            title: "Run the tests",
            command: "npm test",
            status: "running",
            textOffset: 31,
          },
        ] as unknown as RuntimeProjection["activities"],
      }),
    );
    const order = [...container.querySelectorAll(".chat-message-assistant, .work-steps")].map((node) =>
      node.classList.contains("work-steps") ? `steps:${node.textContent}` : node.textContent,
    );
    expect(order).toEqual([
      "Looking first.",
      "steps:Edit 4 lines helper.ts+3-1",
      "Fixed the helper.",
      "steps:Run the tests",
    ]);
    expect(container.querySelector(".chat-working-label")?.textContent).toBe("Run the tests");
    expect(container.querySelector(".step.is-running .shimmer-text")?.textContent).toBe("Run the tests");
    expect(container.querySelector(".step.is-running .spinner")).toBeNull();
    await act(async () => button(container, "Stop Droid")?.click());
    expect(dispatched.at(-1)?.command).toMatchObject({ type: "thread.interrupt", threadId, turnId });
  });

  it("lists a turn's changed files with their diff and restores the files after confirming", async () => {
    const turnId = "provider-turn-7";
    const checkpointId = "00000000-0000-4000-8000-000000000777";
    const patch = ["diff --git a/README.md b/README.md", "@@ -1 +1 @@", "-base", "+changed", ""].join("\n");
    const { container, dispatched } = await render(
      projectionWith({
        threads: [{ ...thread, status: "idle" }],
        messages: [
          { messageId: "m1", threadId, role: "user", text: "Update the readme" },
          { messageId: "m2", threadId, turnId, role: "assistant", text: "Updated it." },
          { messageId: "m3", threadId, role: "user", text: "Thanks" },
        ] as RuntimeProjection["messages"],
        checkpoints: [
          {
            checkpointId,
            threadId,
            worktreeId,
            turnId,
            startTree: "a".repeat(40),
            endTree: "b".repeat(40),
            files: [
              { path: "README.md", kind: "modified", additions: 1, deletions: 1, binary: false },
              { path: "docs/new.md", kind: "added", additions: 4, deletions: 0, binary: false },
            ],
            fileCount: 2,
            additions: 5,
            deletions: 1,
          },
        ] as RuntimeProjection["checkpoints"],
      }),
      vi.fn(),
      (command) =>
        command.type === "checkpoint.diff"
          ? { path: "README.md", binary: false, patch, truncated: false }
          : { changedFiles: 2 },
    );
    const changes = container.querySelector<HTMLElement>('[aria-label="Changes in this turn"]');
    expect(changes?.textContent).toContain("2 files changed");
    // The card follows the turn's reply, before the next message.
    const order = [...container.querySelectorAll(".chat-message, .turn-changes")].map((node) => node.className);
    expect(order).toEqual([
      "chat-message chat-message-user",
      "chat-message chat-message-assistant",
      "turn-changes",
      "chat-message chat-message-user",
    ]);
    await act(async () => changes?.querySelector<HTMLButtonElement>(".turn-file")?.click());
    expect(dispatched.at(-1)?.command).toEqual({ type: "checkpoint.diff", checkpointId, path: "README.md" });
    const diff = container.querySelector('[aria-label="Diff for README.md"]');
    expect([...(diff?.querySelectorAll(".diff-line") ?? [])].map((line) => line.className)).toEqual([
      "diff-line is-hunk",
      "diff-line is-del",
      "diff-line is-add",
    ]);
    // The lines take review comments like the Changes panel.
    expect(diff?.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe("Lines of README.md");

    await act(async () => button(changes as HTMLElement, "Restore")?.click());
    const dialog = document.querySelector('[role="dialog"][aria-label="Restore files"]');
    expect(dialog?.textContent).toContain("This turn changed 2 files.");
    await act(async () => button(dialog as HTMLElement, "Restore files")?.click());
    expect(dispatched.at(-1)?.command).toEqual({ type: "checkpoint.restore", checkpointId });
    expect(document.querySelector('[aria-label="Restore files"]')).toBeNull();
  });

  it("blocks restoring while an agent in the worktree is working", async () => {
    const { container } = await render(
      projectionWith({
        threads: [{ ...thread, status: "working" }],
        messages: [
          { messageId: "m2", threadId, turnId: "t1", role: "assistant", text: "Done." },
        ] as RuntimeProjection["messages"],
        checkpoints: [
          {
            checkpointId: "00000000-0000-4000-8000-000000000778",
            threadId,
            worktreeId,
            turnId: "t1",
            startTree: "a".repeat(40),
            endTree: "b".repeat(40),
            files: [{ path: "a.ts", kind: "modified", additions: 1, deletions: 0, binary: false }],
            fileCount: 1,
            additions: 1,
            deletions: 0,
          },
        ] as RuntimeProjection["checkpoints"],
      }),
    );
    expect(button(container, "Restore")?.disabled).toBe(true);
  });

  it("answers an approval request", async () => {
    const { container, dispatched } = await render(
      projectionWith({
        requests: [
          { requestId: "r1", threadId, kind: "approval", payload: { command: "rm -rf build" } },
        ] as unknown as RuntimeProjection["requests"],
      }),
    );
    expect(container.querySelector('[aria-label="Approval request"]')?.textContent).toContain("rm -rf build");
    await act(async () => button(container, "Approve")?.click());
    expect(dispatched.at(-1)?.command).toEqual({
      type: "thread.respond",
      threadId,
      requestId: "r1",
      decision: { approved: true },
    });
  });

  it("sends composer text and shows the session's permission mode", async () => {
    const { container, dispatched } = await render(projectionWith({ threads: [{ ...thread, status: "idle" }] }));
    expect(container.querySelector(".composer-badge")?.textContent).toContain("Edit files");
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Droid"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "run the tests");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(container, "Send")?.click());
    expect(dispatched.at(-1)?.command).toEqual({
      type: "thread.queue",
      queueId: expect.any(String),
      threadId,
      text: "run the tests",
    });
  });

  it("shows a chat that moved to another agent as one conversation, and brings the new agent up to date", async () => {
    const takeover = {
      ...thread,
      threadId: "00000000-0000-4000-8000-000000000402",
      provider: "claude-code",
      status: "idle",
      activeTurnId: undefined,
      model: "opus",
      continues: threadId,
    } as ThreadProjection;
    const { container, dispatched } = await render(
      projectionWith({
        threads: [takeover, { ...thread, status: "stopped", activeTurnId: undefined }],
        providers: [
          { provider: "droid", displayName: "Droid", status: "found", path: "droid" },
          {
            provider: "claude-code",
            displayName: "Claude Code",
            status: "found",
            path: "claude",
            models: [{ id: "opus", label: "Opus" }],
          },
        ],
        messages: [
          { messageId: "m1", threadId, role: "user", text: "Why is the home page stale?" },
          { messageId: "m2", threadId, turnId: "t1", role: "assistant", text: "Its cached copy is a day old." },
        ] as RuntimeProjection["messages"],
      }),
    );
    expect([...container.querySelectorAll(".chat-message-user, .chat-switch")].map((row) => row.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Why is the home page stale?")]),
    );
    expect(container.querySelector(".chat-switch")?.textContent).toBe("Switched from Droid to Claude Code · Opus");
    expect(container.textContent).toContain("Its cached copy is a day old.");
    // Nothing was sent when the chat moved: the new agent waits for the person.
    expect(dispatched.filter((entry) => String(entry.command.type).startsWith("thread."))).toEqual([]);

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Claude Code"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "Redeploy it");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(container, "Send")?.click());
    const sent = dispatched.at(-1)?.command as { text: string; context?: string; threadId: string };
    expect(sent.threadId).toBe(takeover.threadId);
    expect(sent.text).toBe("Redeploy it");
    expect(sent.context).toContain("You are taking over this chat from Droid");
    expect(sent.context).toContain("## User\n\nWhy is the home page stale?");
    expect(sent.context).toContain("## Droid\n\nIts cached copy is a day old.");
  });

  it("attaches files, a window, or an issue from the paperclip", async () => {
    const sources = vi.fn(async () => []);
    const { container } = await render(
      projectionWith({ threads: [{ ...thread, status: "idle" }] }),
      vi.fn(),
      () => undefined,
      false,
      { capture: { sources, take: vi.fn() } },
    );
    expect(button(container, "Add files and more")).toBeUndefined();
    const attach = button(container, "Attach");
    expect(attach?.getAttribute("aria-haspopup")).toBe("menu");
    const items = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')];
    await act(async () => attach?.click());
    expect(items().map((item) => item.querySelector(".menu-item-label")?.textContent)).toEqual([
      "Files",
      "A window",
      "An issue",
    ]);
    // An issue is picked by the app shell, which hears the request and opens its issue picker.
    const asked = vi.fn();
    const stop = onIssueRequest(asked);
    await act(async () => items()[2]?.click());
    stop();
    expect(asked).toHaveBeenCalledTimes(1);
    await act(async () => attach?.click());

    const pickFiles = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    await act(async () => items()[0]?.click());
    expect(pickFiles).toHaveBeenCalledTimes(1);
    pickFiles.mockRestore();
    expect(document.querySelector('[role="menu"]')).toBeNull();

    await act(async () => attach?.click());
    await act(async () => items()[1]?.click());
    // The window picker loads on first use.
    for (let tick = 0; tick < 50 && !container.querySelector('section[aria-label="Attach a window"]'); tick += 1)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(container.querySelector('section[aria-label="Attach a window"]')).not.toBeNull();
    expect(sources).toHaveBeenCalledTimes(1);
  });

  it("dims an unset model, marks it with the agent's logo, and tints only the Full access lock", async () => {
    const { container } = await render(
      projectionWith({ threads: [{ ...thread, status: "idle", permissionMode: "full-access" }] }),
    );
    const model = button(container, "Model: Default model");
    expect(model?.classList.contains("is-default")).toBe(true);
    expect(model?.querySelector(`.provider-mark-${thread.provider}`)).not.toBeNull();
    const badge = container.querySelector(".composer-badge");
    expect(badge?.querySelector(".permission-icon")?.getAttribute("class")).toContain("is-full-access");
    expect(badge?.getAttribute("data-tooltip")).toContain("without asking");
  });

  it("sends file references from the Files panel ahead of the message, then clears them", async () => {
    const { container, dispatched } = await render(projectionWith({ threads: [{ ...thread, status: "idle" }] }));
    await act(async () => {
      addCodeReference(threadId, {
        path: "src/app.ts",
        startLine: 3,
        endLine: 4,
        snippet: "const a = 1;\nconst b = 2;",
      });
      addCodeReference(threadId, { path: "README.md" });
    });
    const chips = () => [...container.querySelectorAll(".composer-attachments li")].map((item) => item.textContent);
    expect(chips()).toEqual(["app.ts:3-4src", "README.mdWorktree root"]);
    await act(async () => button(container, "Remove README.md")?.click());
    expect(chips()).toEqual(["app.ts:3-4src"]);

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Droid"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "Why two constants?");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(container, "Send")?.click());
    expect(dispatched.at(-1)?.command).toMatchObject({
      type: "thread.queue",
      text: "`src/app.ts` lines 3-4:\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nWhy two constants?",
    });
    expect(chips()).toEqual([]);
  });

  it("attaches picked and dropped files as cards and sends their paths after the message", async () => {
    const pdf = "C:\\Users\\USER\\Downloads\\Ros MengHeang (1).pdf";
    const sheet = "C:\\Users\\USER\\Desktop\\budget.xlsx";
    const paths = new Map<File, string>();
    // The composer asks the desktop app for a dropped file's path, which only it can see.
    vi.stubGlobal("zli", { pathForFile: (file: File) => paths.get(file) ?? "" });
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const { container, dispatched } = await render(projectionWith({ threads: [{ ...thread, status: "idle" }] }));
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Droid"]');
    const picked = new File(["%PDF-1.7"], "Ros MengHeang (1).pdf", { type: "application/pdf" });
    paths.set(picked, pdf);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [picked] });
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(textarea?.value).toBe("");
    const cards = () =>
      [...container.querySelectorAll(".composer-attachments li")].map((item) => [
        item.querySelector(".file-badge")?.textContent,
        item.querySelector(".composer-attachment-label")?.textContent,
      ]);
    expect(cards()).toEqual([["pdf", "Ros MengHeang (1).pdfDownloads · 8 bytes"]]);

    const dropped = new File(["xlsx"], "budget.xlsx", { type: "" });
    paths.set(dropped, sheet);
    const form = container.querySelector<HTMLFormElement>("form.composer");
    const drag = (type: string, files: File[] = []) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files } });
      form?.dispatchEvent(event);
    };
    await act(async () => drag("dragenter"));
    expect(container.querySelector(".composer-drop")?.textContent).toBe("Drop to attach");
    await act(async () => drag("drop", [dropped, picked]));
    expect(container.querySelector(".composer-drop")).toBeNull();
    expect(textarea?.value).toBe("");
    expect(cards().map(([badge]) => badge)).toEqual(["pdf", "xlsx"]);

    // An image tile shows only its picture, but its name stays in the list for screen readers.
    const image = new File(["png"], "window.png", { type: "image/png" });
    await act(async () => drag("drop", [image]));
    expect(container.querySelector(".composer-attachment.is-image")?.textContent).toBe("window.png");
    await act(async () => button(container, "Remove window.png")?.click());
    expect(container.querySelector(".composer-attachment.is-image")).toBeNull();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "Compare these");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(container, "Send")?.click());
    expect(dispatched.at(-1)?.command).toMatchObject({
      type: "thread.queue",
      text: `Compare these\n\nAttached files:\n- \`${pdf}\`\n- \`${sheet}\``,
    });
    expect(dispatched.at(-1)?.command).not.toHaveProperty("attachments");
    expect(cards()).toEqual([]);
  });

  it("shows a sent message's pictures as thumbnails and its files as cards above what the person typed", async () => {
    const { container, dispatched } = await render(
      projectionWith({
        threads: [{ ...thread, status: "idle" }],
        messages: [
          {
            messageId: "m1",
            threadId,
            role: "user",
            text: "Read this\n\nAttached files:\n- `C:\\Users\\USER\\Downloads\\report.pdf`",
            attachments: [{ name: "shot.png", mimeType: "image/png", path: "/data/a.png" }],
          },
        ] as RuntimeProjection["messages"],
      }),
      undefined,
      (command) =>
        command.type === "thread.attachment.read"
          ? { name: "shot.png", mimeType: "image/png", size: 4, dataBase64: "AAAA" }
          : undefined,
    );
    const message = container.querySelector(".chat-message-user");
    await vi.waitFor(() =>
      expect(message?.querySelector(".chat-attachment-pictures img")?.getAttribute("src")).toBe(
        "data:image/png;base64,AAAA",
      ),
    );
    expect(dispatched.map((entry) => entry.command)).toContainEqual({
      type: "thread.attachment.read",
      threadId,
      path: "/data/a.png",
    });
    expect([...(message?.querySelectorAll(".chat-attachments li") ?? [])].map((item) => item.textContent)).toEqual([
      "report.pdf",
    ]);
    expect(message?.querySelector(".chat-attachments li:last-child")?.getAttribute("title")).toBe(
      "C:\\Users\\USER\\Downloads\\report.pdf",
    );
    expect(message?.querySelector("p")?.textContent).toBe("Read this");
  });

  it("folds the steps of earlier turns into one line that opens, and keeps the latest turn's steps in view", async () => {
    const { container } = await render(
      projectionWith({
        threads: [{ ...thread, status: "idle" }],
        messages: [
          { messageId: "m1", threadId, role: "user", text: "Rename the helper" },
          { messageId: "m2", threadId, turnId: "t1", role: "assistant", text: "Renamed it." },
          { messageId: "m3", threadId, role: "user", text: "Now run the tests" },
          { messageId: "m4", threadId, turnId: "t2", role: "assistant", text: "They pass." },
        ] as RuntimeProjection["messages"],
        activities: [
          {
            activityId: "a1",
            threadId,
            turnId: "t1",
            kind: "file-edit",
            title: "Edit src/helper.ts",
            status: "completed",
            files: ["src/helper.ts"],
          },
          { activityId: "a2", threadId, turnId: "t2", kind: "command", title: "npm test", status: "completed" },
        ] as RuntimeProjection["activities"],
      }),
    );
    const fold = container.querySelector<HTMLButtonElement>(".turn-fold-row");
    expect(fold?.textContent).toBe("Edited helper.ts");
    expect(fold?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll('[aria-label="Steps"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="Steps"]')?.textContent).toContain("npm test");
    await act(async () => fold?.click());
    expect(container.querySelectorAll('[aria-label="Steps"]')).toHaveLength(2);
    expect(container.querySelector(".turn-fold-body")?.textContent).toContain("helper.ts");
  });

  it("reads the agent's latest line of thought under the chat and times the turn from its start", async () => {
    const turnId = thread.activeTurnId as string;
    const { container } = await render(
      projectionWith({
        threads: [{ ...thread, status: "working" }],
        messages: [
          { messageId: "m1", threadId, turnId, role: "user", text: "Fix the cache" },
        ] as RuntimeProjection["messages"],
        activities: [
          {
            activityId: "k1",
            threadId,
            turnId,
            kind: "reasoning",
            title: "Thinking",
            status: "running",
            text: "**Plan**\n\nCheck how the fetches are tagged.",
          },
        ] as RuntimeProjection["activities"],
        turns: [
          { threadId, turnId, startedAt: new Date(Date.now() - 75_000).toISOString() },
        ] as RuntimeProjection["turns"],
      }),
    );
    const label = container.querySelector(".chat-working-label");
    expect(label?.textContent).toBe("Check how the fetches are tagged.");
    expect(label?.classList.contains("shimmer-text")).toBe(true);
    expect(container.querySelector(".chat-working-time")?.textContent).toBe("1m 15s");
    expect(container.querySelector(".thought-label")?.textContent).toBe("Thinking…");
  });

  it("says how long finished turns worked, and lists and cites the pages a turn searched", async () => {
    const url = "https://nextjs.org/docs/revalidate";
    const { container } = await render(
      projectionWith({
        threads: [{ ...thread, status: "idle" }],
        messages: [
          { messageId: "m1", threadId, role: "user", text: "Rename the helper" },
          { messageId: "m2", threadId, turnId: "t1", role: "assistant", text: "Renamed it." },
          { messageId: "m3", threadId, role: "user", text: "Why are pages stale?" },
          { messageId: "m4", threadId, turnId: "t2", role: "assistant", text: `The fetch is [not tagged](${url}).` },
        ] as RuntimeProjection["messages"],
        activities: [
          { activityId: "a1", threadId, turnId: "t1", kind: "command", title: "npm test", status: "completed" },
          {
            activityId: "a2",
            threadId,
            turnId: "t2",
            kind: "web",
            title: "Search the web",
            status: "completed",
            urls: [{ url, title: "revalidateTag" }],
          },
        ] as RuntimeProjection["activities"],
        turns: [
          { threadId, turnId: "t1", startedAt: "2026-01-01T12:00:00.000Z", completedAt: "2026-01-01T12:01:05.000Z" },
          { threadId, turnId: "t2", startedAt: "2026-01-01T12:02:00.000Z", completedAt: "2026-01-01T12:02:14.000Z" },
        ] as RuntimeProjection["turns"],
      }),
    );
    expect(container.querySelector(".turn-fold-time")?.textContent).toBe("Worked for 1m 05s");
    expect([...container.querySelectorAll(".chat-reply-time")].map((node) => node.textContent)).toEqual([
      "Worked for 14s",
    ]);
    expect(container.querySelector(".sources-toggle")?.textContent).toBe("Sources (1)");
    expect(container.querySelector(".chat-message-assistant .md-cite")?.textContent).toBe("1");
  });

  it("copies a finished reply, and offers no copy while the reply is still being written", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const messages = [
      { messageId: "m1", threadId, role: "user", text: "Explain the route" },
      { messageId: "m2", threadId, turnId: "t1", role: "assistant", text: "It answers **ok**." },
    ] as RuntimeProjection["messages"];
    const done = await render(projectionWith({ threads: [{ ...thread, status: "idle" }], messages }));
    await act(async () => done.container.querySelector<HTMLButtonElement>('[aria-label="Copy reply"]')?.click());
    expect(writeText).toHaveBeenCalledWith("It answers **ok**.");
    await act(async () => done.container.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')?.click());
    expect(writeText).toHaveBeenLastCalledWith("Explain the route");

    const live = await render(projectionWith({ threads: [{ ...thread, status: "working" }], messages }));
    expect(live.container.querySelector('[aria-label="Copy reply"]')).toBeNull();
  });

  it("lists the sent messages on a rail once the chat is long, and opens web links in the browser", async () => {
    const openExternal = vi.fn(async () => undefined);
    const { container } = await render(
      projectionWith({
        threads: [{ ...thread, status: "idle" }],
        messages: [
          { messageId: "m1", threadId, role: "user", text: "First question" },
          { messageId: "m2", threadId, turnId: "t1", role: "assistant", text: "See https://example.com/docs." },
          { messageId: "m3", threadId, role: "user", text: "Second question\nwith detail" },
          { messageId: "m4", threadId, turnId: "t2", role: "assistant", text: "| A | B |\n| - | - |\n| 1 | 2 |" },
          { messageId: "m5", threadId, role: "user", text: "Third question" },
        ] as RuntimeProjection["messages"],
      }),
      undefined,
      undefined,
      false,
      { app: { openExternal } } as unknown as Partial<ZliBridge>,
    );
    expect([...container.querySelectorAll(".turn-rail-text")].map((item) => item.textContent)).toEqual([
      "First question",
      "Second question",
      "Third question",
    ]);
    expect(container.querySelector(".md-table td")?.textContent).toBe("1");
    const link = container.querySelector<HTMLButtonElement>("button.md-link");
    expect(link?.textContent).toBe("https://example.com/docs");
    await act(async () => link?.click());
    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("queues messages while the agent works and can send one now or remove it", async () => {
    const { container, dispatched } = await render(
      projectionWith({
        threads: [{ ...thread, status: "working" }],
        queuedMessages: [
          { queueId: "q1", threadId, text: "Then update the docs\nwith examples" },
          { queueId: "q2", threadId, text: "Also bump the version" },
        ] as RuntimeProjection["queuedMessages"],
      }),
    );
    const queue = container.querySelector('[aria-label="Queued messages"]');
    expect(queue?.textContent).toContain("2 queued messages");
    expect([...(queue?.querySelectorAll(".chat-queue-text") ?? [])].map((item) => item.textContent)).toEqual([
      "Then update the docs",
      "Also bump the version",
    ]);
    expect(button(container, "Queue message")).toBeDefined();
    await act(async () => button(container, "Send now: Also bump the version")?.click());
    expect(dispatched.at(-1)?.command).toEqual({ type: "thread.steer", threadId, queueId: "q2" });
    await act(async () => button(container, "Remove from queue: Then update the docs")?.click());
    expect(dispatched.at(-1)?.command).toEqual({ type: "thread.queue.remove", threadId, queueId: "q1" });
  });

  it("shows a message sent while the agent starts in the conversation, not in a queue", async () => {
    const { container } = await render(
      projectionWith({
        threads: [{ ...thread, status: "starting" }],
        queuedMessages: [
          { queueId: "q1", threadId, text: "Add a health check" },
        ] as RuntimeProjection["queuedMessages"],
      }),
    );
    expect(container.querySelector('[aria-label="Queued messages"]')).toBeNull();
    expect(container.querySelector(".chat-message-user")?.textContent).toContain("Add a health check");
    // The start-up reads as the turn itself: the person sees their message and the agent working on it.
    expect(container.querySelector(".chat-working-label")?.textContent).toBe("Working");
    expect(container.querySelector(".chat-start")).toBeNull();
  });

  it("keeps the queue behind the agent's request, one card above the box at a time", async () => {
    const { container } = await render(
      projectionWith({
        requests: [
          { requestId: "r1", threadId, kind: "approval", payload: {} },
        ] as unknown as RuntimeProjection["requests"],
        queuedMessages: [{ queueId: "q1", threadId, text: "next" }] as RuntimeProjection["queuedMessages"],
      }),
    );
    expect(container.querySelectorAll(".chat-slot-item")).toHaveLength(1);
    expect(container.querySelector(".chat-request")).not.toBeNull();
    expect(container.querySelector('[aria-label="Queued messages"]')).toBeNull();
  });

  it("switches permission mode for the next message when the provider allows it", async () => {
    const { container, dispatched } = await render(
      projectionWith({ threads: [{ ...thread, status: "idle", capabilities: { permissionSwitch: "in-session" } }] }),
    );
    expect(container.querySelector(".composer-badge")).toBeNull();
    const trigger = button(container, "Permissions: Edit files");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger?.click());
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="listbox"] [role="option"]')];
    expect(options.map((option) => option.querySelector(".picker-option-label")?.textContent)).toEqual([
      "Read only",
      "Edit files",
      "Full access",
    ]);
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(options[1]);
    await act(async () => options[2]?.click());
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger?.getAttribute("aria-label")).toBe("Permissions: Full access");
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Droid"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "go ahead");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(container, "Send")?.click());
    expect(dispatched.at(-1)?.command).toEqual({
      type: "thread.queue",
      queueId: expect.any(String),
      threadId,
      text: "go ahead",
      permissionMode: "full-access",
    });
  });

  it("picks a model from a menu that shows each maker's logo", async () => {
    const { container, dispatched } = await render(
      projectionWith({
        threads: [{ ...thread, status: "idle" }],
        providers: [
          {
            provider: "droid",
            displayName: "Droid",
            status: "found",
            path: "droid",
            models: [
              { id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
              { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
              { id: "glm-4.6", label: "GLM-4.6" },
              { id: "house-model", label: "House model" },
            ],
          },
        ],
      }),
    );
    const trigger = button(container, "Model: Default model");
    await act(async () => trigger?.click());
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="listbox"] [role="option"]')];
    expect(options.map((option) => option.querySelector(".provider-mark")?.getAttribute("class") ?? "generic")).toEqual(
      [
        "provider-mark provider-mark-droid",
        "provider-mark provider-mark-claude-code",
        "provider-mark provider-mark-openai",
        "provider-mark provider-mark-zai",
        "generic",
      ],
    );
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(options[1]);
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger?.click());
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
        .find((option) => option.textContent === "GPT-5.1 Codex")
        ?.click(),
    );
    expect(button(container, "Model: GPT-5.1 Codex")?.querySelector(".provider-mark-openai")).not.toBeNull();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Droid"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "hi");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(container, "Send")?.click());
    expect(dispatched.at(-1)?.command).toMatchObject({ type: "thread.queue", text: "hi", model: "gpt-5.1-codex" });
  });
  it("shows a Claude tool request in plain words and can allow the tool for the chat", async () => {
    const { container, dispatched } = await render(
      projectionWith({
        threads: [{ ...thread, provider: "claude-code" }],
        requests: [
          {
            requestId: "r2",
            threadId,
            kind: "approval",
            payload: { toolName: "Bash", input: { command: "pnpm test", description: "Run the tests" } },
          },
          { requestId: "r3", threadId, kind: "approval", payload: { toolName: "Write", input: {} } },
        ] as unknown as RuntimeProjection["requests"],
      }),
    );
    const card = container.querySelector('[aria-label="Approval request"]');
    expect(card?.querySelector(".chat-request-heading")?.textContent).toBe("Run a command");
    expect(card?.textContent).toContain("pnpm test");
    expect(card?.querySelector(".chat-request-count")?.textContent).toBe("1 of 2");
    // The card pages through every open request, and comes back to the first. The others stay mounted but
    // hidden, so what was typed into one is still there when it comes back.
    const shown = () => [...container.querySelectorAll("section.chat-request")].find((el) => !el.closest("[hidden]"));
    await act(async () => button(container, "Next request")?.click());
    expect(shown()?.querySelector(".chat-request-count")?.textContent).toBe("2 of 2");
    expect(shown()?.querySelector(".chat-request-heading")?.textContent).not.toBe("Run a command");
    expect(container.querySelectorAll("section.chat-request")).toHaveLength(2);
    await act(async () => button(container, "Previous request")?.click());
    expect(shown()?.querySelector(".chat-request-heading")?.textContent).toBe("Run a command");
    await act(async () => button(container, "Allow Bash for this chat")?.click());
    expect(dispatched.at(-1)?.command).toEqual({
      type: "thread.respond",
      threadId,
      requestId: "r2",
      decision: { approved: true, scope: "session" },
    });
  });

  it("answers structured questions with option picks and typed text", async () => {
    const { container, dispatched } = await render(
      projectionWith({
        threads: [{ ...thread, provider: "codex" }],
        requests: [
          {
            requestId: "r4",
            threadId,
            kind: "user-input",
            payload: {
              questions: [
                {
                  id: "db",
                  header: "Database",
                  question: "Which database?",
                  options: [{ label: "Postgres", description: "Recommended" }, { label: "SQLite" }],
                },
                { id: "name", header: "Name", question: "Project name?" },
              ],
            },
          },
        ] as unknown as RuntimeProjection["requests"],
      }),
    );
    // One question at a time: picking a choice moves on to the next by itself.
    expect(container.textContent).toContain("Question 1 of 2");
    expect(container.querySelector('input[aria-label="Project name?"]')).toBeNull();
    expect(button(container, "Next")?.disabled).toBe(true);
    await act(async () => {
      const radio = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')][0];
      radio?.click();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(container.textContent).toContain("Question 2 of 2");
    const send = () => button(container, "Send answers");
    expect(send()?.disabled).toBe(true);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Project name?"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "atlas");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(send()?.disabled).toBe(false);
    await act(async () => send()?.click());
    expect(dispatched.at(-1)?.command).toEqual({
      type: "thread.user-input",
      threadId,
      requestId: "r4",
      answers: { db: "Postgres", name: "atlas" },
    });
  });
});

describe("ChatView focus", () => {
  const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  it("puts the cursor in the message box when its tile becomes active", async () => {
    const { container } = await render(projectionWith(), vi.fn(), () => undefined, true);
    await nextFrame();
    expect(document.activeElement).toBe(container.querySelector('textarea[aria-label="Message Droid"]'));
  });

  it("leaves the cursor in another field of the tile that the click focused", async () => {
    const tile = document.createElement("section");
    tile.className = "agent-tile";
    const search = document.createElement("input");
    tile.append(search);
    document.body.append(tile);
    search.focus();
    const { container } = await render(projectionWith(), vi.fn(), () => undefined, true);
    tile.append(container);
    await nextFrame();
    expect(document.activeElement).toBe(search);
  });
});

describe("ChatView context meter", () => {
  it("shows how full the context window was after the last turn", async () => {
    const { container } = await render(
      projectionWith({
        threads: [{ ...thread, status: "idle" }],
        usage: [
          {
            usageId: `${threadId}:t1`,
            threadId: thread.threadId,
            turnId: "t1",
            provider: "droid",
            usage: { contextTokens: 170_000, contextWindow: 200_000 },
          },
        ],
      }),
    );
    const meter = container.querySelector(".composer-context");
    expect(meter?.getAttribute("aria-label")).toBe("85% of context used, 170k of 200k tokens");
    expect(meter?.classList.contains("is-full")).toBe(false);
  });

  it("pins the agent's plan over the message box and keeps it out of the steps", async () => {
    const turnId = thread.activeTurnId as string;
    const working = { ...thread, status: "working" } as ThreadProjection;
    const { container } = await render(
      projectionWith({
        threads: [working],
        messages: [
          { messageId: "m1", threadId, turnId, role: "user", text: "Fix it" },
        ] as RuntimeProjection["messages"],
        activities: [
          {
            activityId: "plan",
            threadId,
            turnId,
            kind: "tool",
            title: "Plan: 1 of 2 done",
            status: "completed",
            todos: [
              { text: "Read the code", status: "completed" },
              { text: "Fix the bug", status: "in_progress" },
            ],
          },
        ] as RuntimeProjection["activities"],
      }),
    );
    const plan = container.querySelector(".plan-card");
    expect(plan?.querySelector(".plan-card-count")?.textContent).toBe("1/2");
    expect([...(plan?.querySelectorAll(".plan-step") ?? [])].map((step) => step.className)).toEqual([
      "plan-step is-completed",
      "plan-step is-in_progress",
    ]);
    expect(container.querySelector(".chat-log")?.textContent).not.toContain("Plan: 1 of 2 done");
  });

  it("offers Continue for a chat cut off mid-task, and sends it on", async () => {
    const turnId = thread.activeTurnId as string;
    const stopped = { ...thread, status: "stopped", providerSessionId: "conv-1" } as ThreadProjection;
    const { container, dispatched } = await render(
      projectionWith({
        threads: [stopped],
        messages: [
          { messageId: "m1", threadId, turnId, role: "user", text: "Build the page" },
        ] as RuntimeProjection["messages"],
      }),
    );
    const resume = button(container, "Continue");
    expect(resume).toBeDefined();
    await act(async () => resume?.click());
    expect(dispatched.at(-1)?.command).toMatchObject({ type: "thread.queue", text: "Continue where you left off." });
  });

  it("puts a reply's suggested next steps right under it, not above the message box", async () => {
    const turnId = thread.activeTurnId as string;
    const idle = { ...thread, status: "idle" } as ThreadProjection;
    const { container } = await render(
      projectionWith({
        threads: [idle],
        messages: [
          { messageId: "m1", threadId, turnId, role: "user", text: "Fix the login" },
          {
            messageId: "m2",
            threadId,
            turnId,
            role: "assistant",
            text: "Fixed it.\n\nNext steps:\n- Add a test for the expired token",
          },
        ] as RuntimeProjection["messages"],
      }),
    );
    const steps = container.querySelector('[aria-label="Suggested next steps"]');
    expect(steps?.textContent).toContain("Add a test for the expired token");
    expect(steps?.closest(".chat-log")).not.toBeNull();
    expect(container.querySelector(".chat-dock [aria-label='Suggested next steps']")).toBeNull();
  });

  it("lets the person edit their last message once the reply is in", async () => {
    const turnId = thread.activeTurnId as string;
    const idle = { ...thread, status: "idle" } as ThreadProjection;
    const { container } = await render(
      projectionWith({
        threads: [idle],
        messages: [
          { messageId: "m1", threadId, turnId, role: "user", text: "Make it blue" },
          { messageId: "m2", threadId, turnId, role: "assistant", text: "Done." },
        ] as RuntimeProjection["messages"],
      }),
    );
    expect(button(container, "Continue")).toBeUndefined();
    await act(async () => button(container, "Edit message")?.click());
    await act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    const box = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Droid"]');
    expect(box?.value).toBe("Make it blue");
    expect(container.querySelector(".chat-note.is-editing")?.textContent).toContain("Editing your last message");
  });
});
