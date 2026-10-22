// @vitest-environment jsdom

import { CommandId, EnvironmentId, ProjectId, type RuntimeProjection, type ThreadProjection } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { ChatView } from "./ChatView.js";

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

async function render(projection: RuntimeProjection, onOpenDiff = vi.fn()) {
  const dispatched: Array<{ command: Record<string, unknown> }> = [];
  const bridge = {
    runtime: {
      dispatch: async (request: { command: Record<string, unknown> }) => {
        dispatched.push(request);
        return { commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"), accepted: true as const };
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
    expect(container.querySelector('[aria-label="Work log"]')?.textContent).toContain("npm test");
    const changed = container.querySelector('[aria-label="Changed files"]');
    expect(changed?.textContent).toContain("1 file changed");
    expect(container.querySelector(".markdown strong")?.textContent).toBe("helper");
    await act(async () => button(container, "Open diff")?.click());
    expect(onOpenDiff).toHaveBeenCalledWith();
    await act(async () => changed?.querySelector<HTMLButtonElement>("li button")?.click());
    expect(onOpenDiff).toHaveBeenLastCalledWith("src/helper.ts");
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
    expect(container.querySelector(".composer-badge")?.textContent).toContain("Supervised");
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
    const select = container.querySelector<HTMLSelectElement>(".composer-permission select");
    expect(select?.value).toBe("supervised");
    await act(async () => {
      if (!select) return;
      select.value = "full-access";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
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
