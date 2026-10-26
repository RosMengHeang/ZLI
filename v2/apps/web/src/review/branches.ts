import type { GitBranchesResult } from "@zli-v2/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import type { PickerOption } from "../ui/Picker.js";
import { type Dispatch, fetchBranches, listBranches } from "./pullRequestClient.js";

export type BranchState = {
  branches: GitBranchesResult | undefined;
  /** "list" while the local refs are read, "fetch" while origin is asked. */
  loading: "list" | "fetch" | undefined;
  error: string | undefined;
  reload(): Promise<void>;
  fetch(): Promise<boolean>;
};

/** The worktree's branches, read when the worktree changes and again on request. */
export function useBranches(dispatch: Dispatch, worktreeId: string | undefined, enabled = true): BranchState {
  const [branches, setBranches] = useState<GitBranchesResult>();
  const [loading, setLoading] = useState<BranchState["loading"]>();
  const [error, setError] = useState<string>();
  const latest = useRef(0);

  const load = useCallback(
    async (kind: "list" | "fetch"): Promise<boolean> => {
      if (!worktreeId) return false;
      const request = ++latest.current;
      setLoading(kind);
      setError(undefined);
      try {
        const next = await (kind === "fetch" ? fetchBranches : listBranches)(dispatch, worktreeId);
        if (request === latest.current) setBranches(next);
        return true;
      } catch (cause) {
        if (request === latest.current)
          setError(cause instanceof Error ? cause.message : "The branches could not be read.");
        return false;
      } finally {
        if (request === latest.current) setLoading(undefined);
      }
    },
    [dispatch, worktreeId],
  );

  useEffect(() => {
    setBranches(undefined);
    if (enabled) void load("list");
  }, [enabled, load]);

  return {
    branches,
    loading,
    error,
    reload: useCallback(async () => void (await load("list")), [load]),
    fetch: useCallback(() => load("fetch"), [load]),
  };
}

/** The branch a picker starts on: origin's default, then main or master, then the first other branch. */
export function defaultBranchOf(branches: GitBranchesResult): string | undefined {
  const names = [...branches.local, ...branches.remote];
  if (branches.defaultBranch) return branches.defaultBranch;
  return ["main", "master"].find((name) => names.includes(name)) ?? names.find((name) => name !== branches.current);
}

/**
 * Choices for a branch picker. Local branches come first, the default one on top. With `remote`, origin's
 * branches follow as `origin/<name>`, so a comparison can be made against what is pushed. The current
 * branch is left out of the local list, since a branch cannot be compared with or merged into itself.
 * `selected` is kept as a choice even when Git no longer lists it.
 */
export function branchOptions(
  branches: GitBranchesResult | undefined,
  { remote = false, selected }: { remote?: boolean; selected?: string } = {},
): PickerOption<string>[] {
  const options: PickerOption<string>[] = [];
  const seen = new Set<string>();
  const add = (value: string, description: string) => {
    if (seen.has(value)) return;
    seen.add(value);
    options.push({ value, label: value, description });
  };
  if (branches) {
    const top = branches.defaultBranch;
    const local = branches.local.filter((name) => name !== branches.current);
    for (const name of top && local.includes(top) ? [top, ...local] : local) {
      add(name, name === top ? "Local, default branch" : "Local");
    }
    if (remote) {
      for (const name of top && branches.remote.includes(top) ? [top, ...branches.remote] : branches.remote) {
        add(`origin/${name}`, name === branches.current ? "On origin, this branch" : "On origin");
      }
    }
  }
  if (selected && !seen.has(selected)) options.unshift({ value: selected, label: selected });
  return options;
}

/** Choices for a pull request base, which must be a branch on origin. */
export function baseBranchOptions(branches: GitBranchesResult | undefined, selected?: string): PickerOption<string>[] {
  const options: PickerOption<string>[] = [];
  if (branches) {
    const top = branches.defaultBranch;
    const names = branches.remote.filter((name) => name !== branches.current);
    for (const name of top && names.includes(top) ? [top, ...names.filter((other) => other !== top)] : names) {
      options.push({ value: name, label: name, ...(name === top ? { description: "Default branch" } : {}) });
    }
  }
  if (selected && !options.some((option) => option.value === selected))
    options.unshift({ value: selected, label: selected });
  return options;
}
