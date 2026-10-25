// @vitest-environment jsdom

import { CommandId, EnvironmentId, ProjectId, type RuntimeProjection, WorktreeId } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { MergePullRequestDialog } from "./MergePullRequestDialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const worktree = {
  worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000101"),
  projectId: ProjectId.parse("00000000-0000-4000-8000-000000000010"),
  path: "C:/app",
  branch: "feature",
  status: "ready" as const,
  kind: "checkout" as const,
};
const pullRequest = { number: 7, url: "https://github.com/acme/app/pull/7", state: "OPEN" as const, isDraft: false };
const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  localStorage.clear();
});

async function render(onMerged: (result: unknown) => void) {
  const commands: Record<string, unknown>[] = [];
  const projection = {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [],
    worktrees: [worktree],
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
  } as unknown as RuntimeProjection;
  const bridge = {
    runtime: {
      dispatch: async (request: { command: Record<string, unknown> }) => {
        commands.push(request.command);
        return {
          commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"),
          accepted: true,
          result: { pullRequest: { ...pullRequest, state: "MERGED" }, branchDeleted: false },
        };
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
        <MergePullRequestDialog
          worktree={worktree}
          pullRequest={pullRequest}
          onClose={() => undefined}
          onMerged={onMerged}
        />
      </RuntimeProvider>,
    );
  });
  return commands;
}

const button = (text: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === text);

describe("MergePullRequestDialog", () => {
  it("squash merges by default and deletes the branch on origin", async () => {
    const onMerged = vi.fn();
    const commands = await render(onMerged);
    await act(async () => button("Squash and merge")?.click());

    expect(commands.at(-1)).toMatchObject({ type: "review.pr.merge", method: "squash", deleteBranch: true });
    expect(onMerged).toHaveBeenCalledWith({ pullRequest: { ...pullRequest, state: "MERGED" }, branchDeleted: false });
  });

  it("uses the picked method, keeps the branch when asked, and remembers the method", async () => {
    const commands = await render(() => undefined);
    await act(async () => button("Rebase")?.click());
    await act(async () => document.querySelector<HTMLInputElement>('input[role="switch"]')?.click());
    await act(async () => button("Rebase and merge")?.click());

    expect(commands.at(-1)).toMatchObject({ method: "rebase", deleteBranch: false });
    expect(localStorage.getItem("zli.review.mergeMethod")).toBe("rebase");
  });
});
