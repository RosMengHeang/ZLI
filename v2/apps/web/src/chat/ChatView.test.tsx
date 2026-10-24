// @vitest-environment jsdom

import { CommandId, EnvironmentId, ProjectId, type RuntimeProjection, type ThreadProjection } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    expect([...(diff?.querySelectorAll(".turn-diff-line") ?? [])].map((line) => line.className)).toEqual([
      "turn-diff-line is-hunk",
      "turn-diff-line is-del",
      "turn-diff-line is-add",
    ]);

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
    expect(container.querySelector(".composer-badge")?.textContent).toContain("Auto");
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

  it("holds Send now until the agent's request is answered", async () => {
    const { container } = await render(
      projectionWith({
        requests: [
          { requestId: "r1", threadId, kind: "approval", payload: {} },
        ] as unknown as RuntimeProjection["requests"],
        queuedMessages: [{ queueId: "q1", threadId, text: "next" }] as RuntimeProjection["queuedMessages"],
      }),
    );
    expect(button(container, "Send now: next")?.disabled).toBe(true);
  });

  it("switches permission mode for the next message when the provider allows it", async () => {
    const { container, dispatched } = await render(
      projectionWith({ threads: [{ ...thread, status: "idle", capabilities: { permissionSwitch: "in-session" } }] }),
    );
    expect(container.querySelector(".composer-badge")).toBeNull();
    const trigger = button(container, "Permissions: Auto");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger?.click());
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="listbox"] [role="option"]')];
    expect(options.map((option) => option.querySelector(".picker-option-label")?.textContent)).toEqual([
      "Read only",
      "Auto",
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
        "generic",
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
    expect(card?.textContent).toContain("1 more waiting");
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
    const send = () => button(container, "Send answers");
    expect(send()?.disabled).toBe(true);
    await act(async () => {
      const radio = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')][0];
      radio?.click();
    });
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
    expect(meter?.querySelector("[aria-hidden]")?.textContent).toBe("85% context");
    expect(meter?.classList.contains("is-full")).toBe(true);
    expect(meter?.querySelector(".sr-only")?.textContent).toBe(
      "85% of context used. 170k of 200k tokens in context after the last turn",
    );
  });
});
