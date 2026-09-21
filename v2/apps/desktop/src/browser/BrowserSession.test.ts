import { describe, expect, it } from "vitest";

import { BrowserSessionManager } from "./BrowserSession.js";

function createSession() {
  return {
    setPermissionRequestHandler: (handler: unknown) => { (createSession as { request?: unknown }).request = handler; },
    setPermissionCheckHandler: (handler: unknown) => { (createSession as { check?: unknown }).check = handler; },
    clearStorageData: async () => undefined,
    clearCache: async () => undefined,
  };
}

describe("BrowserSessionManager", () => {
  it("derives deterministic, isolated persistent Chromium partitions", () => {
    const manager = new BrowserSessionManager();
    const first = manager.partitionFor("worktree-a", "profile-default");
    expect(first).toMatch(/^persist:zli-v2-[a-f0-9]{20}$/u);
    expect(manager.partitionFor("worktree-a", "profile-default")).toBe(first);
    expect(manager.partitionFor("worktree-b", "profile-default")).not.toBe(first);
    expect(manager.partitionFor("worktree-a", "profile-auth")).not.toBe(first);
  });

  it("memoizes sessions and installs deny-by-default permission handlers", () => {
    const created: string[] = [];
    const sessionModule = {
      fromPartition: (partition: string) => {
        created.push(partition);
        return createSession();
      },
    };
    const manager = new BrowserSessionManager();
    const first = manager.getSession(sessionModule, "worktree-a", "profile-default");
    const second = manager.getSession(sessionModule, "worktree-a", "profile-default");
    expect(first).toBe(second);
    expect(created).toHaveLength(1);
  });
});
