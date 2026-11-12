// @vitest-environment jsdom

import { CommandId, type ProjectProjection, type WorktreeProjection } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

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
            : {},
      }),
      getProjection: async () => undefined,
      onProjection: () => () => undefined,
    },
    app: { getVersion: async () => "0", quit: async () => undefined },
  } as unknown as ZliBridge;
}

async function render(onMove?: (place: ChatPlace) => Promise<string | undefined>) {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <RuntimeProvider bridge={bridge()}>
        <WorkspaceBar
          project={projects[0]}
          projects={projects}
          worktree={worktrees[0] as WorktreeProjection}
          worktrees={worktrees}
          git
          onMove={onMove}
        />
      </RuntimeProvider>,
    );
  });
  return container;
}

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

  it("only says where the agent works once the chat has started", async () => {
    const container = await render(undefined);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toContain("api");
    expect(container.textContent).toContain("Local");
    expect(container.textContent).toContain("main");
  });
});
