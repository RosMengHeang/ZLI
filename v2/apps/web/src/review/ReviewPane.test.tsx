// @vitest-environment jsdom

import { CommandId, EnvironmentId, ProjectId, type RuntimeProjection, WorktreeId } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { ReviewPane } from "./ReviewPane.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");
const worktree = {
  worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000101"),
  projectId,
  path: "C:/app",
  branch: "HEAD",
  status: "ready" as const,
  kind: "checkout" as const,
};
const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

async function render(git: boolean | undefined) {
  const projection = {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
      label: "Local",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [{ projectId, path: "C:/app", name: "app", ...(git === undefined ? {} : { git }) }],
    worktrees: [worktree],
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 1,
  } as RuntimeProjection;
  const bridge = {
    runtime: {
      dispatch: async () => ({ commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"), accepted: true }),
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
  return container;
}

describe("ReviewPane", () => {
  it("explains that changes need Git in a folder without it", async () => {
    const container = await render(false);

    expect(container.textContent).toContain("This folder is not a Git repository");
    expect(container.textContent).not.toContain("Refresh changes");
  });

  it("offers a refresh in a Git repository", async () => {
    const container = await render(undefined);

    expect(container.textContent).toContain("Refresh changes");
  });
});
