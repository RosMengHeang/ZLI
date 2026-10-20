// @vitest-environment jsdom

import {
  CommandId,
  EnvironmentId,
  ProjectId,
  type RpcResponse,
  type RuntimeProjection,
  WorktreeId,
} from "@zli-v2/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { FileIndexProvider, useFileIndexContext } from "./FileIndex.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000011");
const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000010");

const projection: RuntimeProjection = {
  environment: {
    environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
    label: "Local",
    protocolVersion: 1,
    capabilities: {},
  },
  projects: [{ projectId, path: "C:/repo", name: "repo" }],
  worktrees: [{ worktreeId, projectId, path: "C:/repo", branch: "main", status: "ready" }],
  threads: [],
  terminals: [],
  browserTabs: [],
  attention: [],
  lastSequence: 1,
};

type Listing = { files: { path: string; status?: string }[]; truncated: boolean };

describe("FileIndexProvider", () => {
  it("loads again after a save when a list started before the save is still running", async () => {
    const lists: Array<(listing: Listing) => void> = [];
    const bridge = {
      runtime: {
        getProjection: async () => projection,
        onProjection: () => () => undefined,
        dispatch: (request: { command: { type: string } }) =>
          new Promise<RpcResponse>((resolve) => {
            if (request.command.type !== "files.list") throw new Error(`Unexpected ${request.command.type}`);
            lists.push((result) =>
              resolve({ commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"), accepted: true, result }),
            );
          }),
      },
    } as unknown as ZliBridge;
    let context: ReturnType<typeof useFileIndexContext>;
    function Probe() {
      context = useFileIndexContext();
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(
        <RuntimeProvider bridge={bridge}>
          <FileIndexProvider onOpenFile={() => undefined}>
            <Probe />
          </FileIndexProvider>
        </RuntimeProvider>,
      );
    });
    await vi.waitFor(() => expect(context?.rootsKey).toContain(worktreeId));

    const background = context?.refresh(worktreeId, 15_000);
    const afterSave = context?.refresh(worktreeId, 0);
    const alsoAfterSave = context?.refresh(worktreeId, 0);
    expect(alsoAfterSave).toBe(afterSave);
    expect(lists).toHaveLength(1);

    await act(async () => {
      lists[0]?.({ files: [{ path: "README.md" }], truncated: false });
      await background;
    });
    await vi.waitFor(() => expect(lists).toHaveLength(2));
    await act(async () => {
      lists[1]?.({ files: [{ path: "README.md", status: "modified" }], truncated: false });
    });
    const index = await afterSave;
    expect(index?.entries).toEqual([{ path: "README.md", status: "modified" }]);
    expect(context?.indexes.get(worktreeId)?.entries[0]?.status).toBe("modified");
    expect(lists).toHaveLength(2);
    await act(async () => root.unmount());
  });
});
