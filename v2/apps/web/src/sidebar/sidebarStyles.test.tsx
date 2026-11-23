// @vitest-environment jsdom

import {
  EnvironmentId,
  ProjectId,
  type PullRequestInfo,
  type RuntimeProjection,
  ThreadId,
  WorktreeId,
  type WorktreeProjection,
} from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { refreshPullRequest, resetPullRequestStoreForTests } from "../review/pullRequestStore.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import type { AgentSession } from "../sessions/sessions.js";
import { Sidebar } from "./Sidebar.js";
import type { SidebarStyle } from "./sidebarLayout.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const repoId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const otherId = ProjectId.parse("00000000-0000-4000-8000-000000000020");
const plainId = ProjectId.parse("00000000-0000-4000-8000-000000000030");

const worktreeId = (index: number) =>
  WorktreeId.parse(`00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`);
const worktree = (index: number, branch: string, projectId = repoId): WorktreeProjection => ({
  worktreeId: worktreeId(index),
  projectId,
  path: `/work/${branch}`,
  branch,
  status: "ready",
  kind: "worktree",
});

const pullRequest = (fields: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
  number: 7,
  url: "https://github.com/example/repo/pull/7",
  state: "OPEN",
  isDraft: false,
  ...fields,
});

const session = (index: number, id: string, status: AgentSession["status"], updatedAt = "2026-01-01T00:00:00.000Z") =>
  ({
    sessionId: id,
    worktreeId: worktreeId(index),
    provider: "claude",
    status,
    mode: "terminal",
    createdAt: updatedAt,
    updatedAt,
  }) as AgentSession;

/** An agent in a chat, so it has the thread id that names and sub-agents go by. */
const chat = (
  index: number,
  id: string,
  status: AgentSession["status"],
  fields: { name?: string; startedBy?: string; createdAt?: string } = {},
) =>
  ({
    ...session(index, id, status, fields.createdAt),
    mode: "chat",
    thread: { threadId: id, name: fields.name, startedBy: fields.startedBy },
  }) as unknown as AgentSession;

const worktrees = [
  worktree(1, "working-branch"),
  worktree(2, "ready-branch"),
  worktree(3, "review-branch"),
  worktree(4, "clean-branch"),
  worktree(5, "busy-ready-branch"),
  worktree(6, "other-branch", otherId),
  worktree(7, "unused", plainId),
];

const projection = (): RuntimeProjection =>
  ({
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: { worktrees: true, terminals: true, browser: true, eventReplay: true },
    },
    projects: [
      { projectId: repoId, path: "/work/repo", name: "repo" },
      { projectId: otherId, path: "/work/other", name: "other" },
      { projectId: plainId, path: "/work/plain", name: "plain", git: false },
    ],
    worktrees,
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    reviews: [
      {
        worktreeId: worktreeId(1),
        baseRef: "main",
        branch: "working-branch",
        state: "changes",
        conflictFiles: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
        files: [{ path: "a.ts", kind: "modified", staged: false, additions: 214, deletions: 38, binary: false }],
      },
    ],
    lastSequence: 1,
  }) as RuntimeProjection;

const commands: { type: string }[] = [];
const prs = new Map<string, PullRequestInfo>([
  [worktreeId(2), pullRequest()],
  [worktreeId(3), pullRequest({ number: 8, checks: [{ name: "ci", state: "failed" }] as PullRequestInfo["checks"] })],
  [worktreeId(5), pullRequest({ number: 9 })],
]);

const status = (id: string) => ({
  branch: worktrees.find((entry) => entry.worktreeId === id)?.branch ?? "main",
  ...(prs.get(id) ? { pullRequest: prs.get(id) } : {}),
  uncommittedFiles: 0,
  defaults: { title: "t", body: "b", base: "main" },
});

const dispatch = vi.fn(async (request: unknown) => {
  const { command } = request as { command: { type: string; worktreeId: string } };
  commands.push(command);
  if (command.type === "review.pr.status") return { accepted: true, result: status(command.worktreeId) };
  if (command.type === "review.pr.merge") {
    return {
      accepted: true,
      result: { pullRequest: pullRequest({ state: "MERGED" }), branchDeleted: true },
    };
  }
  return { accepted: true, result: {} };
});

const bridge = {
  runtime: { dispatch, getProjection: async () => undefined, onProjection: () => () => undefined },
} as unknown as ZliBridge;

const sessions = [
  session(1, "busy", "working"),
  session(2, "finished", "ready"),
  session(5, "still-pushing", "working"),
  session(6, "over-there", "waiting"),
];

const noop = () => undefined;

const roots: ReturnType<typeof createRoot>[] = [];

async function mount(
  style: SidebarStyle,
  options: {
    agents?: AgentSession[];
    currentProjectId?: string;
    onSelectSession?: (session: AgentSession) => void;
    onOpenSettings?: () => void;
    onOpenProject?: () => void;
    onNewAgent?: (project?: unknown) => void;
    noProjects?: boolean;
    onOpenSearch?: () => void;
    requests?: RuntimeProjection["requests"];
    /** Branch names by worktree index, for rows whose name matters to the test. */
    worktreeNames?: Record<number, string>;
  } = {},
) {
  await act(async () => {
    await Promise.all(worktrees.map((entry) => refreshPullRequest(dispatch as never, entry.worktreeId, true)));
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <RuntimeProvider bridge={bridge}>
        <Sidebar
          sidebarStyle={style}
          projection={
            options.noProjects
              ? { ...projection(), projects: [], worktrees: [] }
              : {
                  ...projection(),
                  requests: options.requests,
                  worktrees: worktrees.map((entry, index) => ({
                    ...entry,
                    branch: options.worktreeNames?.[index + 1] ?? entry.branch,
                  })),
                }
          }
          onOpenSearch={options.onOpenSearch}
          sessions={options.agents ?? sessions}
          activeSessionId={undefined}
          backgroundSessionIds={new Set()}
          activeWorktreeId={undefined}
          currentProjectId={options.currentProjectId}
          onSelectSession={options.onSelectSession ?? noop}
          onDeleteSession={noop}
          onSelectWorktree={noop}
          onNewAgent={options.onNewAgent ?? noop}
          onOpenProject={options.onOpenProject ?? noop}
          onCreateWorktree={noop}
          onRemoveProject={async () => undefined}
          onRenameProject={noop}
          onWorktreeAction={noop}
          onReviewSetup={noop}
          onShowSetupOutput={noop}
          onOpenSettings={options.onOpenSettings ?? noop}
          onOpenUsage={noop}
          onHideSidebar={noop}
        />
      </RuntimeProvider>,
    );
  });
  return container;
}

const button = (root: ParentNode, label: string) => {
  const found = [...root.querySelectorAll("button")].find(
    (entry) => entry.getAttribute("aria-label") === label || entry.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
};

const menuItems = () => [...document.querySelectorAll<HTMLElement>('.menu [role^="menuitem"]')];

const stageKeys: Record<string, string> = {
  "Needs you": "attention",
  Working: "working",
  "In review": "review",
  "Ready to merge": "ready",
  "Folders without Git": "noGit",
  Merged: "merged",
  "No changes": "quiet",
};

/** The titles of the rows shown in one stage. The list has no headings, so each row carries its stage. */
const stageRows = (root: ParentNode, label: string) =>
  [...root.querySelectorAll(`.ship-entry[data-stage="${stageKeys[label]}"] > .ship-head .ship-name`)].map(
    (entry) => entry.textContent,
  );

beforeEach(() => {
  commands.length = 0;
  resetPullRequestStoreForTests();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe("sidebar styles", () => {
  it("keeps notes out of the tree, so it stays as it was", async () => {
    const container = await mount("tree", { agents: [chat(1, "lead", "working")] });
    expect(container.querySelector(".session-note")).toBeNull();
    expect(container.querySelector(".sidebar-top")).not.toBeNull();
  });
});

describe("Branches style", () => {
  it("sorts branches by how close they are to shipping", async () => {
    const container = await mount("branches");
    expect(stageRows(container, "Needs you")).toEqual(["other-branch"]);
    expect(stageRows(container, "Working")).toEqual(expect.arrayContaining(["working-branch", "busy-ready-branch"]));
    expect(stageRows(container, "In review")).toEqual(["review-branch"]);
    expect(stageRows(container, "Ready to merge")).toEqual(["ready-branch"]);
    expect(stageRows(container, "Folders without Git")).toEqual(["plain"]);
    expect(container.textContent).toContain("1 check failed");
  });

  it("lists every stage in one list with no headings, what needs the person first", async () => {
    const container = await mount("branches");
    expect(container.querySelector(".ship-stage-heading")).toBeNull();
    const order = [...container.querySelectorAll('[aria-label="Branches"] .ship-entry')].map(
      (entry) => (entry as HTMLElement).dataset.stage,
    );
    expect(order).toEqual(["attention", "working", "working", "review", "ready", "noGit"]);
  });

  it("names the project on every row while several are listed, even one asking a question", async () => {
    const container = await mount("branches");
    const waiting = container.querySelector(`[data-worktree-id="${worktreeId(6)}"]`);
    expect(waiting?.querySelector(".ship-project")?.textContent).toBe("other");
    expect(waiting?.querySelector(".ship-text.is-waiting")?.textContent).toBe("Needs input");
    expect(container.querySelector(".ship-diff")).toBeNull();
  });

  it("keeps line totals in the row's tooltip, so the row stays two calm lines", async () => {
    window.localStorage.setItem("zli.sidebar.branchesProject", repoId);
    const container = await mount("branches");
    expect(container.querySelector(".ship-project")).toBeNull();
    const row = container.querySelector(`[data-worktree-id="${worktreeId(1)}"] .ship-row`);
    expect(row?.getAttribute("title")).toContain("+214 -38 lines");
  });

  it("shows how long ago a branch's agents last moved", async () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const container = await mount("branches", { agents: [session(1, "busy", "working", recent)] });
    expect(container.querySelector(`[data-worktree-id="${worktreeId(1)}"] .ship-time`)?.textContent).toBe("5m");
  });

  it("folds branches with nothing left to do into Done and opens it on request", async () => {
    const container = await mount("branches");
    expect(stageRows(container, "No changes")).toEqual([]);
    await act(async () => button(container, "Done 1").click());
    expect(stageRows(container, "No changes")).toEqual(["clean-branch"]);
  });

  it("puts a merged branch in Done too, saying it merged", async () => {
    prs.set(worktreeId(4), pullRequest({ state: "MERGED" }));
    const container = await mount("branches");
    await act(async () => button(container, "Done 1").click());
    expect(stageRows(container, "Merged")).toEqual(["clean-branch"]);
    expect(container.querySelector('[data-stage="merged"] .ship-text')?.textContent).toContain("Merged");
    prs.delete(worktreeId(4));
  });

  it("says a project has no branches yet when nothing is listed for it", async () => {
    window.localStorage.setItem("zli.sidebar.branchesProject", otherId);
    const empty = await mount("branches", { agents: [] });
    expect(empty.querySelector(".ship-empty")?.textContent).toContain("No branches yet.");
  });

  it("spins only while something runs, so an idle branch with changes keeps a plain dot", async () => {
    const container = await mount("branches", { agents: [session(1, "idle", "ready")] });
    const idle = container.querySelector(`[data-worktree-id="${worktreeId(1)}"]`);
    expect(stageRows(container, "Working")).toEqual(["working-branch"]);
    expect(idle?.querySelector(".spinner")).toBeNull();
    expect(idle?.querySelector(".ship-dot")).not.toBeNull();
    const busy = await mount("branches", { agents: [session(1, "busy", "working")] });
    expect(busy.querySelector(`[data-worktree-id="${worktreeId(1)}"] .spinner`)).not.toBeNull();
  });

  it("shows what a waiting agent is asking, and a plain status when it has not said", async () => {
    const thread = { threadId: ThreadId.parse("00000000-0000-4000-8000-000000000900") };
    const asking = { ...session(1, "asking", "waiting"), thread } as AgentSession;
    const quiet = await mount("branches", { agents: [asking] });
    expect(quiet.querySelector(".ship-text.is-waiting")?.textContent).toBe("Needs input");
    const asked = await mount("branches", {
      agents: [asking],
      requests: [
        {
          requestId: "r1",
          threadId: thread.threadId,
          kind: "user-input",
          payload: { questions: [{ id: "q", question: "Which postal format?" }] },
        },
      ],
    });
    expect(asked.querySelector(".ship-text.is-waiting")?.textContent).toBe("Which postal format?");
  });

  it("shortens a branch name unless two rows would then look the same", async () => {
    const named = await mount("branches", { worktreeNames: { 1: "fix/plan-limits" } });
    expect(stageRows(named, "Working")).toContain("plan-limits");
    const row = named.querySelector(`[data-worktree-id="${worktreeId(1)}"] .ship-row`);
    expect(row?.getAttribute("title")).toContain("fix/plan-limits");
    const clashing = await mount("branches", { worktreeNames: { 1: "fix/same", 5: "feat/same" } });
    expect(stageRows(clashing, "Working")).toEqual(expect.arrayContaining(["fix/same", "feat/same"]));
  });

  it("keeps the search box, and lists the chats it finds in place of the branches", async () => {
    const container = await mount("branches", { agents: [chat(1, "lead", "working", { name: "Lead" })] });
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Find a chat"]');
    expect(search).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(search, "lead");
      search?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".sidebar-results")).not.toBeNull();
    expect(container.querySelector(".ship-filter")).toBeNull();
  });

  it("offers Merge only when nothing is holding it back and no agent is still running", async () => {
    const container = await mount("branches");
    expect(button(container, "Merge ready-branch")).toBeTruthy();
    expect(() => button(container, "Merge busy-ready-branch")).toThrow();
    expect(() => button(container, "Merge review-branch")).toThrow();
  });

  it("asks before merging, then moves the branch out of Ready", async () => {
    const container = await mount("branches");
    await act(async () => button(container, "Merge ready-branch").click());
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Merge pull request"]')).not.toBeNull());
    expect(commands.some((command) => command.type === "review.pr.merge")).toBe(false);
    await act(async () => button(document.body, "Squash and merge").click());
    expect(commands.some((command) => command.type === "review.pr.merge")).toBe(true);
    await vi.waitFor(() => expect(stageRows(container, "Ready to merge")).toEqual([]));
  });

  it("gives a one-agent row that agent's actions and opens the agent", async () => {
    const onSelectSession = vi.fn();
    const container = await mount("branches", { onSelectSession });
    const row = container.querySelector(`[data-worktree-id="${worktreeId(2)}"]`);
    if (!row) throw new Error("No row");
    await act(async () => row.querySelector<HTMLButtonElement>(".ship-row")?.click());
    expect(onSelectSession.mock.calls[0]?.[0].sessionId).toBe("finished");
    await act(async () => button(row, "Branch actions").click());
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
    expect(items).toEqual(expect.arrayContaining(["Copy branch name", "Delete agent", "Delete worktree"]));
  });

  it("expands a row with several agents to the normal agent rows", async () => {
    const agents = [session(1, "first", "working"), session(1, "second", "ready")];
    const container = await mount("branches", { agents });
    expect(container.querySelector(".session-row")).toBeNull();
    await act(async () => button(container, "Show 2 agents").click());
    expect(container.querySelectorAll(".ship-agents .session-row")).toHaveLength(2);
  });

  it("offers Copy branch name on a row with several agents", async () => {
    const agents = [session(1, "first", "working"), session(1, "second", "ready")];
    const container = await mount("branches", { agents });
    const row = container.querySelector(`[data-worktree-id="${worktreeId(1)}"]`);
    if (!row) throw new Error("No row");
    await act(async () => button(row, "Branch actions").click());
    expect(menuItems().map((item) => item.textContent)).toContain("Copy branch name");
  });

  it("opens the agent whose question the row shows, not the newest one", async () => {
    const onSelectSession = vi.fn();
    const asker = chat(1, "asker", "waiting", { createdAt: "2026-01-01T00:00:00.000Z" });
    const newest = chat(1, "newest", "working", { createdAt: "2026-02-01T00:00:00.000Z" });
    const container = await mount("branches", {
      agents: [asker, newest],
      onSelectSession,
      requests: [
        {
          requestId: "r",
          threadId: "asker",
          kind: "user-input",
          payload: { questions: [{ id: "q", question: "Which format?" }] },
        },
      ] as unknown as RuntimeProjection["requests"],
    });
    expect(container.textContent).toContain("Which format?");
    const row = container.querySelector(`[data-worktree-id="${worktreeId(1)}"]`);
    await act(async () => row?.querySelector<HTMLButtonElement>(".ship-row")?.click());
    expect(onSelectSession.mock.calls[0]?.[0].sessionId).toBe("asker");
  });

  it("lists a waiting folder without Git under Needs you, by the folder's name", async () => {
    const container = await mount("branches", { agents: [session(7, "asking", "waiting")] });
    expect(stageRows(container, "Needs you")).toEqual(["plain"]);
    expect(stageRows(container, "Folders without Git")).toEqual([]);
  });

  it("titles a row by the name the person gave its agent when it has no task yet, with the branch below", async () => {
    window.localStorage.setItem("zli.sidebar.branchesProject", repoId);
    const container = await mount("branches", { agents: [chat(1, "lead", "working", { name: "Lead" })] });
    expect(container.querySelector(".ship-name")?.textContent).toBe("Lead");
    expect(container.querySelector(".ship-text")?.textContent).toBe("working-branch");
  });

  it("nests a sub-agent on its parent's branch and counts it on the row", async () => {
    window.localStorage.setItem("zli.sidebar.branchesProject", repoId);
    const agents = [
      chat(1, "lead", "working", { name: "Lead" }),
      chat(1, "helper", "working", { name: "Helper", startedBy: "lead" }),
    ];
    const container = await mount("branches", { agents });
    expect(container.querySelector(".ship-name")?.textContent).toBe("Lead");
    await act(async () => button(container, "Show 2 agents").click());
    expect(container.querySelector('[aria-label="Sub-agents of Lead"] .session-name')?.textContent).toBe("Helper");
  });

  it("shows a sub-agent on another branch once, as that branch's row, saying who started it", async () => {
    window.localStorage.setItem("zli.sidebar.branchesProject", repoId);
    const agents = [
      chat(1, "lead", "working", { name: "Lead" }),
      chat(2, "helper", "working", { name: "Helper", startedBy: "lead" }),
    ];
    const container = await mount("branches", { agents });
    const helperRow = container.querySelector(`[data-worktree-id="${worktreeId(2)}"]`);
    expect(helperRow?.querySelector(".ship-name")?.textContent).toBe("Helper");
    expect(helperRow?.querySelector(".ship-row")?.getAttribute("title")).toContain("Started by Lead");
    const leadRow = container.querySelector(`[data-worktree-id="${worktreeId(1)}"]`);
    if (!leadRow) throw new Error("No row");
    // The lead's row has nothing to expand.
    expect(leadRow.querySelector(".ship-marks-toggle")).toBeNull();
    expect(container.querySelector(".sub-agent-list")).toBeNull();
  });

  it("filters to one project and says when it has no branches", async () => {
    const container = await mount("branches");
    expect(container.querySelector(".ship-project")).not.toBeNull();
    window.localStorage.setItem("zli.sidebar.branchesProject", otherId);
    const filtered = await mount("branches");
    expect(stageRows(filtered, "Needs you")).toEqual(["other-branch"]);
    expect(filtered.querySelector(".ship-project")).toBeNull();
    expect(filtered.querySelector('[aria-label="other actions"]')).not.toBeNull();
  });

  it("lists a folder's agents directly when one without Git is picked", async () => {
    window.localStorage.setItem("zli.sidebar.branchesProject", plainId);
    const agents = [session(7, "first", "ready"), session(7, "second", "working")];
    const container = await mount("branches", { agents });
    expect(container.querySelector(".ship-name")).toBeNull();
    expect(container.querySelector('section[aria-label="Folders without Git"]')).toBeNull();
    expect(container.querySelectorAll(".ship-folder-agents .session-row")).toHaveLength(2);
    expect(() => button(container, "Create worktree")).toThrow();
    expect(button(container, "plain actions")).toBeTruthy();
  });

  it("says a folder without Git has no agents yet, and offers to start one", async () => {
    window.localStorage.setItem("zli.sidebar.branchesProject", plainId);
    const container = await mount("branches", { agents: [] });
    expect(container.textContent).toContain("No agents yet.");
    expect(button(container, "Start an agent in plain")).toBeTruthy();
  });

  it("explains when GitHub cannot be asked, since Merge will not appear", async () => {
    prs.set(worktreeId(4), pullRequest({ state: "CLOSED" }));
    const original = status;
    const spy = dispatch.getMockImplementation();
    dispatch.mockImplementation(async (request: unknown) => {
      const { command } = request as { command: { type: string; worktreeId: string } };
      return {
        accepted: true,
        result: {
          ...original(command.worktreeId),
          problem: { code: "gh_missing", message: "Install the GitHub CLI." },
        },
      };
    });
    const container = await mount("branches");
    expect(container.textContent).toContain("Merge needs GitHub: Install the GitHub CLI.");
    if (spy) dispatch.mockImplementation(spy);
    prs.delete(worktreeId(4));
  });
});

describe("Branches style header", () => {
  const openFilter = async (container: HTMLElement, name = "All projects") => {
    await act(async () => button(container, `Project filter: ${name}`).click());
  };

  it("keeps the one search row, with New chat and Add project beside it", async () => {
    const container = await mount("branches");
    expect(container.querySelector(".sidebar-primary")).not.toBeNull();
    expect(button(container, "New chat")).toBeTruthy();
    expect(button(container, "Add project")).toBeTruthy();
  });

  it("lists every project, then Add project last, in the filter", async () => {
    const onOpenProject = vi.fn();
    const container = await mount("branches", { onOpenProject });
    await openFilter(container);
    expect(menuItems().map((item) => item.textContent)).toEqual([
      "All projects",
      "repo",
      "other",
      "plain",
      "Add project",
    ]);
    await act(async () => menuItems().at(-1)?.click());
    expect(onOpenProject).toHaveBeenCalledOnce();
    expect(document.querySelector(".menu")).toBeNull();
  });

  it("shows which projects have work waiting or running", async () => {
    const container = await mount("branches");
    await openFilter(container);
    const dot = (name: string) =>
      menuItems()
        .find((item) => item.textContent === name)
        ?.querySelector(".ship-menu-dot")?.className;
    expect(dot("repo")).toContain("is-working");
    expect(dot("other")).toContain("is-waiting");
    expect(dot("plain")).toBeUndefined();
  });

  it("narrows to the picked project and starts new chats there", async () => {
    const onNewAgent = vi.fn();
    const container = await mount("branches", { onNewAgent });
    await act(async () => button(container, "New chat").click());
    expect(onNewAgent).toHaveBeenLastCalledWith(undefined);
    await openFilter(container);
    await act(async () =>
      menuItems()
        .find((item) => item.textContent === "other")
        ?.click(),
    );
    expect(stageRows(container, "Needs you")).toEqual(["other-branch"]);
    await act(async () => button(container, "New chat").click());
    expect(onNewAgent.mock.lastCall?.[0]?.name).toBe("other");
  });

  it("makes Edit in the project's menu open a rename field", async () => {
    const container = await mount("branches");
    await openFilter(container);
    await act(async () =>
      menuItems()
        .find((item) => item.textContent === "other")
        ?.click(),
    );
    await act(async () => button(container, "other actions").click());
    await act(async () =>
      menuItems()
        .find((item) => item.textContent === "Edit")
        ?.click(),
    );
    expect(container.querySelector('input[aria-label="Rename other"]')).not.toBeNull();
  });

  it("with no projects, says how to start and still offers Add project", async () => {
    const container = await mount("branches", { noProjects: true });
    expect(container.querySelector(".sidebar-empty")).not.toBeNull();
    expect(button(container, "Add project")).toBeTruthy();
  });
});

describe("Project rail style", () => {
  it("names each project and its live counts on the strip", async () => {
    const container = await mount("rail");
    const tiles = [...container.querySelectorAll(".rail-tile")].map((tile) => tile.getAttribute("aria-label"));
    expect(tiles).toEqual(["repo, 2 working", "other, 1 waiting", "plain"]);
  });

  it("follows the project being worked in, and a tile switches the panel", async () => {
    const container = await mount("rail", { currentProjectId: otherId });
    expect(container.querySelector(".rail-project-name")?.textContent).toBe("other");
    await act(async () => button(container, "repo, 2 working").click());
    expect(container.querySelector(".rail-project-name")?.textContent).toBe("repo");
    expect(container.querySelector('.rail-tile[aria-current="true"]')?.getAttribute("aria-label")).toBe(
      "repo, 2 working",
    );
  });

  it("lists running agents first, then recent ones, and unfolds the earlier ones in place", async () => {
    const agents = [
      session(1, "running", "working", "2026-01-01T00:00:00.000Z"),
      ...["a", "b", "c", "d", "e"].map((id, index) => session(4, id, "ready", `2026-01-0${index + 1}T00:00:00.000Z`)),
    ];
    const container = await mount("rail", { agents, currentProjectId: repoId });
    expect(container.querySelectorAll(".session-row")).toHaveLength(4);
    const earlier = button(container, "2 earlier agents");
    expect(earlier.getAttribute("aria-expanded")).toBe("false");
    await act(async () => earlier.click());
    expect(container.querySelectorAll(".session-row")).toHaveLength(6);
    expect(button(container, "2 earlier agents").getAttribute("aria-expanded")).toBe("true");
  });

  it("counts a failed agent on its project's tile, so the failure is seen from any project", async () => {
    const container = await mount("rail", { agents: [session(6, "broke", "failed")], currentProjectId: repoId });
    const tile = button(container, "other, 1 failed");
    expect(tile.querySelector(".rail-badge.is-failed")).not.toBeNull();
  });

  it("offers Search on the strip, as Branches does in its top row", async () => {
    const onOpenSearch = vi.fn();
    const container = await mount("rail", { onOpenSearch });
    await act(async () => button(container.querySelector(".rail-actions") as HTMLElement, "Search").click());
    expect(onOpenSearch).toHaveBeenCalledOnce();
  });

  it("lifts an agent that needs the person, even through a sub-agent, above the running ones", async () => {
    const agents = [
      chat(1, "running", "working", { createdAt: "2026-02-01T00:00:00.000Z" }),
      chat(1, "lead", "ready", { name: "Lead", createdAt: "2026-01-01T00:00:00.000Z" }),
      chat(1, "helper", "waiting", { startedBy: "lead", createdAt: "2026-01-02T00:00:00.000Z" }),
    ];
    const container = await mount("rail", { agents, currentProjectId: repoId });
    const top = [...container.querySelectorAll(".rail-scroll > .sidebar-project > .session-list > .session-entry")];
    expect(top[0]?.querySelector(".session-name")?.textContent).toBe("Lead");
    expect(container.querySelector(".rail-heading")).toBeNull();
  });

  it("drops the top row: the logo tops the strip, and Hide sidebar moves beside Settings", async () => {
    const container = await mount("rail");
    expect(container.querySelector(".sidebar-top")).toBeNull();
    expect(container.querySelector(".rail .rail-logo svg, .rail .rail-logo img")).not.toBeNull();
    expect(container.querySelector('.rail-actions [aria-label="Hide sidebar"]')).not.toBeNull();
  });

  it("says what an agent is asking in place of its branch, and that it needs input when it has not said", async () => {
    const container = await mount("rail", {
      agents: [chat(1, "asker", "waiting"), session(2, "terminal", "waiting")],
      currentProjectId: repoId,
      requests: [
        {
          requestId: "r",
          threadId: "asker",
          kind: "user-input",
          payload: { questions: [{ id: "q", question: "Which format?" }] },
        },
      ] as unknown as RuntimeProjection["requests"],
    });
    // A chat says what it asks on its own live line; a terminal agent that has not said gets the note.
    const notes = [...container.querySelectorAll(".session-note.is-waiting")].map((note) => note.textContent);
    expect(notes).toEqual(["Needs input"]);
  });

  it("lifts a stopped agent whose pull request failed its checks, and says so", async () => {
    const container = await mount("rail", {
      agents: [session(1, "running", "working"), session(3, "reviewed", "ready")],
      currentProjectId: repoId,
    });
    expect(container.querySelector(".rail-heading")).toBeNull();
    const first = container.querySelector(".rail-scroll .session-entry");
    expect(first?.querySelector(".session-note.is-failed")?.textContent).toBe("1 check failed");
  });

  it("says an agent is working and names its branch", async () => {
    const container = await mount("rail", { agents: [session(1, "running", "working")], currentProjectId: repoId });
    // A working row's dot says so, and its second line shows what it is doing; the branch is in the tooltip.
    expect(container.querySelector(".session-dot.is-working")).not.toBeNull();
    expect(container.querySelector(".session-row")?.getAttribute("title")).toContain("working-branch");
  });

  it("keeps sub-agent rows to their task, with the branch in the tooltip", async () => {
    const agents = [
      chat(1, "lead", "working", { name: "Lead" }),
      chat(1, "helper", "working", { name: "Helper", startedBy: "lead" }),
      chat(2, "elsewhere", "working", { name: "Elsewhere", startedBy: "lead" }),
    ];
    const container = await mount("rail", { agents, currentProjectId: repoId });
    const entryOf = (name: string) =>
      [...container.querySelectorAll(".sub-agent-list .session-entry")].find(
        (entry) => entry.querySelector(".session-name")?.textContent === name,
      );
    expect(entryOf("Helper")?.querySelector(".session-branch")).toBeNull();
    expect(entryOf("Elsewhere")?.querySelector(".session-row")?.getAttribute("title")).toContain("ready-branch");
  });

  it("names a running agent's failure in the row's name for a screen reader", async () => {
    const container = await mount("rail", { agents: [session(3, "reviewed", "ready")], currentProjectId: repoId });
    expect(container.querySelector(".session-row")?.getAttribute("aria-label")).toContain("1 check failed");
  });

  it("keeps Add project, Usage, and Settings on the strip, without Help", async () => {
    const onOpenSettings = vi.fn();
    const container = await mount("rail", { onOpenSettings });
    await act(async () => button(container, "Settings").click());
    expect(onOpenSettings).toHaveBeenCalled();
    expect(button(container, "Add project")).toBeTruthy();
    expect(button(container, "Usage")).toBeTruthy();
    expect(container.querySelector('button[aria-label="Help"]')).toBeNull();
  });

  it("offers the project's menu from a tile with pin, rename, and remove", async () => {
    const container = await mount("rail");
    const tile = button(container, "plain");
    await act(async () => {
      tile.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    });
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
    expect(items).toEqual(expect.arrayContaining(["Pin", "Edit", "New chat", "Remove project"]));
  });
});
