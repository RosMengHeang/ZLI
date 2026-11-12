import type { PullRequestInfo, ReviewProjection } from "@zli-v2/contracts";

import { checksSummary } from "../chat/ChatExtras.js";
import { changeTotals } from "../review/changes.js";
import type { LauncherItem } from "./PanelLauncher.js";
import { sidePaneDetail, sidePaneIcon, sidePaneLabel, type ToolbarPane } from "./Topbar.js";

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
  activeHuddles: number;
  /** A chat is in view, so a side question can be asked about it. */
  sideChat: boolean;
};

export type LauncherActions = {
  open(pane: ToolbarPane | "pullRequest" | "sideChat"): void;
  openTerminal(): void;
  openDevServer(url: string): void;
};

const HOTKEY: Record<ToolbarPane, string> = { files: "f", review: "c", browser: "b", mobile: "m", huddle: "h" };

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The picker's rows in their fixed order, each with its live line when there is something to say. */
export function launcherItems(state: LauncherState, actions: LauncherActions): LauncherItem[] {
  const pane = (id: ToolbarPane, live?: LauncherItem["live"], run?: () => void): LauncherItem => ({
    id,
    label: sidePaneLabel[id],
    detail: sidePaneDetail[id],
    icon: sidePaneIcon[id],
    hotkey: HOTKEY[id],
    live,
    run: run ?? (() => actions.open(id)),
  });
  const server = state.devServers[0];
  const items: LauncherItem[] = [pane("review", changesLine(state)), pane("files")];
  if (state.pullRequest && state.pullRequest.state !== "CLOSED") {
    items.push({
      id: "pullRequest",
      label: "Pull request",
      detail: "Checks, reviews, and merging",
      icon: "pullRequest",
      hotkey: "p",
      live: pullRequestLine(state.pullRequest),
      run: () => actions.open("pullRequest"),
    });
  }
  if (state.showTerminal) {
    items.push({
      id: "terminal",
      label: "Terminal",
      detail: "A shell in the worktree, at the bottom",
      icon: "terminal",
      hotkey: "t",
      live: state.drawerOpen
        ? { text: "Open at the bottom", tone: "muted" }
        : state.runningTerminals > 0
          ? { text: `${state.runningTerminals} running`, tone: "green" }
          : undefined,
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
  items.push(
    pane(
      "huddle",
      state.activeHuddles > 0
        ? {
            text: state.activeHuddles === 1 ? "1 huddle going" : `${state.activeHuddles} huddles going`,
            tone: "accent",
          }
        : undefined,
    ),
  );
  if (state.sideChat) {
    items.push({
      id: "sideChat",
      label: "Side chat",
      detail: "Ask about this chat. The answer stays out of it",
      icon: "message",
      hotkey: "s",
      run: () => actions.open("sideChat"),
    });
  }
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
          {files} to review <span className="panel-launcher-add">+{additions}</span>{" "}
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
