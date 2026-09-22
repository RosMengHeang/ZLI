import { createHash } from "node:crypto";

import { isPermissionAllowed } from "../security/NavigationPolicy.js";

export type BrowserSessionLike = {
  setPermissionRequestHandler(
    handler: (webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void,
  ): void;
  setPermissionCheckHandler(handler: (webContents: unknown, permission: string) => boolean): void;
  clearStorageData(options?: unknown): Promise<void>;
  clearCache(): Promise<void>;
};

export type BrowserSessionModule = {
  fromPartition(partition: string): BrowserSessionLike;
};

export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSessionLike>();

  partitionFor(worktreeId: string, profileId: string): string {
    const digest = createHash("sha256").update(`${worktreeId}\0${profileId}`, "utf8").digest("hex").slice(0, 20);
    return `persist:zli-v2-${digest}`;
  }

  getSession(module: BrowserSessionModule, worktreeId: string, profileId: string): BrowserSessionLike {
    const partition = this.partitionFor(worktreeId, profileId);
    const existing = this.sessions.get(partition);
    if (existing) return existing;
    const browserSession = module.fromPartition(partition);
    browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(isPermissionAllowed(permission));
    });
    browserSession.setPermissionCheckHandler((_webContents, permission) => isPermissionAllowed(permission));
    this.sessions.set(partition, browserSession);
    return browserSession;
  }

  async clearProfile(worktreeId: string, profileId: string): Promise<void> {
    const partition = this.partitionFor(worktreeId, profileId);
    const browserSession = this.sessions.get(partition);
    if (!browserSession) return;
    await browserSession.clearStorageData({ storages: ["cookies", "localstorage", "indexdb", "serviceworkers"] });
    await browserSession.clearCache();
  }
}
