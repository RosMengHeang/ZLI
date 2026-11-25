// @vitest-environment jsdom

import {
  CommandId,
  EnvironmentId,
  ProjectId,
  type RuntimeProjection,
  type ThreadMessageProjection,
  type ThreadProjection,
} from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { ChatView } from "./ChatView.js";
import {
  onSideQuestionRequest,
  requestSideQuestion,
  SideChat,
  sideQuestionContext,
  sideQuestionUpdate,
} from "./SideChat.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const worktreeId = "00000000-0000-4000-8000-000000000011";
const threadId = "00000000-0000-4000-8000-000000000401";
const sideThreadId = "00000000-0000-4000-8000-000000000402";

const message = (messageId: string, role: "user" | "assistant", text: string, thread = threadId) =>
  ({ messageId, threadId: thread, role, text }) as ThreadMessageProjection;

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
    threads: [
      { threadId, worktreeId, provider: "droid", status: "working", capabilities: {} } as unknown as ThreadProjection,
    ],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
    providers: [{ provider: "droid", displayName: "Droid", status: "found", path: "droid" }],
    ...overrides,
  };
}

function bridgeFor(projection: RuntimeProjection, dispatched: Array<Record<string, unknown>> = []) {
  return {
    runtime: {
      dispatch: async (request: { command: Record<string, unknown> }) => {
        dispatched.push(request.command);
        return { commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"), accepted: true as const };
      },
      getProjection: async () => projection,
      onProjection: () => () => undefined,
      attachTerminal: async () => ({ accepted: true }),
      onTerminal: () => () => undefined,
    },
  } as unknown as ZliBridge;
}

const button = (root: ParentNode, name: string) =>
  [...root.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );

async function typeAndSubmit(root: ParentNode, text: string) {
  const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Side question"]');
  if (!input) throw new Error("no side question box");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

describe("sideQuestionContext", () => {
  it("carries the rules and the main chat, and says when the chat is empty", () => {
    const text = sideQuestionContext(
      [message("m1", "user", "Rename the helper"), message("m2", "assistant", "Renamed it.")],
      () => "Droid",
    );
    expect(text).toContain("nothing you say is added to it");
    expect(text).toContain("<main-chat>");
    expect(text).toContain("Rename the helper");
    expect(text).toContain("## Droid");
    expect(text.endsWith("The side question:")).toBe(true);
    expect(sideQuestionContext([], () => "Droid")).toContain("The main chat has no messages yet.");
  });
});

describe("sideQuestionUpdate", () => {
  const said = [message("m1", "user", "One"), message("m2", "assistant", "Two"), message("m3", "user", "Three")];

  it("sends only what was said after the last message the side agent read", () => {
    const update = sideQuestionUpdate(said, "m1", () => "Droid");
    expect(update).toContain("Two");
    expect(update).toContain("Three");
    expect(update).not.toContain("One");
  });

  it("sends nothing when nothing is new or the message is gone", () => {
    expect(sideQuestionUpdate(said, "m3", () => "Droid")).toBeUndefined();
    expect(sideQuestionUpdate(said, "edited-away", () => "Droid")).toBeUndefined();
  });

  it("sends the whole chat when the side agent saw it empty", () => {
    expect(sideQuestionUpdate(said, undefined, () => "Droid")).toContain("One");
  });
});

describe("requestSideQuestion", () => {
  it("reaches the listeners until they stop listening", () => {
    const listener = vi.fn();
    const stop = onSideQuestionRequest(listener);
    requestSideQuestion();
    stop();
    requestSideQuestion();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("SideChat", () => {
  it("sends a finished answer to the chat, but not one still being written", async () => {
    const side = (status: string, answer: string) =>
      projectionWith({
        threads: [
          { threadId: sideThreadId, worktreeId, provider: "droid", status, capabilities: {} } as ThreadProjection,
        ],
        messages: [
          message("s1", "user", "What does the helper do?", sideThreadId),
          message("s2", "assistant", answer, sideThreadId),
        ],
      });
    const onSendToChat = vi.fn();
    const render = async (projection: RuntimeProjection) => {
      const container = document.createElement("div");
      document.body.append(container);
      await act(async () => {
        createRoot(container).render(
          <RuntimeProvider bridge={bridgeFor(projection)}>
            <SideChat
              threadId={sideThreadId}
              starting={false}
              error={undefined}
              onAsk={() => undefined}
              onClose={() => undefined}
              onSendToChat={onSendToChat}
            />
          </RuntimeProvider>,
        );
      });
      return container;
    };

    const busy = await render(side("working", "It formats"));
    expect(busy.textContent).toContain("What does the helper do?");
    expect(button(busy, "Send to chat")).toBeUndefined();
    expect(button(busy, "Copy reply")).toBeUndefined();
    // The thread reads like the main chat: its bubbles, its replies, and its working line.
    expect(busy.querySelector(".chat-message-user")?.textContent).toContain("What does the helper do?");
    expect(busy.querySelector(".chat-message-assistant .markdown")?.textContent).toContain("It formats");
    expect(busy.querySelector('.chat-working [role="status"]')?.textContent).toBe("Thinking");
    expect(busy.querySelector(".side-chat-note")?.textContent).toBe("Reads this chat. Answers stay out of it.");
    expect(busy.querySelector("textarea")?.getAttribute("placeholder")).toBe("Ask a side question");

    const done = await render(side("idle", "It formats dates."));
    expect(done.querySelector(".chat-working")).toBeNull();
    expect(button(done, "Copy reply")).toBeDefined();
    await act(async () => button(done, "Send to chat")?.click());
    expect(onSendToChat).toHaveBeenCalledWith("It formats dates.");
    expect(button(done, "In the message box")).toBeDefined();
  });
});

describe("ChatView side question", () => {
  it("opens from the shortcut, asks with the main chat as context, and follows up with what is new", async () => {
    const projection = projectionWith({
      messages: [message("m1", "user", "Rename the helper"), message("m2", "assistant", "Working on it.")],
    });
    const dispatched: Array<Record<string, unknown>> = [];
    const onAskAside = vi.fn(async () => ({ threadId: sideThreadId }));
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      createRoot(container).render(
        <RuntimeProvider bridge={bridgeFor(projection, dispatched)}>
          <ChatView
            projection={projection}
            thread={projection.threads[0] as ThreadProjection}
            worktree={projection.worktrees[0]}
            onOpenDiff={() => undefined}
            onRestart={() => undefined}
            onAskAside={onAskAside}
            onCloseAside={() => undefined}
            active
          />
        </RuntimeProvider>,
      );
    });
    // The side question sits in the message box's + menu, and leaves it while the panel is open.
    const sideItem = async () => {
      await act(async () => button(container, "Add")?.click());
      const item = [...document.querySelectorAll('[role="menu"] .menu-item-label')].find(
        (label) => label.textContent === "Ask a side question",
      );
      await act(async () => button(container, "Add")?.click());
      return item;
    };
    expect(await sideItem()).toBeDefined();
    await act(async () => requestSideQuestion());
    const panel = container.querySelector('section[aria-label="Side question"]');
    expect(panel).not.toBeNull();
    expect(await sideItem()).toBeUndefined();

    await typeAndSubmit(container, "Which file has the helper?");
    expect(onAskAside).toHaveBeenCalledTimes(1);
    const [question, context] = onAskAside.mock.calls[0] as unknown as [string, string];
    expect(question).toBe("Which file has the helper?");
    expect(context).toContain("Rename the helper");
    expect(context).toContain("<main-chat>");

    // Nothing new in the main chat, so the follow-up goes to the side chat on its own.
    await typeAndSubmit(container, "And its test?");
    const followUp = dispatched.find((command) => command.type === "thread.queue" && command.threadId === sideThreadId);
    expect(followUp?.text).toBe("And its test?");
    expect(followUp?.context).toBeUndefined();
    // The main chat got none of it.
    expect(dispatched.some((command) => command.threadId === threadId)).toBe(false);
  });
});
