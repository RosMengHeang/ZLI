import { catalogEntryServer, MCP_CATALOG, type McpListResult } from "@zli-v2/contracts";
import { useCallback, useEffect, useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import { catalogEntryForUrl, listMcpServers } from "./mcpServers.js";

export const EXPIRED_CHECK_MS = 10 * 60 * 1000;

/** A sign-in the server turned down. `connectorId` is the catalog entry it came from, when there is one. */
export type ExpiredSignIn = { name: string; title: string; connectorId?: string };

/** Sign-ins that expired or were revoked, named the way the Connectors gallery names them. */
export function expiredSignIns(result: McpListResult): ExpiredSignIn[] {
  return result.signIns
    .filter((entry) => !entry.signedIn && entry.expired)
    .map((entry) => {
      const server = result.servers.find((candidate) => candidate.name.toLowerCase() === entry.name.toLowerCase());
      const catalog =
        (server ? MCP_CATALOG.find((candidate) => catalogEntryServer(candidate, [server])) : undefined) ??
        catalogEntryForUrl(entry.url);
      return catalog
        ? { name: entry.name, title: catalog.title, connectorId: catalog.id }
        : { name: entry.name, title: entry.name };
    });
}

/** "Your sign-in to Linear expired." for one, and the names joined for more. */
export function expiredSignInMessage(expired: readonly ExpiredSignIn[]): string {
  const titles = expired.map((entry) => entry.title);
  if (titles.length <= 1) return `Your sign-in to ${titles[0] ?? "a connector"} expired.`;
  const last = titles.at(-1);
  const rest = titles.slice(0, -1).join(", ");
  return `Your sign-ins to ${rest}${titles.length > 2 ? "," : ""} and ${last} expired.`;
}

/**
 * Checks sign-ins when ZLI opens, every ten minutes, and when the window gets focus again, such as
 * after signing in in the browser. Dismissed names stay hidden until they recover and expire again.
 */
export function useExpiredSignIns(): { expired: ExpiredSignIn[]; dismiss(name: string): void } {
  const { dispatch, bridge } = useRuntime();
  const [expired, setExpired] = useState<ExpiredSignIn[]>([]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const check = () => {
      listMcpServers(dispatch)
        .then((result) => {
          if (!active) return;
          const next = expiredSignIns(result);
          setExpired(next);
          setDismissed((current) => {
            const kept = new Set([...current].filter((name) => next.some((entry) => entry.name === name)));
            return kept.size === current.size ? current : kept;
          });
        })
        .catch(() => undefined);
    };
    check();
    const timer = setInterval(check, EXPIRED_CHECK_MS);
    window.addEventListener("focus", check);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [dispatch, bridge]);

  const dismiss = useCallback((name: string) => setDismissed((current) => new Set([...current, name])), []);
  return { expired: expired.filter((entry) => !dismissed.has(entry.name)), dismiss };
}
