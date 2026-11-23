import type { PullRequestInfo, ReviewProjection } from "@zli-v2/contracts";
import type { ReactNode } from "react";

import { checksSummary } from "../chat/ChatExtras.js";
import { changeTotals } from "../review/changes.js";
import type { IconName } from "../ui/Icon.js";
import { sidePaneDetail, sidePaneIcon, sidePaneLabel, type ToolbarPane } from "./Topbar.js";

/** How a panel's live state reads: the colour of its dot on the rail says whether it wants a look. */
export type LiveTone = "accent" | "green" | "red" | "muted";

export type LauncherItem = {
  id: string;
  label: string;
  /** What the panel is for. */
  detail: string;
  icon: IconName;
  /** What is going on in the panel right now: changes waiting, a server up, checks failing. */
  live?: { text: ReactNode; tone: LiveTone } | undefined;
  /** How many things wait in the panel, shown on its icon in the right panel's rail. */
  count?: number | undefined;
  run(): void;
};

/** What the panel picker knows about the worktree in view, all of it already in the runtime. */
export type LauncherState = {
  mobileAvailable: boolean;
  /** Chat only keeps the terminal out of the list. */
  showTerminal: boolean;
  drawerOpen: boolean;
  review: ReviewProjection | undefined;
  /** Files `git status` reports, from the last pull request lookup, when the Changes panel has not loaded yet. */
  uncommittedFiles: number | undefined;
  runningTerminals: number;
  /** Servers the worktree's terminals run, newest first. */
  devServers: readonly { url: string }[];
  pullRequest: PullRequestInfo | undefined;
};

export type LauncherActions = {
  open(pane: ToolbarPane | "pullRequest"): void;
  openTerminal(): void;
  openDevServer(url: string): void;
};

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The picker's rows in their fixed order, each with its live line when there is something to say. */
export function launcherItems(state: LauncherState, actions: LauncherActions): LauncherItem[] {
  const pane = (id: ToolbarPane, live?: LauncherItem["live"], run?: () => void, count?: number): LauncherItem => ({
    id,
    ...(count ? { count } : {}),
    label: sidePaneLabel[id],
    detail: sidePaneDetail[id],
    icon: sidePaneIcon[id],
    live,
    run: run ?? (() => actions.open(id)),
  });
  const server = state.devServers[0];
  const changed = state.review ? state.review.files.length : (state.uncommittedFiles ?? 0);
  const items: LauncherItem[] = [pane("review", changesLine(state), undefined, changed), pane("files")];
  if (state.pullRequest && state.pullRequest.state !== "CLOSED") {
    items.push({
      id: "pullRequest",
      label: "Pull request",
      detail: "Checks, reviews, and merging",
      icon: "pullRequest",
      live: pullRequestLine(state.pullRequest),
      run: () => actions.open("pullRequest"),
    });
  }
  if (state.showTerminal) {
    items.push({
      id: "terminal",
      label: "Terminal",
      detail: sidePaneDetail.terminal,
      icon: "terminal",
      ...(state.runningTerminals > 0 ? { count: state.runningTerminals } : {}),
      live: state.runningTerminals > 0 ? { text: `${state.runningTerminals} running`, tone: "green" } : undefined,
      run: actions.openTerminal,
    });
  }
  items.push(
    pane(
      "browser",
      server ? { text: `${host(server.url)} is up. Open it`, tone: "green" } : undefined,
      server ? () => actions.openDevServer(server.url) : undefined,
    ),
  );
  if (state.mobileAvailable) items.push(pane("mobile"));
  return items;
}

function changesLine(state: LauncherState): LauncherItem["live"] {
  const review = state.review;
  if (review?.state === "conflicted") {
    const count = review.conflictFiles.length;
    return { text: count === 1 ? "1 conflict to resolve" : `${count} conflicts to resolve`, tone: "red" };
  }
  if (review && review.files.length > 0) {
    const { additions, deletions } = changeTotals(review.files);
    const files = review.files.length === 1 ? "1 file" : `${review.files.length} files`;
    return {
      text: (
        <>
          <span className="panel-launcher-count">{files}</span> to review{" "}
          <span className="panel-launcher-add">+{additions}</span>{" "}
          <span className="panel-launcher-del">−{deletions}</span>
        </>
      ),
      tone: "accent",
    };
  }
  if (review?.state === "clean") return { text: "Clean. Nothing to review", tone: "muted" };
  if (state.uncommittedFiles) {
    const files = state.uncommittedFiles === 1 ? "1 file" : `${state.uncommittedFiles} files`;
    return { text: `${files} not committed`, tone: "accent" };
  }
  return undefined;
}

function pullRequestLine(pullRequest: PullRequestInfo): LauncherItem["live"] {
  const name = `#${pullRequest.number}`;
  if (pullRequest.state === "MERGED") return { text: `${name} merged`, tone: "muted" };
  const checks = checksSummary(pullRequest);
  if (checks.state === "failed") {
    return { text: `${name} · ${checks.failed} of ${checks.total} checks failed`, tone: "red" };
  }
  if (checks.state === "pending") return { text: `${name} · checks running`, tone: "accent" };
  if (checks.state === "passed") return { text: `${name} · checks passed`, tone: "green" };
  return { text: `${name} open`, tone: "accent" };
}
