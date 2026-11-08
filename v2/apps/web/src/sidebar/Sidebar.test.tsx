// @vitest-environment jsdom

import { EnvironmentId, ProjectId, type RuntimeProjection, WorktreeId } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import type { AgentSession } from "../sessions/sessions.js";
import { type ProjectAgentActions, Sidebar, type WorktreeAction } from "./Sidebar.js";
import { parseSidebarCollapsed } from "./sidebarLayout.js";

const bridge = {
  runtime: {
    dispatch: async () => undefined,
    getProjection: async () => undefined,
    onProjection: () => () => undefined,
  },
} as unknown as ZliBridge;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
});

const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const checkoutId = WorktreeId.parse("00000000-0000-4000-8000-000000000011");
const featureId = WorktreeId.parse("00000000-0000-4000-8000-000000000012");

function projection(worktrees: RuntimeProjection["worktrees"]): RuntimeProjection {
  return {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: {
        worktrees: true,
        terminals: true,
        browser: true,
        eventReplay: true,
      },
    },
    projects: [{ projectId, path: "/work/repo", name: "repo" }],
    worktrees,
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
  };
}

const noop = () => undefined;

type MountOptions = {
  sessions?: AgentSession[];
  onStopSession?: (session: AgentSession) => void;
  onDeleteSession?: (session: AgentSession) => void;
  onRenameSession?: (session: AgentSession) => void;
  onWorktreeAction?: (worktree: { worktreeId: string }, action: WorktreeAction) => void;
  onCreateWorktree?: (project?: { projectId: string }) => void;
  onRemoveProject?: (projectId: string) => Promise<string | undefined>;
  onRenameProject?: (projectId: string, name: string) => void;
  onNewAgent?: (project?: { projectId: string }) => void;
  currentProjectId?: string;
  selectedProjectId?: string;
  projectAgentActions?: (projectId: string) => ProjectAgentActions;
  onOpenSettings?: (section?: string) => void;
};

async function mount(current: RuntimeProjection | undefined, options: MountOptions = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <RuntimeProvider bridge={bridge}>
        <Sidebar
          projection={current}
          sessions={options.sessions ?? []}
          activeSessionId={undefined}
          backgroundSessionIds={new Set()}
          activeWorktreeId={undefined}
          currentProjectId={options.currentProjectId}
          selectedProjectId={options.selectedProjectId}
          onSelectSession={noop}
          onStopSession={options.onStopSession ?? noop}
          onDeleteSession={options.onDeleteSession ?? noop}
          onRenameSession={options.onRenameSession}
          onSelectWorktree={noop}
          onNewAgent={options.onNewAgent ?? noop}
          onOpenProject={noop}
          onCreateWorktree={options.onCreateWorktree ?? noop}
          onRemoveProject={options.onRemoveProject ?? (async () => undefined)}
          onRenameProject={options.onRenameProject ?? noop}
          onWorktreeAction={options.onWorktreeAction ?? noop}
          onReviewSetup={noop}
          onShowSetupOutput={noop}
          onOpenHelp={noop}
          onOpenSettings={options.onOpenSettings ?? noop}
          onOpenUsage={noop}
          onHideSidebar={noop}
          projectAgentActions={options.projectAgentActions}
        />
      </RuntimeProvider>,
    );
  });
  return { container, unmount: () => act(async () => root.unmount()) };
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

/** Opens a row's "..." menu and returns its item labels; the menu renders in a portal on the body. */
async function openMenu(root: ParentNode, label: string): Promise<string[]> {
  await act(async () => button(root, label).click());
  return [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent ?? "");
}

const has = (root: ParentNode, label: string) => {
  try {
    button(root, label);
    return true;
  } catch {
    return false;
  }
};

const agent = (worktreeId: string): AgentSession => ({
  sessionId: "session-1",
  worktreeId,
  provider: "claude",
  status: "working",
  mode: "terminal",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
});

const addProjectButtons = (root: ParentNode) =>
  [...root.querySelectorAll("button")].filter(
    (entry) => entry.textContent?.trim() === "Add project" || entry.getAttribute("aria-label") === "Add project",
  );

const primaryLabels = (root: ParentNode) =>
  [...root.querySelectorAll(".sidebar-primary > button")].map((entry) =>
    entry.textContent?.replace(/Ctrl.*$/u, "").trim(),
  );

describe("Sidebar primary actions", () => {
  it("shows Add project above New agent, once, with New agent as the one raised button", async () => {
    const { container } = await mount(projection([]));
    expect(primaryLabels(container)).toEqual(["Add project", "New agent"]);
    expect(addProjectButtons(container)).toHaveLength(1);
    const newAgent = container.querySelector<HTMLButtonElement>(".sidebar-new-agent");
    expect(newAgent?.classList.contains("btn-secondary")).toBe(true);
    expect(newAgent?.disabled).toBe(false);
    expect(container.querySelector(".sidebar-heading")?.textContent).toBe("Projects");
  });

  it("keeps Add project at the top of an empty sidebar and New agent off until a project exists", async () => {
    const { container } = await mount({ ...projection([]), projects: [] });
    expect(primaryLabels(container)).toEqual(["Add project", "New agent"]);
    expect(addProjectButtons(container)).toHaveLength(1);
    expect(container.querySelector(".sidebar-heading")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".sidebar-new-agent")?.disabled).toBe(true);
  });
});

describe("Sidebar next step in an empty project", () => {
  const checkout: RuntimeProjection["worktrees"][number] = {
    worktreeId: checkoutId,
    projectId,
    path: "/work/repo",
    branch: "main",
    status: "ready",
    kind: "checkout",
  };
  const newAgentButton = (root: ParentNode) => root.querySelector('[aria-label="New agent in repo"]');

  it("offers Start one in a project with no agents, and keeps its New agent button in view", async () => {
    const onNewAgent = vi.fn();
    const { container } = await mount(projection([checkout]), { onNewAgent });
    expect(container.querySelector(".sidebar-project .sidebar-note")?.textContent).toBe("No agents yet. Start one");
    const startOne = button(container, "Start an agent in repo");
    expect(startOne.textContent).toBe("Start one");
    expect(startOne.type).toBe("button");
    await act(async () => startOne.click());
    expect(onNewAgent).toHaveBeenCalledWith(expect.objectContaining({ projectId }));
    expect(newAgentButton(container)?.classList.contains("is-shown")).toBe(true);
    expect(newAgentButton(container)?.getAttribute("data-tooltip")).toBe("New agent here");
  });

  it("shows no hint once the project has an agent, and New agent stays in view only while it is current", async () => {
    const sessions = [agent(checkoutId)];
    const other = await mount(projection([checkout]), { sessions });
    expect(other.container.textContent).not.toContain("No agents yet.");
    expect(has(other.container, "Start an agent in repo")).toBe(false);
    expect(newAgentButton(other.container)?.classList.contains("is-shown")).toBe(false);
    await other.unmount();
    document.body.replaceChildren();

    const current = await mount(projection([checkout]), { sessions, currentProjectId: projectId });
    expect(newAgentButton(current.container)?.classList.contains("is-shown")).toBe(true);
  });

  it("opens a folded project when it is the one just added", async () => {
    window.localStorage.setItem("zli.sidebar.collapsed", JSON.stringify({ projects: [projectId] }));
    const { container } = await mount(projection([checkout]), { selectedProjectId: projectId });
    expect(button(container, "repo, collapse").getAttribute("aria-expanded")).toBe("true");
    expect(has(container, "Start an agent in repo")).toBe(true);
    expect(parseSidebarCollapsed(window.localStorage.getItem("zli.sidebar.collapsed")).projects).toEqual([]);
  });
});

describe("Sidebar projects", () => {
  it("folds a project and remembers it after a restart", async () => {
    const current = projection([
      {
        worktreeId: checkoutId,
        projectId,
        path: "/work/repo",
        branch: "main",
        status: "ready",
        kind: "checkout",
      },
    ]);
    const first = await mount(current);
    const toggle = button(first.container, "repo, collapse");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(first.container.textContent).toContain("No agents yet.");
    expect(first.container.querySelector(".worktree-heading")).not.toBeNull();

    await act(async () => toggle.click());
    expect(button(first.container, "repo, expand").getAttribute("aria-expanded")).toBe("false");
    expect(first.container.textContent).not.toContain("No agents yet.");
    expect(first.container.querySelector(".worktree-heading")).toBeNull();
    expect(first.container.querySelector(".project-summary")).toBeNull();
    await first.unmount();

    const again = await mount(current);
    expect(again.container.querySelector(".worktree-heading")).toBeNull();
    await act(async () => button(again.container, "repo, expand").click());
    expect(again.container.querySelector(".worktree-heading")).not.toBeNull();
    expect(parseSidebarCollapsed(window.localStorage.getItem("zli.sidebar.collapsed")).projects).toEqual([]);
  });

  it("folds worktrees without agents into one row and remembers when it is opened", async () => {
    const current = projection([
      {
        worktreeId: checkoutId,
        projectId,
        path: "/work/repo",
        branch: "main",
        status: "ready",
        kind: "checkout",
      },
      {
        worktreeId: featureId,
        projectId,
        path: "/work/repo-feat",
        branch: "feat",
        status: "ready",
      },
    ]);
    const first = await mount(current);
    const toggle = first.container.querySelector<HTMLButtonElement>(".worktree-toggle");
    expect(toggle?.textContent).toBe("2 worktrees without agents");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(first.container.querySelector(".worktree-list")).toBeNull();

    await act(async () => toggle?.click());
    expect(first.container.querySelectorAll(".worktree-row")).toHaveLength(2);
    await first.unmount();

    const again = await mount(current);
    expect(again.container.querySelector(".worktree-toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(again.container.querySelectorAll(".worktree-row")).toHaveLength(2);
  });

  it("shows the branch under the agent working on it instead of a worktree row", async () => {
    const { container } = await mount(
      projection([
        {
          worktreeId: checkoutId,
          projectId,
          path: "/work/repo",
          branch: "main",
          status: "ready",
          kind: "checkout",
        },
        {
          worktreeId: featureId,
          projectId,
          path: "/work/repo-feat",
          branch: "feat/login",
          status: "ready",
        },
      ]),
      { sessions: [agent(featureId)] },
    );
    const row = container.querySelector(".session-row");
    expect(row?.classList.contains("has-branch")).toBe(true);
    expect(row?.querySelector(".session-branch .worktree-name")?.textContent).toBe("feat/login");
    expect(row?.querySelector(".session-branch .worktree-status")).toBeNull();
    expect(container.querySelector(".worktree-toggle")?.textContent).toBe("1 worktree without agents");
    expect(container.querySelector(".worktree-row")).toBeNull();
  });

  it("puts the fix for a failed worktree under its agent", async () => {
    const onWorktreeAction = vi.fn<(worktree: { worktreeId: string }, action: WorktreeAction) => void>();
    const { container } = await mount(
      projection([
        {
          worktreeId: featureId,
          projectId,
          path: "/work/repo-feat",
          branch: "feat",
          status: "failed",
          errorMessage: "Branch already exists.",
        },
      ]),
      { sessions: [agent(featureId)], onWorktreeAction },
    );
    const entry = container.querySelector(".session-entry") as HTMLElement;
    expect(entry.querySelector(".session-branch .worktree-status")?.textContent).toBe("Failed");
    expect(entry.textContent).toContain("Branch already exists.");
    await act(async () => button(entry, "Retry").click());
    expect(onWorktreeAction).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: featureId }), "retry");
    expect(container.querySelector(".worktree-row")).toBeNull();
  });

  it("creates a worktree from the project row", async () => {
    const onCreateWorktree = vi.fn();
    const { container } = await mount(projection([]), { onCreateWorktree });
    await act(async () => button(container, "Create worktree").click());
    expect(onCreateWorktree).toHaveBeenCalledWith(expect.objectContaining({ projectId }));
  });

  it("keeps an agent's stop and delete in its ... menu", async () => {
    const onStopSession = vi.fn();
    const onDeleteSession = vi.fn();
    const session: AgentSession = {
      ...agent(featureId),
      terminal: {
        terminalId: "terminal-1",
        worktreeId: featureId,
        title: "Codex",
        status: "running",
      } as unknown as NonNullable<AgentSession["terminal"]>,
    };
    const { container } = await mount(
      projection([
        {
          worktreeId: featureId,
          projectId,
          path: "/work/repo-feat",
          branch: "feat",
          status: "ready",
        },
      ]),
      { sessions: [session], onStopSession, onDeleteSession },
    );
    expect(container.querySelector(".session-entry [data-tooltip='Stop agent']")).toBeNull();
    const menuButton = container.querySelector<HTMLButtonElement>(".session-entry .row-more button");
    expect(menuButton?.getAttribute("aria-haspopup")).toBe("menu");
    await act(async () => menuButton?.click());
    const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent);
    expect(items).toContain("Delete agent");
    await act(async () => button(document.body, "Delete agent").click());
    expect(onDeleteSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1" }));
  });

  it("shows an agent's name and renames it from the ... menu", async () => {
    const onRenameSession = vi.fn();
    const session: AgentSession = {
      ...agent(featureId),
      terminal: {
        terminalId: "terminal-1",
        worktreeId: featureId,
        title: "Codex",
        status: "running",
        name: "Bob",
      } as unknown as NonNullable<AgentSession["terminal"]>,
    };
    const { container } = await mount(
      projection([{ worktreeId: featureId, projectId, path: "/work/repo-feat", branch: "feat", status: "ready" }]),
      { sessions: [session], onRenameSession },
    );
    expect(container.querySelector(".session-name")?.textContent).toBe("Bob");
    expect(container.querySelector(".session-row")?.getAttribute("aria-label")).toMatch(/^Bob, /u);
    const items = await openMenu(container, "Agent actions");
    expect(items[0]).toBe("Rename agent");
    await act(async () => button(document.body, "Rename agent").click());
    expect(onRenameSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1" }));
  });

  it("lists a sub-agent under the agent that started it", async () => {
    const lead: AgentSession = {
      ...agent(featureId),
      mode: "chat",
      thread: { threadId: "thread-lead", worktreeId: featureId, name: "Lead" } as unknown as NonNullable<
        AgentSession["thread"]
      >,
    };
    const helper: AgentSession = {
      ...agent(checkoutId),
      sessionId: "session-2",
      createdAt: "2025-01-02T00:00:00.000Z",
      terminal: {
        terminalId: "terminal-helper",
        worktreeId: checkoutId,
        title: "Codex",
        status: "running",
        name: "Helper",
        startedBy: "thread-lead",
      } as unknown as NonNullable<AgentSession["terminal"]>,
    };
    const { container } = await mount(
      projection([
        { worktreeId: checkoutId, projectId, path: "/work/repo", branch: "main", status: "ready", kind: "checkout" },
        { worktreeId: featureId, projectId, path: "/work/repo-feat", branch: "feat", status: "ready" },
      ]),
      { sessions: [helper, lead] },
    );
    const top = [...container.querySelectorAll(".sidebar-project > .session-list > .session-entry > .session-row")];
    expect(top.map((row) => row.querySelector(".session-name")?.textContent)).toEqual(["Lead"]);
    const nested = container.querySelector('[aria-label="Sub-agents of Lead"]');
    expect(nested?.querySelector(".session-name")?.textContent).toBe("Helper");
    expect(nested?.querySelector(".session-row")?.getAttribute("title")).toMatch(/Started by Lead$/u);
  });

  it("lets a stuck checkout be removed, but only cancels a worktree still being created", async () => {
    const onWorktreeAction = vi.fn<(worktree: { worktreeId: string }, action: WorktreeAction) => void>();
    const { container } = await mount(
      projection([
        {
          worktreeId: checkoutId,
          projectId,
          path: "/work/repo",
          branch: "HEAD",
          status: "queued",
          kind: "checkout",
        },
        {
          worktreeId: featureId,
          projectId,
          path: "/work/repo-feat",
          branch: "feat",
          status: "creating",
        },
      ]),
      { onWorktreeAction },
    );
    const [checkoutRow, featureRow] = [...container.querySelectorAll<HTMLElement>(".worktree-entry")] as [
      HTMLElement,
      HTMLElement,
    ];
    expect(await openMenu(featureRow, "Worktree actions")).toEqual(["Cancel"]);
    await act(async () => button(featureRow, "Worktree actions").click());
    expect(await openMenu(checkoutRow, "Worktree actions")).toEqual(["Cancel", "Forget checkout"]);
    await act(async () => button(document.body, "Forget checkout").click());
    await act(async () => button(checkoutRow, "Forget checkout").click());
    expect(onWorktreeAction).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: checkoutId }), "remove");
  });

  it("names a worktree delete as a worktree, not a checkout", async () => {
    const { container } = await mount(
      projection([
        {
          worktreeId: featureId,
          projectId,
          path: "/work/repo-feat",
          branch: "feat",
          status: "ready",
        },
      ]),
    );
    await act(async () => container.querySelector<HTMLButtonElement>(".worktree-toggle")?.click());
    expect(await openMenu(container, "Worktree actions")).toEqual(["Delete worktree"]);
    await act(async () => button(document.body, "Delete worktree").click());
    expect(has(container, "Delete worktree")).toBe(true);
    expect(has(container, "Keep")).toBe(true);
    expect(has(container, "Forget checkout")).toBe(false);
  });

  const rightClick = async (container: HTMLElement) => {
    const label = container.querySelector<HTMLElement>(".project-label");
    await act(async () => {
      label?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    return [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent);
  };

  it("offers pin and edit on right-click, but not in the ... menu", async () => {
    const { container } = await mount(projection([]));
    expect(await rightClick(container)).toEqual(["Pin", "Edit", "New agent", "New worktree", "Remove project"]);
    await act(async () => document.body.dispatchEvent(new Event("pointerdown")));
    await act(async () => button(container, "repo actions").click());
    expect([...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent)).toEqual([
      "New agent",
      "New worktree",
      "Remove project",
    ]);
  });

  it("pins a project and remembers it", async () => {
    const { container } = await mount(projection([]));
    await rightClick(container);
    await act(async () => button(document.body, "Pin").click());
    expect(container.querySelector(".project-pin")).not.toBeNull();
    expect(parseSidebarCollapsed(window.localStorage.getItem("zli.sidebar.collapsed")).pinned).toEqual([projectId]);
    expect(await rightClick(container)).toContain("Unpin");
  });

  it("renames a project from Edit, and Escape keeps the old name", async () => {
    const onRenameProject = vi.fn();
    const { container } = await mount(projection([]), { onRenameProject });
    await rightClick(container);
    await act(async () => button(document.body, "Edit").click());
    const input = container.querySelector<HTMLInputElement>(".project-rename");
    expect(input?.value).toBe("repo");
    await act(async () => {
      if (!input) return;
      input.value = "  Shop  ";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onRenameProject).toHaveBeenCalledWith(projectId, "Shop");
    expect(container.querySelector(".project-rename")).toBeNull();

    await rightClick(container);
    await act(async () => button(document.body, "Edit").click());
    await act(async () => {
      const again = container.querySelector<HTMLInputElement>(".project-rename");
      if (!again) return;
      again.value = "Other";
      again.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onRenameProject).toHaveBeenCalledTimes(1);
  });

  it("offers board actions for the project's agents, and says why one would do nothing", async () => {
    const focus = vi.fn();
    const close = vi.fn();
    const projectAgentActions = vi.fn(() => ({ focus, close }));
    const { container } = await mount(
      projection([{ worktreeId: featureId, projectId, path: "/work/repo-feat", branch: "feat", status: "ready" }]),
      { sessions: [agent(featureId)], projectAgentActions },
    );
    expect(await openMenu(container, "repo actions")).toEqual([
      "New agent",
      "New worktree",
      "Show only this project",
      "Open all agents",
      "Close all agents",
      "Remove project",
    ]);
    expect(projectAgentActions).toHaveBeenCalledWith(projectId);
    const item = (label: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find(
        (entry) => entry.textContent === label,
      );
    expect(item("Open all agents")?.getAttribute("aria-disabled")).toBe("true");
    expect(item("Open all agents")?.title).toBe("All agents here are open.");
    expect(item("Close all agents")?.getAttribute("aria-disabled")).toBeNull();
    expect(item("Close all agents")?.title).toBe("Hide their tiles. The agents keep running.");
    await act(async () => item("Close all agents")?.click());
    expect(close).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();

    expect(await rightClick(container)).toContain("Show only this project");
    await act(async () => item("Show only this project")?.click());
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("turns the board actions off for a project with no agents", async () => {
    const { container } = await mount(projection([]), { projectAgentActions: () => ({}) });
    await openMenu(container, "repo actions");
    const items = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].filter((entry) =>
      ["Show only this project", "Open all agents", "Close all agents"].includes(entry.textContent ?? ""),
    );
    expect(items).toHaveLength(3);
    for (const entry of items) {
      expect(entry.getAttribute("aria-disabled")).toBe("true");
      expect(entry.title).toBe("This project has no agents yet.");
    }
  });

  it("removes a project only after the confirm under its row", async () => {
    const onRemoveProject = vi.fn(async () => undefined);
    const { container } = await mount(projection([]), { onRemoveProject });
    await act(async () => button(container, "repo actions").click());
    await act(async () => button(document.body, "Remove project").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Remove repo from ZLI?");
    expect(onRemoveProject).not.toHaveBeenCalled();
    await act(async () => button(document.body, "Remove").click());
    expect(onRemoveProject).toHaveBeenCalledWith(projectId);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps the confirm open and says why the project could not be removed", async () => {
    const onRemoveProject = vi.fn(async () => "The runtime is not connected.");
    const { container } = await mount(projection([]), { onRemoveProject });
    await act(async () => button(container, "repo actions").click());
    await act(async () => button(document.body, "Remove project").click());
    await act(async () => button(document.body, "Remove").click());
    expect(document.querySelector(".project-confirm-problem")?.textContent).toBe("The runtime is not connected.");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
describe("parseSidebarCollapsed", () => {
  it("keeps only string ids and survives bad storage", () => {
    expect(parseSidebarCollapsed('{"projects":["a",1],"idle":"b"}')).toEqual({
      projects: ["a"],
      idle: [],
      pinned: [],
    });
    expect(parseSidebarCollapsed("not json")).toEqual({
      projects: [],
      idle: [],
      pinned: [],
    });
    expect(parseSidebarCollapsed(null)).toEqual({
      projects: [],
      idle: [],
      pinned: [],
    });
  });
});

describe("Sidebar footer", () => {
  it("names Settings beside the icons while plan limits are off", async () => {
    const onOpenSettings = vi.fn();
    const { container } = await mount(projection([]), { onOpenSettings });
    const footer = container.querySelector(".sidebar-footer");
    if (!footer) throw new Error("No footer");
    const settings = [...footer.querySelectorAll("button")].filter(
      (entry) => entry.textContent?.trim() === "Settings" || entry.getAttribute("aria-label") === "Settings",
    );
    expect(settings).toHaveLength(1);
    expect(settings[0]?.textContent?.trim()).toBe("Settings");
    await act(async () => settings[0]?.click());
    expect(onOpenSettings).toHaveBeenCalledWith();
    expect(footer.querySelector('[role="status"]')?.textContent).toBe("Runtime connected");
    expect(footer.textContent).not.toContain("Local runtime");
  });

  it("says it is waiting until the runtime connects", async () => {
    const { container } = await mount(undefined);
    const footer = container.querySelector(".sidebar-footer");
    expect(footer?.querySelector(".sidebar-waiting")?.textContent).toBe("Waiting for runtime");
    expect(footer?.querySelector('[role="status"]')?.textContent).toBe("");
    expect(has(footer as ParentNode, "Settings")).toBe(true);
  });
});
