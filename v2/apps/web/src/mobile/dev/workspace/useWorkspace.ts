import type { MetroOwner, MobileWorkspace } from "@zli-v2/contracts";
import { useEffect, useState } from "react";

import type { BadgeTone } from "../../../ui/Badge.js";
import { errorText } from "../../mobile.js";
import type { WorkspaceApi } from "./bridge.js";

/** How often an open view checks the port again, so Metro starting or stopping shows up. */
const REFRESH_MS = 10_000;

/** The worktree's workspace, read again on change events and every few seconds while shown. */
export function useWorkspace(api: WorkspaceApi | undefined, worktreeId: string | undefined) {
  const [workspace, setWorkspace] = useState<MobileWorkspace>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setWorkspace(undefined);
    setError(undefined);
    if (!api || !worktreeId) return;
    let current = true;
    // Reads overlap (the timer, change events, the first load), so only the newest one lands.
    let request = 0;
    const load = () => {
      const id = ++request;
      return api.get(worktreeId).then(
        (next) => {
          if (!current || id !== request) return;
          setWorkspace(next);
          setError(undefined);
        },
        (cause: unknown) => {
          if (current && id === request) setError(errorText(cause, "ZLI could not read this worktree's Metro port."));
        },
      );
    };
    void load();
    const unsubscribe = api.onChange((event) => {
      if (!event.worktreeId || event.worktreeId === worktreeId) void load();
    });
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      current = false;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [api, worktreeId]);
  return { workspace, error };
}

/** The owner badge in the project view and Settings. */
export function ownerBadge(owner: MetroOwner): { tone: BadgeTone; label: string } {
  switch (owner.state) {
    case "free":
      return { tone: "neutral", label: "Free" };
    case "this-worktree":
      return { tone: "success", label: "Running here" };
    case "other-worktree":
      return { tone: "warning", label: `Used by ${owner.branch}` };
    case "other-process":
      return { tone: "warning", label: "Used by another program" };
    case "unknown":
      return { tone: "quiet", label: "Not checked" };
  }
}

/** The warning for a port held by someone else, or undefined while it is free or this worktree's. */
export function ownerWarning(workspace: MobileWorkspace): string | undefined {
  const { metro, metroPort } = workspace;
  if (metro.state === "other-worktree")
    return `Port ${metroPort} is served from ${metro.branch}, not this worktree. Opening it would show that branch's app.`;
  if (metro.state === "other-process") return `Another program is using port ${metroPort}, this worktree's Metro port.`;
  return undefined;
}

/** The last folder of a path, for the dim text beside a branch. */
export function folderName(path: string | undefined): string {
  return path?.replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? "";
}
