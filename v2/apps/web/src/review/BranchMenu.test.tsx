// @vitest-environment jsdom

import { CommandId, EnvironmentId, ProjectId, type RuntimeProjection, WorktreeId } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { branchRows } from "./BranchMenu.js";
import { resetPullRequestStoreForTests } from "./pullRequestStore.js";
import { ReviewPane } from "./ReviewPane.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const worktree = {
  worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000101"),
  projectId,
  path: "C:/app",
  branch: "feature",
  status: "ready" as const,
};
const BRANCHES = {
  current: "feature",
  defaultBranch: "main",
  local: ["feature", "main", "held"],
  remote: ["feature", "main", "release"],
  details: {
    feature: { upstream: { name: "origin/feature", ahead: 2, behind: 1 } },
    main: { upstream: { name: "origin/main", ahead: 0, behind: 0 } },
    held: { worktreePath: "C:/app-held" },
  },
};
const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  resetPullRequestStoreForTests();
});

type Command = { type: string } & Record<string, unknown>;

async function render(handle: (command: Command) => unknown = () => undefined) {
  const commands: Command[] = [];
  const projection = {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [{ projectId, path: "C:/app", name: "app" }],
    worktrees: [worktree],
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
  } as unknown as RuntimeProjection;
  const bridge = {
    runtime: {
      dispatch: async (request: { command: Command }) => {
        commands.push(request.command);
        const commandId = CommandId.parse("00000000-0000-4000-8000-000000000099");
        const result = handle(request.command);
        if (result instanceof Error) {
          return {
            commandId,
            accepted: false,
            error: { code: "invalid_request", message: result.message, retryable: false },
          };
        }
        if (result !== undefined) return { commandId, accepted: true, result };
        if (request.command.type === "review.git.branches") return { commandId, accepted: true, result: BRANCHES };
        return { commandId, accepted: true, result: undefined };
      },
      getProjection: async () => projection,
      onProjection: () => () => undefined,
    },
  } as unknown as ZliBridge;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <RuntimeProvider bridge={bridge}>
        <ReviewPane worktree={worktree} />
      </RuntimeProvider>,
    );
  });
  return { container, commands };
}

const button = (text: string) =>
  [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Branches"]');
const filter = () => document.querySelector<HTMLInputElement>('input[aria-label="Find a branch"]');
const activeRow = () => document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');

async function openMenu() {
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Branch feature"]')?.click());
}

async function key(target: HTMLElement | null, name: string) {
  await act(async () => {
    target?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

async function type(input: HTMLInputElement | null, value: string) {
  await act(async () => {
    if (!input) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: Element | null | undefined) {
  await act(async () => (element as HTMLElement | null | undefined)?.click());
}

describe("branch menu", () => {
  it("shows ahead and behind on Pull and Push and opens from the branch in the header", async () => {
    await render();
    const pull = document.querySelector<HTMLButtonElement>('button[aria-label="Pull, 1 to pull"]');
    const push = document.querySelector<HTMLButtonElement>('button[aria-label="Push, 2 to push"]');
    expect(pull?.textContent).toBe("Pull↓1");
    expect(pull?.dataset.tooltip).toContain("1 commit to pull against origin/feature.");
    expect(push?.textContent).toBe("Push↑2");
    expect(push?.dataset.tooltip).toContain("2 commits to push");

    await openMenu();
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(filter());
    const rows = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((row) => row.dataset.branch);
    expect(rows).toEqual(["feature", "main", "held", "origin/release"]);
    const current = document.querySelector('[data-branch="feature"]');
    expect(current?.textContent).toContain("checked out");
    expect(current?.querySelector(".branch-track")?.textContent).toContain("↑2 ↓1");
    expect(document.querySelector('[data-branch="held"]')?.textContent).toContain("In another worktree");
  });

  it("moves with the arrow keys and switches with Enter, then refreshes the pull request status", async () => {
    const { commands, container } = await render((command) =>
      command.type === "review.git.switchBranch" ? { ...BRANCHES, current: "main" } : undefined,
    );
    await openMenu();
    expect(activeRow()?.dataset.branch).toBe("feature");
    expect(button("Switch")?.disabled).toBe(true);
    await key(filter(), "ArrowDown");
    expect(activeRow()?.dataset.branch).toBe("main");
    expect(filter()?.getAttribute("aria-activedescendant")).toBe(activeRow()?.id);
    await key(filter(), "Enter");

    expect(commands.find((command) => command.type === "review.git.switchBranch")).toMatchObject({ name: "main" });
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain("Switched to main.");
    expect(container.querySelector('button[aria-label="Branch main"]')).not.toBeNull();
    expect(commands.at(-1)?.type).toBe("review.pr.status");
  });

  it("checks out a branch only origin has, filtered by name", async () => {
    const { commands } = await render((command) =>
      command.type === "review.git.switchBranch" ? { ...BRANCHES, current: "release" } : undefined,
    );
    await openMenu();
    await type(filter(), "rel");
    expect(activeRow()?.dataset.branch).toBe("origin/release");
    await click(button("Switch"));
    expect(commands.find((command) => command.type === "review.git.switchBranch")).toMatchObject({
      name: "origin/release",
    });
  });

  it("explains why a branch held by another worktree cannot be switched to or deleted", async () => {
    await render();
    await openMenu();
    await type(filter(), "held");
    expect(dialog()?.textContent).toContain("held is checked out in another worktree at C:/app-held.");
    expect(button("Switch")?.disabled).toBe(true);
    expect(button("Delete")?.disabled).toBe(true);
    expect(button("Rename")?.disabled).toBe(true);
  });

  it("creates a branch from the picked start without switching to it", async () => {
    const { commands } = await render((command) =>
      command.type === "review.git.createBranch" ? { ...BRANCHES, local: [...BRANCHES.local, "topic"] } : undefined,
    );
    await openMenu();
    await click(button("New branch"));
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("New branch");
    const name = document.querySelector<HTMLInputElement>('[role="dialog"] input.input');
    expect(document.activeElement).toBe(name);
    await type(name, "topic");
    await click(document.querySelector('button[aria-label^="Start from"]'));
    await click(document.querySelector('[role="option"][data-label="origin/main"]'));
    await click(document.querySelector('input[role="switch"]'));
    await click(button("Create branch"));

    expect(commands.find((command) => command.type === "review.git.createBranch")).toMatchObject({
      name: "topic",
      from: "origin/main",
      switchTo: false,
    });
    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain("Created topic.");
  });

  it("starts a new branch from the current one by sending no start point", async () => {
    const { commands } = await render((command) =>
      command.type === "review.git.createBranch" ? { ...BRANCHES, current: "topic" } : undefined,
    );
    await openMenu();
    await click(button("New branch"));
    await type(document.querySelector<HTMLInputElement>('[role="dialog"] input.input'), "topic");
    await click(button("Create branch"));
    const created = commands.find((command) => command.type === "review.git.createBranch");
    expect(created).toMatchObject({ name: "topic", switchTo: true });
    expect(created).not.toHaveProperty("from");
    expect(dialog()).toBeNull();
  });

  it("renames the current branch and shows an error from Git next to the form", async () => {
    let attempts = 0;
    const { commands } = await render((command) => {
      if (command.type !== "review.git.renameBranch") return undefined;
      attempts += 1;
      return attempts === 1 ? new Error("A branch named main already exists.") : { ...BRANCHES, current: "renamed" };
    });
    await openMenu();
    await click(button("Rename"));
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input.input');
    expect(input?.value).toBe("feature");
    expect(dialog()?.textContent).toContain("origin/feature keeps its old name.");
    await type(input, "main");
    await click(button("Rename branch"));
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
      "A branch named main already exists.",
    );
    await type(input, "renamed");
    await click(button("Rename branch"));
    expect(commands.filter((command) => command.type === "review.git.renameBranch").at(-1)).toMatchObject({
      from: "feature",
      to: "renamed",
    });
    expect(dialog()).toBeNull();
  });

  it("confirms a delete, can include origin, and goes back to the list with Escape", async () => {
    const { commands } = await render((command) =>
      command.type === "review.git.deleteBranch"
        ? { ...BRANCHES, local: ["feature", "held"], remote: ["feature", "release"] }
        : undefined,
    );
    await openMenu();
    expect(button("Delete")?.disabled).toBe(true);
    await key(filter(), "ArrowDown");
    await click(button("Delete"));
    expect(dialog()?.textContent).toContain("Delete main on this computer?");
    await key(document.activeElement as HTMLElement, "Escape");
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Branches");
    expect(document.activeElement).toBe(filter());
    expect(activeRow()?.dataset.branch).toBe("main");

    await click(button("Delete"));
    const switches = [...document.querySelectorAll<HTMLInputElement>('input[role="switch"]')];
    expect(switches.map((item) => item.closest("label")?.textContent)).toEqual([
      expect.stringContaining("Also delete it on origin"),
      expect.stringContaining("Delete unmerged commits"),
    ]);
    await click(switches[0]);
    await click(button("Delete branch"));
    expect(commands.find((command) => command.type === "review.git.deleteBranch")).toMatchObject({
      name: "main",
      force: false,
      remote: true,
    });
    expect(dialog()?.textContent).toContain("Deleted main here and on origin.");
    expect(document.querySelector('[data-branch="main"]')).toBeNull();
  });
});

describe("branchRows", () => {
  it("puts the current branch first and lists origin's branches that have no local copy", () => {
    expect(branchRows({ ...BRANCHES, current: "main" }).map((row) => row.key)).toEqual([
      "main",
      "feature",
      "held",
      "origin/release",
    ]);
    expect(branchRows(BRANCHES, "origin/").map((row) => row.key)).toEqual(["origin/release"]);
  });
});
