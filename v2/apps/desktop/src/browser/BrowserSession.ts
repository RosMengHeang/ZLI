import { createHash } from "node:crypto";

import { isPermissionAllowed } from "../security/NavigationPolicy.js";

export type BrowserSessionLike = {
  setPermissionRequestHandler(
    handler: (webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void,
  ): void;
  setPermissionCheckHandler(handler: (webContents: unknown, permission: string) => boolean): void;
  clearStorageData(options?: unknown): Promise<void>;
  clearCache(): Promise<void>;
  cookies?: {
    get(filter: Record<string, unknown>): Promise<readonly BrowserCookie[]>;
    remove(url: string, name: string): Promise<void>;
  };
};

export type BrowserCookie = { name: string; domain?: string; path?: string; secure?: boolean };

/** The site a cookie belongs to: its domain without the leading dot or www, kept to its last two labels. */
export function siteOf(domain: string): string {
  const host = domain
    .replace(/^\.+/u, "")
    .replace(/^www\./u, "")
    .toLowerCase();
  const labels = host.split(".");
  // Two-letter country codes under a short second level (co.uk, com.au) keep a third label.
  const keep = labels.length > 2 && (labels.at(-1)?.length ?? 0) === 2 && (labels.at(-2)?.length ?? 0) <= 3 ? 3 : 2;
  return labels.slice(-keep).join(".");
}

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

  /** The sites that keep cookies in a profile, the ones with the most first. */
  async sites(
    module: BrowserSessionModule,
    worktreeId: string,
    profileId: string,
  ): Promise<{ site: string; cookies: number }[]> {
    const browserSession = this.getSession(module, worktreeId, profileId);
    const cookies = (await browserSession.cookies?.get({})) ?? [];
    const counts = new Map<string, number>();
    for (const cookie of cookies) {
      if (!cookie.domain) continue;
      const site = siteOf(cookie.domain);
      counts.set(site, (counts.get(site) ?? 0) + 1);
    }
    return [...counts]
      .map(([site, count]) => ({ site, cookies: count }))
      .sort((left, right) => right.cookies - left.cookies || left.site.localeCompare(right.site));
  }

  /** Signs a profile out of one site, by removing that site's cookies and storage, or out of every site. */
  async forgetSite(module: BrowserSessionModule, worktreeId: string, profileId: string, site?: string): Promise<void> {
    const browserSession = this.getSession(module, worktreeId, profileId);
    if (!site) {
      await browserSession.clearStorageData({ storages: ["cookies", "localstorage", "indexdb", "serviceworkers"] });
      return;
    }
    const wanted = siteOf(site);
    for (const cookie of (await browserSession.cookies?.get({})) ?? []) {
      if (!cookie.domain || siteOf(cookie.domain) !== wanted) continue;
      const host = cookie.domain.replace(/^\.+/u, "");
      await browserSession.cookies?.remove(
        `${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`,
        cookie.name,
      );
    }
    for (const origin of [`https://${wanted}`, `https://www.${wanted}`])
      await browserSession
        .clearStorageData({ origin, storages: ["localstorage", "indexdb", "serviceworkers"] })
        .catch(() => undefined);
  }

  async clearProfile(worktreeId: string, profileId: string): Promise<void> {
    const partition = this.partitionFor(worktreeId, profileId);
    const browserSession = this.sessions.get(partition);
    if (!browserSession) return;
    await browserSession.clearStorageData({ storages: ["cookies", "localstorage", "indexdb", "serviceworkers"] });
    await browserSession.clearCache();
  }
}
