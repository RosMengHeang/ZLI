import { describe, expect, it } from "vitest";

import {
  closeProjectAgents,
  focusProject,
  forgetSession,
  forgetStaleBoards,
  openProjectAgents,
  parseWorkbenchState,
  sessionProjects,
  type WorkbenchState,
} from "./workbench.js";

const empty = parseWorkbenchState(null);
const state = (patch: Partial<WorkbenchState> = {}): WorkbenchState => ({ ...empty, ...patch });
// Project A has three agents and project B has one; "loose" has no project, like a session whose worktree is gone.
const projectOf = new Map([
  ["a1", "A"],
  ["a2", "A"],
  ["a3", "A"],
  ["b1", "B"],
]);
const open = (current: WorkbenchState) =>
  ["a1", "a2", "a3", "b1", "loose"].filter((id) => !current.closed.includes(id));

describe("project boards", () => {
  it("reads saved layouts from before boards existed without losing anything", () => {
    const saved = parseWorkbenchState(JSON.stringify({ closed: ["a1"], activeSessionId: "a2", drawerOpen: true }));
    expect(saved.closed).toEqual(["a1"]);
    expect(saved.boards).toEqual({});
    expect(saved.activeSessionId).toBe("a2");
    expect(saved.drawerOpen).toBe(true);
  });

  it("keeps remembered boards across a reload and drops malformed ones", () => {
    const saved = parseWorkbenchState(JSON.stringify({ boards: { A: ["a1", 2, "a3"], B: "b1", C: [], D: { x: 1 } } }));
    expect(saved.boards).toEqual({ A: ["a1", "a3"] });
    expect(parseWorkbenchState(JSON.stringify({ boards: ["A"] })).boards).toEqual({});
    const focused = focusProject(state(), projectOf, "B");
    expect(parseWorkbenchState(JSON.stringify(focused)).boards).toEqual(focused.boards);
  });

  it("swaps one project's board for another and back again", () => {
    const onB = focusProject(state({ activeSessionId: "a2" }), projectOf, "B");
    expect(open(onB)).toEqual(["b1", "loose"]);
    expect(onB.boards).toEqual({ A: ["a1", "a2", "a3"] });
    expect(onB.activeSessionId).toBe("b1");

    const onA = focusProject(onB, projectOf, "A");
    expect(open(onA)).toEqual(["a1", "a2", "a3", "loose"]);
    expect(onA.boards).toEqual({ B: ["b1"] });
    expect(onA.activeSessionId).toBe("a3");
  });

  it("brings back exactly the tiles that were open, not the ones closed before", () => {
    const onB = focusProject(state({ closed: ["a2"] }), projectOf, "B");
    expect(onB.boards.A).toEqual(["a1", "a3"]);
    const onA = focusProject(onB, projectOf, "A");
    expect(open(onA)).toEqual(["a1", "a3", "loose"]);
    expect(onA.closed).toEqual(["a2", "b1"]);
  });

  it("opens all of a project's agents when it has nothing open or remembered", () => {
    const next = focusProject(state({ closed: ["a1", "a2", "a3"] }), projectOf, "A");
    expect(open(next)).toEqual(["a1", "a2", "a3", "loose"]);
  });

  it("adds tiles opened one by one to what the project remembers", () => {
    const onB = focusProject(state(), projectOf, "B");
    const peek = { ...onB, closed: onB.closed.filter((id) => id !== "a1") };
    const onA = focusProject(peek, projectOf, "A");
    expect(open(onA)).toEqual(["a1", "a2", "a3", "loose"]);
  });

  it("keeps a new agent started in a hidden project on the board until that project is hidden again", () => {
    const onA = focusProject(state(), projectOf, "A");
    const withNew = new Map([...projectOf, ["b2", "B"]]);
    expect(onA.closed.includes("b2")).toBe(false);
    const again = focusProject(onA, withNew, "A");
    expect(again.closed).toContain("b2");
    expect(again.boards.B).toEqual(["b1", "b2"]);
  });

  it("un-maximizes a tile that leaves the board, and keeps one that stays", () => {
    expect(focusProject(state({ maximizedSessionId: "b1" }), projectOf, "A").maximizedSessionId).toBeUndefined();
    const kept = focusProject(state({ maximizedSessionId: "a2", activeSessionId: "a2" }), projectOf, "A");
    expect(kept.maximizedSessionId).toBe("a2");
    expect(kept.activeSessionId).toBe("a2");
  });

  it("changes nothing for a project that is already alone on the board, or has no agents", () => {
    const alone = state({ closed: ["b1"], activeSessionId: "a1" });
    expect(focusProject(alone, projectOf, "A")).toBe(alone);
    const current = state();
    expect(focusProject(current, projectOf, "C")).toBe(current);
    expect(openProjectAgents(current, projectOf, "C")).toBe(current);
    expect(closeProjectAgents(current, projectOf, "C")).toBe(current);
  });

  it("closes a project's tiles without touching its agents, and remembers them", () => {
    const launching = {
      sessionId: "a3",
      worktreeId: "w",
      provider: "codex",
      mode: "chat" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const current = state({ activeSessionId: "a1", maximizedSessionId: "a1", pending: [launching] });
    const closed = closeProjectAgents(current, projectOf, "A");
    expect(open(closed)).toEqual(["b1", "loose"]);
    expect(closed.pending).toEqual([launching]);
    expect(closed.boards).toEqual({ A: ["a1", "a2", "a3"] });
    expect(closed.activeSessionId).toBeUndefined();
    expect(closed.maximizedSessionId).toBeUndefined();
    expect(closeProjectAgents(closed, projectOf, "A")).toBe(closed);
    expect(open(focusProject(closed, projectOf, "A"))).toEqual(["a1", "a2", "a3", "loose"]);
  });

  it("opens every agent of a project and forgets its board", () => {
    const current = state({ closed: ["a1", "a2", "b1"], boards: { A: ["a1"] }, maximizedSessionId: "a3" });
    const opened = openProjectAgents(current, projectOf, "A");
    expect(open(opened)).toEqual(["a1", "a2", "a3", "loose"]);
    expect(opened.boards).toEqual({});
    expect(opened.maximizedSessionId).toBeUndefined();
    expect(opened.activeSessionId).toBe("a3");
    expect(openProjectAgents(opened, projectOf, "A")).toBe(opened);
  });

  it("forgets deleted agents, agents whose worktree is gone, and removed projects", () => {
    const current = state({ boards: { A: ["a1", "a2"], B: ["b1"], Gone: ["g1"] } });
    expect(forgetSession(current, "a1").boards).toEqual({ A: ["a2"], B: ["b1"], Gone: ["g1"] });
    expect(forgetSession(current, "b1").boards).toEqual({ A: ["a1", "a2"], Gone: ["g1"] });
    const withoutA2 = new Map([...projectOf].filter(([id]) => id !== "a2"));
    const pruned = forgetStaleBoards(current, withoutA2, new Set(["A", "B"]));
    expect(pruned.boards).toEqual({ A: ["a1"], B: ["b1"] });
    expect(forgetStaleBoards(pruned, withoutA2, new Set(["A", "B"]))).toBe(pruned);
    expect(focusProject(pruned, withoutA2, "A").closed).toEqual(["b1"]);
  });
});

describe("sessionProjects", () => {
  it("puts each session, sub-agents included, in its worktree's project and leaves unknown worktrees out", () => {
    const worktrees = [
      { worktreeId: "main-a", projectId: "A" },
      { worktreeId: "feature-a", projectId: "A" },
      { worktreeId: "main-b", projectId: "B" },
    ];
    const sessions = [
      { sessionId: "lead", worktreeId: "main-a" },
      { sessionId: "sub", worktreeId: "feature-a" },
      { sessionId: "other", worktreeId: "main-b" },
      { sessionId: "orphan", worktreeId: "removed" },
    ];
    expect([...sessionProjects(sessions, worktrees)]).toEqual([
      ["lead", "A"],
      ["sub", "A"],
      ["other", "B"],
    ]);
  });
});
