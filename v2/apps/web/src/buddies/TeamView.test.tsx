// @vitest-environment jsdom

import type { BuddyProjection, GoalProjection, RuntimeProjection, TaskProjection } from "@zli-v2/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupRuntimeRenders, renderWithRuntime } from "../review/testRuntime.js";
import { BuddiesPane } from "./BuddiesPane.js";
import { SidebarBuddies } from "./SidebarBuddies.js";
import { teamPageId } from "./TeamView.js";
import { buttonNamed, typeInput } from "./testDom.js";

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
const buddies = [buddy("lead", "Primary", 0, "primary"), buddy("b2", "Builder", 1), buddy("b3", "Tester", 2)];

const job = (extra: Partial<TaskProjection>): TaskProjection => ({
  taskId: "t1",
  buddyId: "b2",
  projectId: "p1",
  kind: "job",
  goal: "Theme tokens",
  origin: { kind: "primary", goalId: "g1" },
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

const team = (extra: Partial<GoalProjection["team"] & object>, goal: Partial<GoalProjection> = {}): GoalProjection => ({
  goalId: "g1",
  buddyId: "lead",
  text: "Add dark mode",
  projectId: "p1",
  status: "working",
  rounds: 1,
  resumes: 0,
  createdAt: at,
  updatedAt: at,
  team: { phase: "working", autoStart: false, reviewRounds: 1, buddyIds: [], plan: [], ...extra },
  ...goal,
});

function projection(overrides: Partial<RuntimeProjection>): RuntimeProjection {
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
    buddies,
    ...overrides,
  } as unknown as RuntimeProjection;
}

async function render(state: RuntimeProjection, selectedId: string) {
  const handlers = { onSelect: vi.fn(), onOpenThread: vi.fn(), onOpenPullRequest: vi.fn() };
  const commands = await renderWithRuntime(
    <BuddiesPane projection={state} selectedId={selectedId} projectId="p1" {...handlers} />,
    () => ({ result: {} }),
  );
  return { commands, ...handlers };
}

describe("Team page", () => {
  it("shows the plan for the person to change, and Go sends it as they left it", async () => {
    const state = projection({
      goals: [
        team(
          {
            phase: "plan_ready",
            notes: "Two parts that can run at once.",
            plan: [
              { planTaskId: "p1", title: "Theme tokens", buddyId: "b2" },
              { planTaskId: "p2", title: "Settings toggle", buddyId: "b3", notes: "With a test" },
            ],
          },
          { status: "needs_you", needs: "Check the plan and press Go" },
        ),
      ],
    });
    const { commands } = await render(state, teamPageId("g1"));
    expect(document.querySelector(".team-goal")?.textContent).toBe("Add dark mode");
    expect(document.querySelector(".team-status")?.textContent).toBe("Plan ready");
    expect(document.querySelector(".team-notes")?.textContent).toContain("Two parts that can run at once.");
    // The plan waits for Go, so there is no "Keep going" card for it.
    expect(document.querySelector(".team-needs")).toBeNull();

    await typeInput(document.querySelector('[aria-label="Task 1"]') as HTMLInputElement, "Theme tokens for dark");
    await act(async () => buttonNamed("Remove task 2").click());
    await act(async () => buttonNamed("Add task").click());
    await typeInput(document.querySelector('[aria-label="Task 2"]') as HTMLInputElement, "Docs");
    await act(async () => buttonNamed("Go").click());

    const go = commands.find((command) => command.type === "goal.plan.approve") as {
      plan: { planTaskId: string; title: string; buddyId: string }[];
    };
    expect(go.plan.map((item) => [item.title, item.buddyId])).toEqual([
      ["Theme tokens for dark", "b2"],
      ["Docs", "lead"],
    ]);
    expect(go.plan[0]?.planTaskId).toBe("p1");
  });

  it("shows each task on a live board, and lets the person step in", async () => {
    const state = projection({
      goals: [
        team({
          baseRef: "main",
          plan: [
            { planTaskId: "t1", title: "Theme tokens", buddyId: "b2", taskId: "t1" },
            { planTaskId: "t2", title: "Settings toggle", buddyId: "b3", taskId: "t2" },
            { planTaskId: "t3", title: "Docs", buddyId: "b2", taskId: "t3" },
          ],
        }),
      ],
      tasks: [
        job({ taskId: "t1", threadId: "th1" }),
        job({
          taskId: "t2",
          buddyId: "b3",
          status: "needs_you",
          needs: { kind: "handoff_limit", text: "Builder still has notes after 1 rounds" },
          reviews: [{ taskId: "r2", buddyId: "b2", verdict: "notes", notes: ["Fix it"] }],
        }),
        job({ taskId: "t3", status: "ready", reviews: [{ taskId: "r3", buddyId: "b3", verdict: "ok", notes: [] }] }),
      ],
    });
    const { commands, onOpenThread } = await render(state, teamPageId("g1"));
    const rows = [...document.querySelectorAll(".team-task")];
    expect(rows.map((row) => row.className.replace("team-task ", ""))).toEqual([
      "is-working",
      "is-needs_you",
      "is-done",
    ]);
    expect(rows[0]?.textContent).toContain("Builder · Working");
    expect(rows[1]?.textContent).toContain("Waiting for you");
    expect(document.querySelector(".team-count")?.textContent).toBe("1 of 3 done");

    await act(async () => buttonNamed("Open chat", rows[0] as HTMLElement).click());
    expect(onOpenThread).toHaveBeenCalledWith("th1");
    await act(async () => buttonNamed("Use as is", rows[1] as HTMLElement).click());
    expect(commands).toContainEqual({ type: "goal.task.accept", goalId: "g1", taskId: "t2" });
    await act(async () => buttonNamed("Stop Theme tokens").click());
    expect(commands).toContainEqual({ type: "goal.task.drop", goalId: "g1", taskId: "t1" });
  });

  it("ends with the summary, the combined diff, and Create PR", async () => {
    const state = projection({
      worktrees: [
        {
          worktreeId: "w-team",
          projectId: "p1",
          path: "/work/web-worktrees/team",
          branch: "team/dark",
          status: "ready",
          kind: "worktree",
        },
      ] as unknown as RuntimeProjection["worktrees"],
      reviews: [
        {
          worktreeId: "w-team",
          baseRef: "main",
          branch: "team/dark",
          state: "changes",
          files: [{ path: "src/theme.css", kind: "added", staged: true, additions: 12, deletions: 0, binary: false }],
          conflictFiles: [],
          updatedAt: at,
        },
      ] as unknown as RuntimeProjection["reviews"],
      goals: [
        team(
          {
            phase: "done",
            baseRef: "main",
            plan: [{ planTaskId: "t1", title: "Theme tokens", buddyId: "b2", taskId: "t1" }],
            combine: {
              branch: "team/dark",
              worktreeId: "w-team",
              merged: ["t1"],
              diff: { files: 1, insertions: 12, deletions: 0 },
            },
          },
          { status: "done", summary: "Added dark mode tokens. Tests pass." },
        ),
      ],
      tasks: [
        job({ taskId: "t1", status: "ready", reviews: [{ taskId: "r1", buddyId: "b3", verdict: "ok", notes: [] }] }),
      ],
    });
    const { commands } = await render(state, teamPageId("g1"));
    expect(document.querySelector(".team-summary-text")?.textContent).toBe("Added dark mode tokens. Tests pass.");
    expect(document.querySelector(".team-diffstat")?.textContent).toBe("1 file changed +12 −0");
    expect(document.querySelector(".team-combine")?.textContent).toContain("team/dark");
    expect(commands).toContainEqual({ type: "review.refresh", worktreeId: "w-team", baseRef: "main" });
    expect(document.querySelector(".team-diff-path")?.textContent).toBe("src/theme.css");
    await act(async () => buttonNamed("src/theme.css+12−0").click());
    expect(commands).toContainEqual({ type: "review.diff", worktreeId: "w-team", path: "src/theme.css" });
    expect(buttonNamed("Create PR")).toBeTruthy();
  });

  it("starts a new team with picked buddies, led by Primary", async () => {
    const state = projection({});
    const { commands, onSelect } = await render(state, teamPageId("new"));
    await typeInput(document.querySelector('[aria-label="Goal"]') as HTMLTextAreaElement, "Add dark mode");
    await act(async () => buttonNamed("Tester").click());
    await act(async () => buttonNamed("Start team").click());
    const create = commands.find((command) => command.type === "goal.create") as {
      goal: { goalId: string; buddyId: string; text: string; projectId: string; team: unknown };
    };
    expect(create.goal).toMatchObject({
      buddyId: "lead",
      text: "Add dark mode",
      projectId: "p1",
      team: { autoStart: false, buddyIds: ["b3"] },
    });
    expect(onSelect).toHaveBeenCalledWith(teamPageId(create.goal.goalId));
  });

  it("lists teams going now under Buddies in the sidebar, each opening its page", async () => {
    const onOpen = vi.fn();
    const state = projection({
      goals: [team({ phase: "working" }), team({}, { goalId: "g2", text: "Old work", status: "done" })],
    });
    await renderWithRuntime(<SidebarBuddies projection={state} onOpen={onOpen} active={teamPageId("g1")} />, () => ({
      result: {},
    }));
    const rows = [...document.querySelectorAll(".sidebar-team-row")];
    expect(rows.map((row) => row.textContent)).toEqual(["Add dark mode"]);
    expect(rows[0]?.getAttribute("aria-current")).toBe("page");
    await act(async () => (rows[0] as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledWith(teamPageId("g1"));
  });
});
