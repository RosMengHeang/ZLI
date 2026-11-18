// @vitest-environment jsdom

import type { BuddyProjection, RuntimeProjection, TaskProjection } from "@zli-v2/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readDraft } from "../chat/drafts.js";
import { buttonNamed, typeInput } from "../huddle/testHuddles.js";
import { cleanupRuntimeRenders, renderWithRuntime, typeInto } from "../review/testRuntime.js";
import { DEFAULT_SETTINGS, readAppSettings, updateAppSettings } from "../settings/appSettings.js";
import { BuddiesPane, useTeammatesToBuddies } from "./BuddiesPane.js";
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
    expect(sent(commands)).toEqual(["buddy.create", "buddy.create", "buddy.create", "buddy.handoff.set"]);
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

  it("sends once when Enter is pressed twice before the first send lands, and keeps the draft per buddy", async () => {
    const state = projection({ buddies: [buddy("b2", "Builder", 0)] });
    const { commands } = await render(state, "b2");
    const box = document.querySelector<HTMLTextAreaElement>('[aria-label="Message Builder"]');
    if (!box) throw new Error("No message box");
    await typeInto(box, "fix the login");
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(commands.filter((entry) => entry.type === "buddy.chat.send")).toHaveLength(1);
    expect(readDraft("buddy:b2")).toBe("");
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

  it("shows a teammate's message as theirs, not yours", () => {
    const state = projection({
      buddies: [buddy("b1", "Primary", 0), buddy("b2", "Builder", 1)],
      buddyMessages: [
        { messageId: "m1", buddyId: "b1", role: "you", text: "How was your day?", at, from: "b2" },
        { messageId: "m2", buddyId: "b1", role: "buddy", text: "Good, yours?", at },
        { messageId: "m3", buddyId: "b1", role: "buddy", text: "Can you check the tests?", at, to: "b2" },
        { messageId: "m4", buddyId: "b1", role: "buddy", text: "On it.", at, from: "b2" },
      ],
    });
    const items = buddyTranscript(state.buddies?.[0] as BuddyProjection, state);
    expect(
      items.map((item) => [item.kind, "way" in item ? item.way : "", "who" in item ? item.who?.name : ""]),
    ).toEqual([
      ["teammate", "asked", "Builder"],
      ["say", "", ""],
      ["teammate", "sent", "Builder"],
      ["teammate", "replied", "Builder"],
    ]);
  });

  it("offers to send a message again when the buddy could not answer it", async () => {
    const state = projection({
      buddies: [{ ...buddy("b2", "Builder", 0), chatThreadId: "chat-1" }],
      buddyMessages: [
        { messageId: "m1", buddyId: "b2", role: "you", text: "explain the build", at },
        {
          messageId: "m2",
          buddyId: "b2",
          role: "buddy",
          text: "Something went wrong: it crashed.",
          at,
          unanswered: true,
        },
      ],
    });
    const items = buddyTranscript(state.buddies?.[0] as BuddyProjection, state);
    expect(items.at(-1)).toMatchObject({ kind: "say", resend: "explain the build" });
    const { commands } = await render(state, "b2");
    await act(async () => buttonNamed("Send again").click());
    expect(commands.at(-1)).toMatchObject({ type: "buddy.chat.send", buddyId: "b2", text: "explain the build" });
  });

  it("stops a reply: drops what is queued, interrupts the agent, and says so", async () => {
    const state = projection({
      buddies: [{ ...buddy("b2", "Builder", 0), chatThreadId: "chat-1" }],
      threads: [{ threadId: "chat-1", worktreeId: "w1", provider: "claude-code", status: "working", capabilities: {} }],
      queuedMessages: [{ queueId: "q1", threadId: "chat-1", text: "stopp" }],
      buddyMessages: [{ messageId: "m1", buddyId: "b2", role: "you", text: "message Primary", at }],
    } as Partial<RuntimeProjection>);
    const { commands } = await render(state, "b2");
    await act(async () => buttonNamed("Stop Builder").click());
    expect(commands.slice(-3)).toMatchObject([
      { type: "thread.queue.remove", threadId: "chat-1", queueId: "q1" },
      { type: "thread.interrupt", threadId: "chat-1" },
      { type: "buddy.chat.reply", buddyId: "b2", text: "Stopped." },
    ]);
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
    // The details sit beside the chat from the start, and the name tag folds them.
    expect(document.querySelector('aside[aria-label="About Builder"]')?.classList.contains("is-open")).toBe(true);
    // There is no separate button for them.
    expect(document.querySelector(".buddy-view-open")).toBeNull();
    await act(async () => buttonNamed("Rename Builder").click());
    const box = document.querySelector<HTMLInputElement>(".buddy-info-name-input");
    if (!box) throw new Error("No name box");
    await typeInput(box, "Nova");
    await act(async () => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(commands.at(-1)).toEqual({ type: "buddy.update", buddyId: "b2", changes: { name: "Nova" } });
    const tag = document.querySelector<HTMLButtonElement>(".buddy-view-tag");
    await act(async () => tag?.click());
    const aside = document.querySelector('aside[aria-label="About Builder"]');
    expect(aside?.classList.contains("is-open")).toBe(false);
    expect(aside?.getAttribute("aria-hidden")).toBe("true");
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
    // The profile sits beside the chat.
    expect(document.querySelector('aside[aria-label="About Builder"].is-open')).not.toBeNull();
    // New lessons wait in its library.
    await act(async () => buttonNamed("Library").click());
    await act(async () => buttonNamed("Keep").click());
    expect(commands.at(-1)).toEqual({ type: "buddy.memory.accept", buddyId: "b2", noteId: "n1" });
    await cleanupRuntimeRenders();
    const home = await render(state);
    // Pausing lives in Team settings, behind the gear on the list.
    await act(async () => buttonNamed("Team settings").click());
    await act(async () => buttonNamed("Pause all").click());
    expect(home.commands.at(-1)).toEqual({ type: "buddies.pause" });
  });
});

describe("Team board", () => {
  it("shows each buddy right now and the jobs in three lanes, and says when the team is paused", async () => {
    const state = projection({
      buddies: [buddy("b2", "Builder", 0), buddy("b3", "Tester", 1)],
      tasks: [
        task({ taskId: "q1", buddyId: "b3", status: "queued", goal: "Check the login page" }),
        task({ taskId: "w1", buddyId: "b2", status: "working", goal: "Add a health check" }),
        task({ taskId: "d1", buddyId: "b2", status: "ready", goal: "Fix the flaky test" }),
      ],
    });
    const { onSelect } = await render({ ...state, buddySettings: { ...state.buddySettings, paused: true } } as never);
    const lanes = [...document.querySelectorAll(".board-lane")].map((lane) => [
      lane.getAttribute("aria-label"),
      [...lane.querySelectorAll(".board-card-goal")].map((goal) => goal.textContent),
    ]);
    expect(lanes).toEqual([
      ["Up next", ["Check the login page"]],
      ["Doing", ["Add a health check"]],
      ["Done", ["Fix the flaky test"]],
    ]);
    expect(document.querySelector(".board-crew")?.textContent).toContain("Add a health check");
    expect(document.querySelector(".buddy-list-paused")?.textContent).toContain("Paused");
    await act(async () => document.querySelector<HTMLButtonElement>(".board-card")?.click());
    expect(onSelect).toHaveBeenLastCalledWith("b3");
  });
});

describe("Library", () => {
  it("shows what a buddy learned by where it came from, and its playbooks, each one removable", async () => {
    const state = projection({
      buddies: [
        {
          ...buddy("b2", "Builder", 0),
          memory: [
            { noteId: "n1", text: "Prefers small PRs.", source: "you", at },
            { noteId: "n2", text: "Tests need Docker running.", source: "lesson", projectId: "p1", at },
          ],
          playbooks: [
            {
              playbookId: "pb1",
              projectId: "p1",
              title: "Add an API route",
              steps: ["Add src/api/x.ts", "Run pnpm test"],
              at,
            },
          ],
        },
      ],
    });
    const { commands } = await render(state, "b2");
    await act(async () => buttonNamed("Library").click());
    const labels = [...document.querySelectorAll(".buddy-learned-label")].map((node) => node.textContent);
    expect(labels).toEqual(["From you 1", "Learned on jobs 1"]);
    expect(document.querySelector(".buddy-learned-summary")?.textContent).toContain("1 learned on its own");
    expect(document.querySelector(".buddy-playbook ol")?.textContent).toBe("Add src/api/x.tsRun pnpm test");
    await act(async () => buttonNamed("Delete Add an API route").click());
    expect(commands.at(-1)).toEqual({ type: "buddy.playbook.remove", buddyId: "b2", playbookId: "pb1" });
  });
});

describe("useTeammatesToBuddies", () => {
  it("turns saved teammates into buddies once, skipping a name the team already has", async () => {
    updateAppSettings((settings) => ({
      ...settings,
      teammates: [
        { id: "t1", name: "Nova", buddy: "rose", provider: "codex", model: "gpt-5", instructions: "Be brief." },
        { id: "t2", name: "Builder", buddy: "sky", provider: "claude-code" },
      ],
    }));
    function Mover({ state }: { state: RuntimeProjection }) {
      useTeammatesToBuddies(state);
      return null;
    }
    const commands = await renderWithRuntime(
      <Mover state={projection({ buddies: [buddy("b2", "Builder", 0)] })} />,
      accept,
    );
    expect(commands.filter((command) => command.type === "buddy.create")).toMatchObject([
      {
        buddy: {
          name: "Nova",
          color: "rose",
          engine: { mode: "locked", provider: "codex", model: "gpt-5" },
          instructions: "Be brief.",
        },
      },
    ]);
    expect(readAppSettings().teammates).toEqual([]);
    updateAppSettings(() => structuredClone(DEFAULT_SETTINGS));
  });
});

describe("SidebarBuddies", () => {
  it("is one menu line that opens the Buddies page, with a count when someone needs you", async () => {
    const onOpen = vi.fn();
    await renderWithRuntime(
      <SidebarBuddies
        projection={projection({ buddies: [buddy("b2", "Builder", 0)], tasks: [task({ status: "needs_you" })] })}
        onOpen={onOpen}
      />,
      accept,
    );
    const team = document.querySelector<HTMLButtonElement>(".sidebar-team");
    expect(team?.textContent).toBe("Buddies1");
    expect(team?.querySelector(".sidebar-nav-badge.is-needs")?.textContent).toBe("1");
    // No faces, buttons or roster on the line: the team lives on the Buddies page.
    expect(document.querySelectorAll(".sidebar-team .buddy-avatar, .sidebar-buddy, .btn")).toHaveLength(0);
    await act(async () => team?.click());
    expect(onOpen).toHaveBeenLastCalledWith();
  });
});

describe("BuddyList", () => {
  it("opens a buddy's chat from its row", async () => {
    const { onSelect } = await render(projection({ buddies: [buddy("b2", "Builder", 0)] }));
    const row = [...document.querySelectorAll<HTMLButtonElement>(".buddy-list-row")].find((entry) =>
      entry.textContent?.includes("Builder"),
    );
    await act(async () => row?.click());
    expect(onSelect).toHaveBeenLastCalledWith("b2");
  });

  it("makes a buddy from the + with its name, color and what it may do, then opens it", async () => {
    const { commands, onSelect } = await render(projection({ buddies: [buddy("b2", "Builder", 0)] }));
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
    await act(async () => buttonNamed("Create").click());
    expect(commands.at(-1)).toMatchObject({
      type: "buddy.create",
      buddy: { name: "Nova", title: "Reviewer", color: "rose", permissionMode: "read-only", role: "buddy" },
    });
    expect(onSelect).toHaveBeenCalledWith((commands.at(-1) as { buddy: { buddyId: string } }).buddy.buddyId);
  });

  it("removes a buddy from its right-click menu after asking", async () => {
    const { commands, onSelect } = await render(
      projection({ buddies: [buddy("b2", "Builder", 0), buddy("b3", "Tester", 1)] }),
      "b3",
    );
    const row = [...document.querySelectorAll<HTMLElement>(".buddy-list-row")].find((entry) =>
      entry.textContent?.includes("Tester"),
    );
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 40 }));
    });
    await act(async () => buttonNamed("Remove Tester").click());
    expect(commands.some((command) => command.type === "buddy.archive")).toBe(false);
    await act(async () => buttonNamed("Remove").click());
    expect(commands.at(-1)).toEqual({ type: "buddy.archive", buddyId: "b3" });
    expect(onSelect).toHaveBeenCalledWith(undefined);
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

describe("Goals on the team board", () => {
  it("gives the team a goal led by the Primary, with no one picking who does what", async () => {
    const { commands } = await render(
      projection({ buddies: [buddy("b1", "Ava", 0, "primary"), buddy("b2", "Builder", 1)] }),
    );
    const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Goal"]');
    if (!box) throw new Error("no goal box");
    await typeInto(box, "Add a dark mode to Settings, with tests");
    await act(async () => buttonNamed("Start").click());
    const goal = commands.find((entry) => entry.type === "goal.create") as
      | { goal: { buddyId: string; text: string; projectId?: string } }
      | undefined;
    expect(goal?.goal).toMatchObject({
      buddyId: "b1",
      text: "Add a dark mode to Settings, with tests",
      projectId: "p1",
    });
  });

  it("shows a goal's lead, its jobs and how far they got, and keeps planning turns off the lanes", async () => {
    const state = projection({
      buddies: [buddy("b1", "Ava", 0, "primary"), buddy("b2", "Builder", 1)],
      goals: [
        {
          goalId: "g1",
          buddyId: "b1",
          text: "Ship dark mode",
          projectId: "p1",
          status: "needs_you",
          needs: "Planned 8 times without finishing",
          rounds: 8,
          resumes: 0,
          createdAt: at,
          updatedAt: at,
        },
      ],
      tasks: [
        task({
          taskId: "plan",
          buddyId: "b1",
          goal: "Ship dark mode",
          origin: { kind: "goal", goalId: "g1" },
          status: "closed",
        }),
        task({ taskId: "j1", goal: "Add the toggle", origin: { kind: "primary", goalId: "g1" }, status: "ready" }),
        task({ taskId: "j2", goal: "Write the tests", origin: { kind: "primary", goalId: "g1" }, status: "working" }),
      ],
    });
    const { commands } = await render(state);
    const card = document.querySelector('[aria-label="Goal: Ship dark mode"]');
    expect(card?.textContent).toContain("Led by Ava");
    expect(card?.textContent).toContain("1 of 2 done");
    expect(card?.textContent).toContain("Planned 8 times");
    // The planning turn is not a job on the lanes.
    const lanes = document.querySelector('[aria-label="Jobs"]')?.textContent ?? "";
    expect(lanes).not.toContain("Ship dark mode");
    await act(async () => buttonNamed("Keep going", card ?? document).click());
    expect(sent(commands)).toContain("goal.resume");
  });
});
