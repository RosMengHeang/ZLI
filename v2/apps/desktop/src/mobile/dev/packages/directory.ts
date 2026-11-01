import { ReactNativeDirectoryCheck, ReactNativeDirectoryLibrary } from "@zli-v2/contracts";

import type { MobileDevHost } from "../host.js";

export const DIRECTORY_BASE = "https://reactnative.directory/api";
export const DIRECTORY_TIMEOUT_MS = 5_000;
const CACHE_MS = 60 * 60 * 1_000;
/** Detail lookups are one request per name, so only the first few get them. */
const DETAIL_LIMIT = 5;

export type NewArchitecture = "supported" | "unsupported" | "untested" | "new-arch-only";

/** What React Native Directory says about one package. found is false when the directory does not list it. */
export type DirectoryEntry = {
  found: boolean;
  newArchitecture?: NewArchitecture;
  unmaintained?: boolean;
  expoGo?: boolean;
  configPlugin?: boolean;
  archived?: boolean;
  latest?: string;
};

/** The package name without an @version suffix: @scope/name@1.2.3 becomes @scope/name. */
export function baseName(name: string): string {
  const at = name.indexOf("@", name.startsWith("@") ? 1 : 0);
  return at === -1 ? name : name.slice(0, at);
}

function newArch(value: string | boolean | undefined): NewArchitecture | undefined {
  if (value === true || value === "supported") return "supported";
  if (value === false || value === "unsupported") return "unsupported";
  if (value === "untested" || value === "new-arch-only") return value;
  return undefined;
}

/**
 * React Native Directory lookups through host.fetch, cached for an hour per name. A name maps to undefined when the
 * directory could not be reached, so the caller reports it as not checked rather than blocking on missing data.
 */
export function createDirectory(host: MobileDevHost) {
  const cache = new Map<string, { at: number; entry: DirectoryEntry }>();

  const getJson = async (url: string): Promise<unknown> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("React Native Directory did not answer in time."));
      }, DIRECTORY_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([host.fetch(url, { signal: controller.signal }), timeout]);
      if (!response.ok) throw new Error(`React Native Directory answered ${response.status}.`);
      return JSON.parse(await Promise.race([response.text(), timeout]));
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const details = async (name: string): Promise<ReactNativeDirectoryLibrary | undefined> => {
    try {
      const body = await getJson(`${DIRECTORY_BASE}/library?name=${encodeURIComponent(name)}`);
      const keyed = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined;
      const parsed = ReactNativeDirectoryLibrary.safeParse(keyed ?? body);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    async lookup(names: readonly string[]): Promise<Map<string, DirectoryEntry | undefined>> {
      const now = host.now().getTime();
      const result = new Map<string, DirectoryEntry | undefined>();
      const wanted = [...new Set(names.map(baseName))];
      const missing = wanted.filter((name) => {
        const cached = cache.get(name);
        if (cached && now - cached.at < CACHE_MS) {
          result.set(name, cached.entry);
          return false;
        }
        return true;
      });
      if (missing.length === 0) return result;
      let checked: ReactNativeDirectoryCheck;
      try {
        const parsed = ReactNativeDirectoryCheck.safeParse(
          await getJson(`${DIRECTORY_BASE}/libraries/check?packages=${missing.map(encodeURIComponent).join(",")}`),
        );
        if (!parsed.success) throw new Error("React Native Directory sent an answer ZLI does not understand.");
        checked = parsed.data;
      } catch {
        for (const name of missing) result.set(name, undefined);
        return result;
      }
      const found = missing.filter((name) => checked[name]);
      const extra = new Map(
        await Promise.all(found.slice(0, DETAIL_LIMIT).map(async (name) => [name, await details(name)] as const)),
      );
      for (const name of missing) {
        const base = checked[name];
        const more = extra.get(name);
        const arch = newArch(base?.newArchitecture ?? more?.newArchitecture);
        const configPlugin = more?.github?.configPlugin;
        const entry: DirectoryEntry = base
          ? {
              found: true,
              ...(arch ? { newArchitecture: arch } : {}),
              ...(base.unmaintained || more?.unmaintained ? { unmaintained: true } : {}),
              ...(more?.expoGo !== undefined ? { expoGo: more.expoGo } : {}),
              ...(configPlugin !== undefined ? { configPlugin: Boolean(configPlugin) } : {}),
              ...(more?.github?.isArchived ? { archived: true } : {}),
              ...(more?.npm?.latestRelease ? { latest: more.npm.latestRelease } : {}),
            }
          : { found: false };
        cache.set(name, { at: now, entry });
        result.set(name, entry);
      }
      return result;
    },
  };
}
