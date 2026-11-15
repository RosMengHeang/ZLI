// @vitest-environment jsdom

import type { BuddyProjection, RuntimeProjection, TaskProjection } from "@zli-v2/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buttonNamed, typeInput } from "../huddle/testHuddles.js";
import { cleanupRuntimeRenders, renderWithRuntime, typeInto } from "../review/testRuntime.js";
import { BuddiesPane } from "./BuddiesPane.js";
import { buddyTranscript } from "./BuddyChat.js";
import { SidebarBuddies } from "./SidebarBuddies.js";

afterEach(async () => {
  await cleanupRuntimeRenders();
});

const at = "2026-11-15T09:00:00.000Z";
const buddy = (buddyId: string, name: string, order: number, role: "primary" | "buddy" = "buddy"): BuddyProjection => ({
  buddyId,
  name,
  color: "jade",
  role,
  order,
  engine: { mode: "auto" },
  permissionMode: "full-access",
  maxActiveJobs: 2,
  handoffs: [],
  memory: [],
  pendingMemory: [],
  createdAt: at,
  updatedAt: at,
});
const task = (extra: Partial<TaskProjection>): TaskProjection => ({
  taskId: "t1",
  buddyId: "b2",
  projectId: "p1",
  kind: "job",
  goal: "Fix the flaky checkout test",
  origin: { kind: "chat" },
  picks: [],
  handoffDepth: 0,
  status: "working",
  questions: [],
  revisions: [],
  reviews: [],
  createdAt: at,
  updatedAt: at,
  ...extra,
});

function projection(overrides: Partial<RuntimeProjection> = {}): RuntimeProjection {
  return {
    environment: {
      environmentId: "00000000-0000-4000-8000-000000000001",
      label: "Local",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [{ projectId: "p1", path: "/work/web", name: "web" }],
    worktrees: [],
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
    ...overrides,
  } as unknown as RuntimeProjection;
}

const accept = () => ({ result: {} });

async function render(state: RuntimeProjection, selectedId?: string) {
  const handlers = { onSelect: vi.fn(), onOpenThread: vi.fn(), onOpenPullRequest: vi.fn() };
  const commands = await renderWithRuntime(
    <BuddiesPane projection={state} selectedId={selectedId} projectId="p1" {...handlers} />,
    accept,
  );
  return { commands, ...handlers };
}

const sent = (commands: Record<string, unknown>[]) => commands.map((entry) => entry.type as string);

describe("BuddiesPane", () => {
  it("starts the team with a Primary, a Builder and a Tester who checks the Builder's work", async () => {
    const { commands } = await render(projection());
    await act(async () => buttonNamed("Start with these three").click());
    expect(sent(commands)).toEqual([
      "buddy.create",
      "buddy.create",
      "buddy.create",
      "buddy.handoff.set",
      "routine.create",
    ]);
    const names = commands.slice(0, 3).map((entry) => (entry as { buddy: { name: string } }).buddy.name);
    expect(names).toEqual(["Primary", "Builder", "Tester"]);
  });

  it("lists the team in its set order with each buddy's sentence, and shows what needs you", async () => {
    const state = projection({
      buddies: [
        { ...buddy("b2", "Builder", 1), lastLine: { text: "Working on fix the flaky checkout test", at } },
        buddy("b1", "Primary", 0, "primary"),
        buddy("b3", "Tester", 2),
      ],
      tasks: [
        task({
          status: "needs_you",
          questions: [{ questionId: "q1", text: "Which API version?", options: ["v1", "v2"], askedAt: at }],
        }),
      ],
    });
    const { commands } = await render(state);
    const rows = [...document.querySelectorAll(".buddies-row-name")].map((row) => row.firstChild?.textContent);
    expect(rows).toEqual(["Primary", "Builder", "Tester"]);
    expect(document.body.textContent).toContain("Working on fix the flaky checkout test");
    expect(document.body.textContent).toContain("Which API version?");
    await act(async () => buttonNamed("v2").click());
    expect(commands.at(-1)).toEqual({
      type: "task.question.answer",
      taskId: "t1",
      questionId: "q1",
      answer: "v2",
    });
  });

  it("sends a message to the buddy's chat, which decides whether it is a job", async () => {
    const state = projection({ buddies: [buddy("b2", "Builder", 0)] });
    const { commands } = await render(state, "b2");
    expect(document.body.textContent).toContain("Ask me anything.");
    const box = document.querySelector<HTMLTextAreaElement>('[aria-label="Message Builder"]');
    if (!box) throw new Error("No message box");
    await typeInto(box, "hello");
    await act(async () => buttonNamed("Send").click());
    expect(commands.at(-1)).toMatchObject({ type: "buddy.chat.send", buddyId: "b2", text: "hello" });
  });

  it("shows the conversation, and a dots bubble while the buddy thinks", () => {
    const state = projection({
      buddies: [{ ...buddy("b2", "Builder", 0), chatThreadId: "chat-1" }],
      buddyMessages: [
        { messageId: "m1", buddyId: "b2", role: "you", text: "hi", at },
        { messageId: "m2", buddyId: "b2", role: "buddy", text: "Hey! What's up?", at },
        { messageId: "m3", buddyId: "b2", role: "you", text: "fix the login", at },
      ],
    });
    const items = buddyTranscript(state.buddies?.[0] as BuddyProjection, state);
    expect(items.map((item) => item.kind)).toEqual(["you", "say", "you", "thinking"]);
  });

  it("shows a result card with the setup and its reason, and sends a revision", async () => {
    const state = projection({
      buddies: [buddy("b2", "Builder", 0)],
      tasks: [
        task({
          status: "ready",
          threadId: "th1",
          startedAt: at,
          branch: "builder/x",
          pick: {
            provider: "claude-code",
            model: "claude-sonnet-5-5",
            permissionMode: "full-access",
            reason: "Medium tests; claude-sonnet-5-5 fits",
            source: "auto",
            at,
          },
          result: {
            summary: "Made the test wait for the cart.",
            files: 2,
            insertions: 10,
            deletions: 3,
            screenshots: [],
            durationMs: 120_000,
            overlaps: [],
          },
        }),
      ],
    });
    const { commands, onOpenPullRequest } = await render(state, "b2");
    // The job reads as a conversation: what you asked, then the buddy's reply with its result card.
    expect(document.querySelector(".buddy-chat-you")?.textContent).toBe("Fix the flaky checkout test");
    expect(document.querySelector(".buddy-chat-card .job-card")).not.toBeNull();
    expect(document.body.textContent).toContain("Medium tests; claude-sonnet-5-5 fits");
    expect(document.body.textContent).toContain("2 files · +10 −3 · 2 min");
    await act(async () => buttonNamed("Open PR").click());
    expect(onOpenPullRequest).toHaveBeenCalledWith("th1");
    await act(async () => buttonNamed("Revise").click());
    const input = document.querySelector<HTMLInputElement>('[aria-label="What to change"]');
    if (!input) throw new Error("No revise box");
    await typeInput(input, "Use the shared helper");
    await act(async () => buttonNamed("Send").click());
    expect(commands.at(-1)).toEqual({ type: "task.revise", taskId: "t1", note: "Use the shared helper" });
  });

  it("hides the details from the name tag, and renames the buddy from its name", async () => {
    const { commands } = await render(projection({ buddies: [buddy("b2", "Builder", 0)] }), "b2");
    await act(async () => buttonNamed("Rename Builder").click());
    const box = document.querySelector<HTMLInputElement>(".buddy-info-name-input");
    if (!box) throw new Error("No name box");
    await typeInput(box, "Nova");
    await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(commands.at(-1)).toEqual({ type: "buddy.update", buddyId: "b2", changes: { name: "Nova" } });
    const tag = document.querySelector<HTMLButtonElement>(".buddy-view-tag");
    await act(async () => tag?.click());
    expect(document.querySelector('[aria-label="About Builder"]')?.tagName).not.toBe("ASIDE");
    expect(tag?.getAttribute("aria-expanded")).toBe("false");
  });

  it("asks before keeping a lesson, and pauses everything with one button", async () => {
    const state = projection({
      buddies: [
        {
          ...buddy("b2", "Builder", 0),
          pendingMemory: [{ noteId: "n1", text: "Run pnpm verify before finishing", source: "lookback", at }],
        },
      ],
    });
    const { commands } = await render(state, "b2");
    // The profile sits beside the chat, like the bot's details in Grok.
    expect(document.querySelector('[aria-label="About Builder"]')).not.toBeNull();
    // New lessons wait in its library.
    await act(async () => buttonNamed("Library").click());
    await act(async () => buttonNamed("Keep").click());
    expect(commands.at(-1)).toEqual({ type: "buddy.memory.accept", buddyId: "b2", noteId: "n1" });
    await cleanupRuntimeRenders();
    const home = await render(state);
    await act(async () => buttonNamed("Pause all").click());
    expect(home.commands.at(-1)).toEqual({ type: "buddies.pause" });
  });
});

describe("SidebarBuddies", () => {
  it("opens the panel on a buddy and on the Needs you list", async () => {
    const onOpen = vi.fn();
    await renderWithRuntime(
      <SidebarBuddies
        projection={projection({ buddies: [buddy("b2", "Builder", 0)], tasks: [task({ status: "needs_you" })] })}
        onOpen={onOpen}
      />,
      accept,
    );
    await act(async () => buttonNamed("Needs you · 1").click());
    expect(onOpen).toHaveBeenLastCalledWith();
    await act(async () => document.querySelector<HTMLButtonElement>(".sidebar-buddy")?.click());
    expect(onOpen).toHaveBeenLastCalledWith("b2");
  });
});

describe("NewBuddyDialog", () => {
  it("makes a buddy from the + with its name, color and what it may do, then opens it", async () => {
    const onOpen = vi.fn();
    const commands = await renderWithRuntime(
      <SidebarBuddies projection={projection({ buddies: [buddy("b2", "Builder", 0)] })} onOpen={onOpen} />,
      accept,
    );
    await act(async () => buttonNamed("Add a buddy").click());
    const name = document.querySelector<HTMLInputElement>(".new-buddy input");
    if (!name) throw new Error("No name box");
    await typeInput(name, "Nova");
    const role = [...document.querySelectorAll<HTMLButtonElement>(".new-buddy-role")].find((entry) =>
      entry.textContent?.startsWith("Reviewer"),
    );
    await act(async () => role?.click());
    await act(async () => buttonNamed("rose").click());
    await act(async () => buttonNamed("Read only").click());
    await act(async () => buttonNamed("Add Nova").click());
    expect(commands.at(-1)).toMatchObject({
      type: "buddy.create",
      buddy: { name: "Nova", title: "Reviewer", color: "rose", permissionMode: "read-only", role: "buddy" },
    });
    expect(onOpen).toHaveBeenCalledWith((commands.at(-1) as { buddy: { buddyId: string } }).buddy.buddyId);
  });
});

describe("buddyTranscript", () => {
  it("puts handoffs, reviews and routines in the same timeline as the conversation", () => {
    const state = projection({
      buddies: [buddy("b2", "Builder", 0), buddy("b3", "Tester", 1)],
      routines: [
        {
          routineId: "r1",
          buddyId: "b2",
          projectId: "p1",
          goal: "Run the tests",
          trigger: { kind: "schedule", cron: "0 9 * * 1-5" },
          paused: false,
          failuresInRow: 0,
          seen: [],
          createdAt: "2026-11-15T08:00:00.000Z",
        },
      ],
      tasks: [
        task({ status: "ready", reviews: [{ taskId: "t2", buddyId: "b3", verdict: "ok", notes: [] }] }),
        task({
          taskId: "t2",
          buddyId: "b3",
          kind: "review",
          parentTaskId: "t1",
          round: 1,
          goal: "Check Builder's work",
          createdAt: "2026-11-15T09:05:00.000Z",
        }),
      ],
    });
    const items = buddyTranscript(state.buddies?.[0] as BuddyProjection, state);
    expect(items.map((item) => (item.kind === "event" ? item.text : item.kind))).toEqual([
      "Created routine · Weekdays at 9:00: Run the tests",
      "you",
      "Tester checked it: looks good",
      "reply",
      "Handed to Tester: Check Builder's work",
    ]);
  });
});
