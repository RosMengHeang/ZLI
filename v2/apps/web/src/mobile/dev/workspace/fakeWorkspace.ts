import type { MobileWorkspace, MobileWorkspaceChanged } from "@zli-v2/contracts";
import { act } from "react";
import { vi } from "vitest";

import type { WorkspaceApi } from "./bridge.js";

/** Test fixtures for the workspace views: one worktree's workspace, and a WorkspaceApi that serves it. */
export const workspace: MobileWorkspace = {
  worktreeId: "wt-1",
  branch: "feat-cart",
  path: "/repo/wt/cart",
  metroPort: 8142,
  emulatorPort: 5560,
  metro: { state: "free" },
  devClient: true,
  scheme: "myapp",
  openUrl: "myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8142",
};

export function fakeWorkspace(initial: MobileWorkspace | MobileWorkspace[]) {
  let current = initial;
  const listeners = new Set<(event: MobileWorkspaceChanged) => void>();
  const api = {
    get: vi.fn(async (worktreeId: string) => {
      const found = (Array.isArray(current) ? current : [current]).find((entry) => entry.worktreeId === worktreeId);
      if (!found) throw new Error(`ZLI does not know the worktree ${worktreeId}.`);
      return found;
    }),
    list: vi.fn(async () => (Array.isArray(current) ? current : [current])),
    open: vi.fn(async (_worktreeId: string, _deviceId: string) => ({ opened: workspace.openUrl, reversedPort: 8142 })),
    onChange: (listener: (event: MobileWorkspaceChanged) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } satisfies WorkspaceApi;
  const change = async (next: MobileWorkspace | MobileWorkspace[], event: MobileWorkspaceChanged = {}) => {
    current = next;
    await act(async () => {
      for (const listener of listeners) listener(event);
    });
  };
  return { api, change };
}
