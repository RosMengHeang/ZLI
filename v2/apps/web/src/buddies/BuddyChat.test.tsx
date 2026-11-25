// @vitest-environment jsdom

import type { BuddyProjection, RuntimeProjection } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonNamed } from "./testDom.js";
import { typeInto } from "../review/testRuntime.js";
import { BuddyChat, buddyTranscript, continuesGroup } from "./BuddyChat.js";

const at = "2026-11-15T09:00:00.000Z";
const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();

const builder: BuddyProjection = {
  buddyId: "b2",
  name: "Builder",
  color: "jade",
  role: "buddy",
  order: 0,
  engine: { mode: "auto" },
  permissionMode: "full-access",
  maxActiveJobs: 2,
  handoffs: [],
  memory: [],
  pendingMemory: [],
  createdAt: at,
  updatedAt: at,
} as unknown as BuddyProjection;
const tester = { ...builder, buddyId: "b3", name: "Tester", order: 1 } as BuddyProjection;

type Message = { messageId: string; role: "you" | "buddy"; text: string; at: string; from?: string };

function projection(messages: Message[]): RuntimeProjection {
  return {
    projects: [{ projectId: "p1", path: "/work/web", name: "web" }],
    worktrees: [],
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
    buddies: [builder, tester],
    buddyMessages: messages.map((message) => ({ buddyId: "b2", ...message })),
  } as unknown as RuntimeProjection;
}

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

async function show(state: RuntimeProjection, run: (command: Record<string, unknown>) => Promise<boolean>) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const draw = async (next: RuntimeProjection) => {
    await act(async () =>
      root?.render(
        <BuddyChat
          buddy={builder}
          projection={next}
          run={run}
          onOpenThread={() => undefined}
          renderReply={() => null}
        />,
      ),
    );
  };
  await draw(state);
  return draw;
}

/** jsdom has no layout: the log's sizes are set by hand. */
function fakeScroll(element: HTMLElement) {
  const box = { height: 1000, top: 0 };
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => box.height });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => 300 });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => box.top,
    set: (value: number) => {
      box.top = Math.min(value, box.height - 300);
    },
  });
  return box;
}

const scroll = async (element: HTMLElement) => {
  await act(async () => element.dispatchEvent(new Event("scroll")));
};

describe("BuddyChat", () => {
  it("offers a way back to the newest line when you have scrolled up and something new arrives", async () => {
    const first: Message = { messageId: "m1", role: "you", text: "hi", at };
    const draw = await show(projection([first]), async () => true);
    const log = document.querySelector<HTMLElement>('[role="log"]');
    if (!log) throw new Error("No chat log");
    const box = fakeScroll(log);
    box.top = 100;
    await scroll(log);
    box.height = 1400;
    await draw(projection([first, { messageId: "m2", role: "buddy", text: "Hello there", at: later(1) }]));
    const jump = buttonNamed("Jump to latest");
    expect(jump.tagName).toBe("BUTTON");
    await act(async () => jump.click());
    expect(box.top).toBe(1100);
    expect(document.body.textContent).not.toContain("Jump to latest");

    // Scrolling back down by hand hides it too.
    box.top = 0;
    await scroll(log);
    box.height = 1800;
    await draw(projection([first, { messageId: "m3", role: "buddy", text: "More", at: later(2) }]));
    expect(document.body.textContent).toContain("Jump to latest");
    box.top = box.height - 300 - 20;
    await scroll(log);
    expect(document.body.textContent).not.toContain("Jump to latest");
  });

  it("groups messages in a row from one sender, and a long gap starts a new group", async () => {
    const state = projection([
      { messageId: "m1", role: "you", text: "one", at },
      { messageId: "m2", role: "you", text: "two", at: later(1) },
      { messageId: "m3", role: "buddy", text: "reply", at: later(2) },
      { messageId: "m4", role: "buddy", text: "more", at: later(3) },
      { messageId: "m5", role: "buddy", text: "much later", at: later(30) },
      { messageId: "m6", role: "buddy", text: "from Tester", at: later(31), from: "b3" },
      { messageId: "m7", role: "buddy", text: "Tester again", at: later(32), from: "b3" },
    ]);
    const items = buddyTranscript(builder, state);
    expect(items.map((_, index) => continuesGroup(items, index))).toEqual([
      false,
      true,
      false,
      true,
      false,
      false,
      true,
    ]);
    await show(state, async () => true);
    const heads = [...document.querySelectorAll<HTMLElement>(".buddy-chat-teammate-head")];
    expect(heads.map((head) => head.hidden)).toEqual([false, true]);
    expect(document.querySelectorAll(".buddy-chat-entry.is-grouped")).toHaveLength(3);
  });

  it("shows your message as sending until it lands, and retries the same message when it fails", async () => {
    const commands: Record<string, unknown>[] = [];
    const replies: ((ok: boolean) => void)[] = [];
    const run = vi.fn(async (command: Record<string, unknown>) => {
      commands.push(command);
      return new Promise<boolean>((resolve) => replies.push(resolve));
    });
    const draw = await show(projection([]), run);
    const box = document.querySelector<HTMLTextAreaElement>('[aria-label="Message Builder"]');
    if (!box) throw new Error("No message box");
    await typeInto(box, "fix the login");
    await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(box.value).toBe("");
    expect(document.querySelector(".buddy-chat-you.is-pending")?.textContent).toBe("fix the login");
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Sending");

    await act(async () => replies[0]?.(false));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Not sent.");
    await act(async () => buttonNamed("Retry").click());
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Sending");

    await act(async () => replies[1]?.(true));
    expect(document.querySelector(".buddy-chat-you.is-pending")).toBeNull();
    expect(document.body.textContent).not.toContain("Sending");
    const messageId = commands[0]?.messageId as string;
    await draw(projection([{ messageId, role: "you", text: "fix the login", at }]));
    expect(document.querySelectorAll(".buddy-chat-you")).toHaveLength(1);
  });
});
