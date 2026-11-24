import type { AccountSignIn } from "@zli-v2/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { backgroundSignInStatus, cancelBackgroundSignIn, startBackgroundSignIn } from "../accounts/accounts.js";
import { reloadPlanLimits } from "../limits/limits.js";
import { openExternalLink } from "../review/links.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";

const POLL_MS = 1_000;

/**
 * Sign-ins that run in the background, one per account. The agent opens the browser itself; for an agent
 * that only prints its page and a code, ZLI opens the page. Each running one is asked about every second,
 * and a finished one reloads the accounts and plan readings.
 */
export function useBackgroundSignIns(onDone: () => void) {
  const { dispatch, bridge } = useRuntime();
  const [signIns, setSignIns] = useState<Record<string, AccountSignIn>>({});
  const opened = useRef(new Set<string>());
  const done = useRef(onDone);
  done.current = onDone;

  const show = useCallback(
    (next: AccountSignIn) => {
      setSignIns((current) => ({ ...current, [next.accountId]: next }));
      const page = `${next.accountId} ${next.url ?? ""}`;
      if (next.state === "waiting" && !next.opensBrowser && next.url && !opened.current.has(page)) {
        opened.current.add(page);
        void openExternalLink(bridge, next.url);
      }
      if (next.state === "done") {
        void reloadPlanLimits(dispatch);
        done.current();
      }
    },
    [bridge, dispatch],
  );

  const waiting = Object.values(signIns)
    .filter((signIn) => signIn.state === "waiting")
    .map((signIn) => signIn.accountId)
    .join(" ");
  useEffect(() => {
    if (!waiting) return;
    const ids = waiting.split(" ");
    const timer = setInterval(() => {
      for (const id of ids) {
        void backgroundSignInStatus(dispatch, id).then(
          (next) => next && show(next),
          () => undefined,
        );
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, dispatch, show]);

  /** "terminal" when this agent signs in only in a terminal; otherwise a problem, or undefined. */
  const start = useCallback(
    async (accountId: string): Promise<"terminal" | string | undefined> => {
      try {
        const started = await startBackgroundSignIn(dispatch, accountId);
        if (!started) return "terminal";
        show(started);
        return undefined;
      } catch (cause) {
        return cause instanceof Error ? cause.message : "The sign-in did not start.";
      }
    },
    [dispatch, show],
  );

  const cancel = useCallback(
    async (accountId: string) => {
      await cancelBackgroundSignIn(dispatch, accountId).catch(() => undefined);
      setSignIns(({ [accountId]: _gone, ...rest }) => rest);
    },
    [dispatch],
  );

  const reopen = useCallback((url: string) => void openExternalLink(bridge, url), [bridge]);

  return { signIns, start, cancel, reopen };
}
