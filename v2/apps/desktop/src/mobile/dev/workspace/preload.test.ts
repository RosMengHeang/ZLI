import { describe, expect, it } from "vitest";

import { createWorkspaceApi } from "./preload.js";

const workspace = {
  worktreeId: "wt-1",
  branch: "feat-cart",
  metroPort: 8142,
  metro: { state: "free" },
  devClient: false,
  openUrl: "exp://localhost:8142",
};

describe("workspace preload API", () => {
  it("sends only the worktree and device, and parses every answer and event", async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const listeners = new Map<string, (event: unknown, value: unknown) => void>();
    const { workspace: api } = createWorkspaceApi({
      invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        if (channel === "zli:mobile:workspace:list") return [workspace];
        if (channel === "zli:mobile:workspace:open") return { opened: workspace.openUrl, mapped8081To: 8142 };
        return channel === "zli:mobile:workspace:get" && (payload as { worktreeId: string }).worktreeId === "bad"
          ? { ...workspace, metroPort: 80 }
          : workspace;
      },
      on: (channel, listener) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    });
    expect(await api.get("wt-1")).toEqual(workspace);
    expect(await api.list()).toEqual([workspace]);
    expect(await api.open("wt-1", "android-avd:Pixel_7")).toEqual({ opened: workspace.openUrl, mapped8081To: 8142 });
    await expect(api.get("bad")).rejects.toThrow();
    await expect(api.open("wt-1", "")).rejects.toThrow();
    expect(calls).toEqual([
      { channel: "zli:mobile:workspace:get", payload: { worktreeId: "wt-1" } },
      { channel: "zli:mobile:workspace:list", payload: undefined },
      { channel: "zli:mobile:workspace:open", payload: { worktreeId: "wt-1", deviceId: "android-avd:Pixel_7" } },
      { channel: "zli:mobile:workspace:get", payload: { worktreeId: "bad" } },
    ]);
    const seen: unknown[] = [];
    api.onChange((event) => seen.push(event));
    listeners.get("zli:mobile:workspace:changed")?.({}, { worktreeId: "wt-1" });
    listeners.get("zli:mobile:workspace:changed")?.({}, { worktreeId: 5 });
    expect(seen).toEqual([{ worktreeId: "wt-1" }]);
  });
});
