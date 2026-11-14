// @vitest-environment jsdom

import { CommandId, type ProjectProjection, type WorktreeProjection } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import type { ChatPlace } from "../sessions/launch.js";
import { WorkspaceBar } from "./WorkspaceBar.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

const projectA = "00000000-0000-4000-8000-00000000000a";
const projectB = "00000000-0000-4000-8000-00000000000b";
const checkoutId = "00000000-0000-4000-8000-000000000001";
const worktreeId = "00000000-0000-4000-8000-000000000002";

const projects = [
  { projectId: projectA, name: "api", path: "/code/api" },
  { projectId: projectB, name: "site", path: "/code/site" },
] as ProjectProjection[];
const worktrees = [
  { worktreeId: checkoutId, projectId: projectA, path: "/code/api", branch: "main", status: "ready", kind: "checkout" },
  { worktreeId, projectId: projectA, path: "/code/api-worktrees/fix-auth", branch: "fix/auth", status: "ready" },
] as WorktreeProjection[];

// The folders the agents worked in before. "api" is already a project, so the menu lists it only once.
const pastFolders = [
  { path: "/code/old", name: "old", lastActiveAt: "2026-01-01T00:00:00.000Z", sources: ["codex"] },
  { path: "/code/API/", name: "api", lastActiveAt: "2026-03-01T00:00:00.000Z", sources: ["codex"] },
  { path: "/code/docs", name: "docs", lastActiveAt: "2026-02-01T00:00:00.000Z", sources: ["claude-code"] },
];
let history = pastFolders;

afterEach(() => {
  history = pastFolders;
});

function bridge(): ZliBridge {
  return {
    runtime: {
      dispatch: async (request: { commandId: string; command: { type: string } }) => ({
        commandId: CommandId.parse(request.commandId),
        accepted: true as const,
        result:
          request.command.type === "review.git.branches"
            ? {
                current: "main",
                local: ["main", "fix/auth", "feature/login", "release"],
                remote: ["main", "docs/site"],
                details: { release: { worktreePath: "/elsewhere/release" } },
              }
            : request.command.type === "history.scan"
              ? { folders: history }
              : {},
      }),
      getProjection: async () => undefined,
      onProjection: () => () => undefined,
    },
    app: { getVersion: async () => "0", quit: async () => undefined },
  } as unknown as ZliBridge;
}

async function render(
  onMove?: (place: ChatPlace) => Promise<string | undefined>,
  onAddFolder?: (path?: string) => Promise<string | undefined>,
  only: readonly ProjectProjection[] = projects,
) {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <RuntimeProvider bridge={bridge()}>
        <WorkspaceBar
          project={only[0]}
          projects={only}
          worktree={worktrees[0] as WorktreeProjection}
          worktrees={worktrees}
          git
          onMove={onMove}
          onAddFolder={onAddFolder}
        />
      </RuntimeProvider>,
    );
  });
  return container;
}

const openProjectMenu = (container: HTMLElement) =>
  act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label^="Move this chat to another project"]')?.click(),
  );

const groupLabels = () =>
  [...document.querySelectorAll(".place-menu .picker-group-label")].map((label) => label.textContent);

const press = (key: string) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

const options = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].map((option) => ({
    label: option.querySelector(".picker-option-label")?.textContent,
    disabled: option.getAttribute("aria-disabled") === "true",
    option,
  }));

describe("WorkspaceBar", () => {
  it("moves a chat that has not started to another project", async () => {
    const moves: ChatPlace[] = [];
    const container = await render(async (place) => {
      moves.push(place);
      return undefined;
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label^="Move this chat to another project"]')?.click(),
    );
    expect(options().map((entry) => entry.label)).toEqual(["api", "site"]);
    await act(async () => options()[1]?.option.click());
    expect(moves).toEqual([{ kind: "project", projectId: projectB }]);
  });

  it("lists the project's worktrees, then branches to open in a new worktree", async () => {
    const moves: ChatPlace[] = [];
    const container = await render(async (place) => {
      moves.push(place);
      return undefined;
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label^="Move this chat to another branch"]')?.click(),
    );
    expect(options().map((entry) => [entry.label, entry.disabled])).toEqual([
      ["main", false],
      ["fix/auth", false],
      ["feature/login", false],
      ["release", true],
      ["docs/site", false],
    ]);
    await act(async () => options()[1]?.option.click());
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label^="Move this chat to another branch"]')?.click(),
    );
    await act(async () => options()[2]?.option.click());
    expect(moves).toEqual([
      { kind: "worktree", worktreeId },
      { kind: "branch", projectId: projectA, branch: "feature/login" },
    ]);
  });

  it("lists only the projects the person added, not folders their agents used elsewhere", async () => {
    const container = await render(
      async () => undefined,
      async () => undefined,
      [projects[0] as ProjectProjection],
    );
    await openProjectMenu(container);
    expect(options().map((entry) => entry.label)).toEqual(["api", "Open a folder…"]);
  });

  it("gives every group in the project menu its own key", async () => {
    history = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const container = await render(
        async () => undefined,
        async () => undefined,
      );
      await openProjectMenu(container);
      // The projects and "Open a folder…" are two groups without a heading.
      expect(groupLabels()).toEqual([]);
      expect(options().map((entry) => entry.label)).toEqual(["api", "site", "Open a folder…"]);
      const duplicateKeys = errors.mock.calls.filter((call) => String(call[0]).includes("same key"));
      expect(duplicateKeys).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it("searches the project menu and moves through it with the arrows, Home, and End", async () => {
    const container = await render(
      async () => undefined,
      async () => undefined,
    );
    await openProjectMenu(container);
    const focused = () => document.activeElement?.querySelector(".picker-option-label")?.textContent;
    const search = document.querySelector<HTMLInputElement>('.place-menu input[aria-label="Search projects"]');
    expect(document.activeElement).toBe(search);
    await press("ArrowDown");
    expect(focused()).toBe("api");
    await press("End");
    expect(focused()).toBe("Open a folder…");
    await press("Home");
    expect(focused()).toBe("api");
    await act(async () => {
      if (!search) return;
      search.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "si");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(options().map((entry) => entry.label)).toEqual(["site"]);
    await press("Escape");
    expect(document.querySelector(".place-menu")).toBeNull();
  });

  it("only says where the agent works once the chat has started", async () => {
    // Adding folders is still on offer elsewhere, but this chat's folder is fixed.
    const container = await render(undefined, async () => undefined);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toContain("api");
    expect(container.textContent).toContain("Local");
    expect(container.textContent).toContain("main");
  });
});
