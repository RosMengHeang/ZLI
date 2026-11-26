import type {
  ProjectProjection,
  PullRequestCheck,
  PullRequestInfo,
  ReviewProjection,
  RuntimeProjection,
  ThreadProjection,
  WorktreeProjection,
} from "@zli-v2/contracts";
import { type ReactNode, useCallback, useId, useMemo, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { type CompactAction, useCompactActionFor } from "../chat/compactAction.js";
import { withKnownWindow } from "../chat/compaction.js";
import { OpenInButton } from "../files/OpenInButton.js";
import { changeTotals } from "../review/changes.js";
import { openExternalLink } from "../review/links.js";
import { usePullRequestEntry } from "../review/pullRequestStore.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime, useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { entriesForThreads, shallowArrayEqual } from "../runtime/runtimeStore.js";
import { type AgentSession, conversationThreads } from "../sessions/sessions.js";
import { Button, IconButton } from "../ui/Button.js";
import { Collapse } from "../ui/Collapse.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { modelOptions } from "../ui/ModelMark.js";
import { type ContextUsage, formatTokens, latestContext } from "../usage/usage.js";
import {
  type ChecksView,
  checksView,
  count,
  type McpUse,
  mcpUsage,
  type OverviewCardId,
  type PullRequestTone,
  percent,
  pullRequestStateLabel,
  pullRequestTone,
  readCollapsedCards,
  sessionTokens,
  type TokenRow,
  writeCollapsedCards,
} from "./overview.js";
import { type RunningEntry, useRunning } from "./running.js";
import "./overview.css";

/** Past this share of the window the agent will soon compact or stop, so the bar turns amber. */
const NEARLY_FULL = 0.85;
/** Checks shown before "Show more". */
const CHECKS_SHOWN = 5;

type Tone = "accent" | "green" | "red" | "amber" | "muted";

/** Everything the cards show, worked out from the runtime. A part is absent when nothing reports it. */
export type OverviewData = {
  environment?: {
    worktreeId?: string | undefined;
    place: "local" | "worktree";
    branch: string;
    path: string;
    project?: string | undefined;
    agent?: string | undefined;
    model?: string | undefined;
    account?: string | undefined;
    startedAt?: string | undefined;
    status?: { label: string; tone: Tone } | undefined;
  };
  changes?: {
    pullRequest?: PullRequestInfo | undefined;
    /** Files changed in the worktree and not committed yet, with their line counts when the review has them. */
    local?: { files: number; additions?: number; deletions?: number } | undefined;
    conflicts?: number | undefined;
    /** Commits the tracked branch does not have yet. */
    toPush?: number | undefined;
  };
  checks?: ChecksView | undefined;
  context?: ContextUsage | undefined;
  tokens?: { total: number; rows: TokenRow[] } | undefined;
  compact?: CompactAction | undefined;
  mcps: McpUse[];
  /** Servers, apps, and long commands running for the chat. */
  running: readonly RunningEntry[];
};

/** Where the overview's data comes from: the chat in view and its worktree. */
export type OverviewSource = {
  worktree: WorktreeProjection | undefined;
  project: ProjectProjection | undefined;
  session: AgentSession | undefined;
  accountName: string | undefined;
  review: ReviewProjection | undefined;
};

const threadStatus: Record<ThreadProjection["status"], { label: string; tone: Tone }> = {
  starting: { label: "Starting", tone: "accent" },
  working: { label: "Working", tone: "accent" },
  waiting: { label: "Waiting for you", tone: "amber" },
  idle: { label: "Idle", tone: "muted" },
  stopped: { label: "Ended", tone: "muted" },
  failed: { label: "Failed", tone: "red" },
};

const EMPTY_THREADS: readonly ThreadProjection[] = [];

/** The cards' data for one chat, read from the runtime, the pull request store, and the open chat. */
export function useOverviewData({ worktree, project, session, accountName, review }: OverviewSource): OverviewData {
  const thread = session?.thread;
  const threads = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => value?.threads ?? EMPTY_THREADS, []),
  );
  const providers = useRuntimeSelector(useCallback((value: RuntimeProjection | undefined) => value?.providers, []));
  // A chat that moved to another agent or model is one conversation across the threads it went through.
  const chainKey = useMemo(
    () => (thread ? conversationThreads(thread, threads).map((entry) => entry.threadId) : []).join(" "),
    [thread, threads],
  );
  const usage = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => entriesForThreads(value?.usage, chainKey), [chainKey]),
    shallowArrayEqual,
  );
  const activities = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => entriesForThreads(value?.activities, chainKey), [chainKey]),
    shallowArrayEqual,
  );
  const pullRequestStatus = usePullRequestEntry(worktree?.worktreeId)?.status;
  const compact = useCompactActionFor(thread?.threadId);
  const running = useRunning({
    worktreeId: worktree?.worktreeId,
    chainKey,
    activities,
    threadStatus: thread?.status,
  });

  return useMemo(() => {
    const threadId = thread?.threadId;
    // The context is the current thread's: an earlier agent's window says nothing about this one.
    const context = threadId
      ? withKnownWindow(latestContext(usage.filter((record) => record.threadId === threadId)), thread?.model)
      : undefined;
    const modelLabel = thread?.model
      ? (() => {
          const found = providers?.find((entry) => entry.provider === thread.provider);
          const listed = found?.status === "found" ? found.models : undefined;
          return (
            modelOptions(listed, thread.model, thread.provider).find((option) => option.value === thread.model)
              ?.label ?? thread.model
          );
        })()
      : undefined;
    const startedAt =
      threads.find((entry) => entry.threadId === chainKey.split(" ")[0])?.createdAt ?? session?.createdAt;
    const files = review ? review.files.length : pullRequestStatus?.uncommittedFiles;
    const lines = review && review.files.length > 0 ? changeTotals(review.files) : undefined;
    const pullRequest = pullRequestStatus?.pullRequest;
    const conflicts = review?.state === "conflicted" ? review.conflictFiles.length : undefined;
    const toPush = pullRequestStatus?.upstream?.ahead;
    const changesKnown = review !== undefined || pullRequestStatus !== undefined;
    return {
      ...(worktree
        ? {
            environment: {
              worktreeId: worktree.worktreeId,
              place: worktree.kind === "checkout" ? ("local" as const) : ("worktree" as const),
              branch: worktree.branch,
              path: worktree.path,
              project: project?.name,
              agent: thread
                ? (thread.name ?? providerDisplayName(thread.provider, providers))
                : session
                  ? providerDisplayName(session.provider, providers)
                  : undefined,
              model: modelLabel,
              account: accountName,
              startedAt,
              status:
                worktree.status !== "ready"
                  ? { label: worktree.status === "failed" ? "Setup failed" : "Setting up", tone: "amber" as const }
                  : thread
                    ? threadStatus[thread.status]
                    : undefined,
            },
          }
        : {}),
      ...(worktree && changesKnown
        ? {
            changes: {
              pullRequest,
              ...(files !== undefined && files > 0
                ? { local: { files, ...(lines ? { additions: lines.additions, deletions: lines.deletions } : {}) } }
                : {}),
              ...(conflicts ? { conflicts } : {}),
              ...(toPush ? { toPush } : {}),
            },
          }
        : {}),
      checks: checksView(pullRequest),
      context,
      tokens: sessionTokens(usage),
      compact,
      mcps: mcpUsage(activities),
      running,
    };
  }, [
    thread,
    session,
    threads,
    chainKey,
    usage,
    activities,
    providers,
    pullRequestStatus,
    compact,
    worktree,
    project,
    accountName,
    review,
    running,
  ]);
}

/**
 * What the chat's own card adds to the shared cards: the Git actions that change the worktree. The right panel
 * shows the same cards without them.
 */
export type OverviewGit = {
  /** Beside the pull request, such as Merge. */
  pullRequestAction?: ReactNode;
  /** At the foot of Changes: the commit or push action, and what the last Git action said. */
  commit?: ReactNode;
  /** The changes are being read for the first time. */
  reading?: boolean;
  /** The folder is not a Git repository: the branch and Changes are left out, and this says so instead. */
  noGit?: ReactNode;
  /**
   * The rest of the Environment card's list, under the folder and Open in: the project script, then the branch,
   * Commit & push, and the changes.
   */
  actions?: ReactNode;
};

/**
 * The overview's cards, one column of them: where the chat runs, what runs for it, what it changed, how its
 * checks went, how full its context is, and what it reached for. A card shows only when something reports it,
 * and a folded card stays folded. The chat's computer column renders these.
 */
export function OverviewCards({
  data,
  git,
  onOpen,
  onOpenUrl,
}: {
  data: OverviewData;
  git?: OverviewGit | undefined;
  onOpen(pane: "review" | "pullRequest"): void;
  /** Opens a local address, in the browser panel where there is one. Without it the address opens outside ZLI. */
  onOpenUrl?: ((url: string) => void) | undefined;
}) {
  const { bridge, dispatch } = useRuntime();
  const [collapsed, setCollapsed] = useState(readCollapsedCards);
  const [openInError, setOpenInError] = useState<string>();
  const toggle = (id: OverviewCardId) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeCollapsedCards(next);
      return next;
    });
  const openLink = (url: string) => {
    if (bridge) void openExternalLink(bridge, url);
  };

  const card = (id: OverviewCardId, title: string, meta: ReactNode, body: ReactNode, action?: ReactNode) => (
    <OverviewCard
      key={id}
      title={title}
      meta={meta}
      action={action}
      collapsed={collapsed.has(id)}
      onToggle={() => toggle(id)}
    >
      {body}
    </OverviewCard>
  );

  const { environment, checks, context, tokens, compact, mcps, running } = data;
  const openUrl = onOpenUrl ?? openLink;
  const stopTerminal = (terminalId: string) =>
    dispatch({ protocolVersion: 1, commandId: makeCommandId(), command: { type: "terminal.stop", terminalId } });
  const changes = git?.noGit ? undefined : data.changes;
  const worktreeId = environment?.worktreeId;
  const cards = [
    environment
      ? card(
          "environment",
          "Environment",
          environment.status ? <StatusMark tone={environment.status.tone} label={environment.status.label} /> : null,
          <EnvironmentBody
            environment={environment}
            openIn={
              worktreeId ? (
                <OpenInButton row worktreeId={worktreeId} onError={(message) => setOpenInError(message)} />
              ) : null
            }
            actions={git?.actions}
            running={
              running.length > 0 ? <RunningBody entries={running} onOpenUrl={openUrl} onStop={stopTerminal} /> : null
            }
            onOpenFolder={
              worktreeId && bridge?.openIn
                ? () =>
                    void bridge.openIn
                      ?.open(worktreeId, "files")
                      .catch((cause: unknown) =>
                        setOpenInError(cause instanceof Error ? cause.message : "The folder could not be opened."),
                      )
                : undefined
            }
            note={
              openInError ? (
                <p className="ov-note is-error" role="alert">
                  {openInError}
                </p>
              ) : git?.noGit ? (
                git.noGit
              ) : null
            }
          />,
        )
      : null,
    changes
      ? card(
          "changes",
          "Changes",
          changes.pullRequest ? <PullRequestState pullRequest={changes.pullRequest} /> : null,
          <ChangesBody
            changes={changes}
            reading={git?.reading ?? false}
            pullRequestAction={git?.pullRequestAction}
            foot={git?.commit}
            onOpen={onOpen}
          />,
        )
      : null,
    checks
      ? card("checks", "Checks", <ChecksCount checks={checks} />, <ChecksBody checks={checks} onOpenLink={openLink} />)
      : null,
    context
      ? card(
          "context",
          "Context",
          null,
          <ContextBody context={context} tokens={tokens} compact={compact} />,
          compact ? <CompactButton action={compact} /> : null,
        )
      : null,
    mcps.length > 0
      ? card(
          "mcps",
          "MCPs",
          <span className="ov-meta">{mcps.length} used</span>,
          <ul className="ov-rows">
            {mcps.map((use) => (
              <li key={use.server} className="ov-row">
                <Icon name="puzzle" size={14} className="ov-row-icon" />
                <span className="ov-row-name is-mono">{use.server}</span>
                {use.failed > 0 ? <span className="ov-row-note is-red">{use.failed} failed</span> : null}
                <span className="ov-row-value">{use.calls === 1 ? "1 call" : `${count(use.calls)} calls`}</span>
              </li>
            ))}
          </ul>,
        )
      : null,
  ].filter((entry) => entry !== null);

  return <>{cards}</>;
}

function OverviewCard({
  title,
  meta,
  action,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  meta: ReactNode;
  action?: ReactNode;
  collapsed: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  const bodyId = useId();
  return (
    <section className={`ov-card${collapsed ? " is-collapsed" : ""}`} aria-label={title}>
      <header className="ov-card-head">
        <button
          type="button"
          className="ov-card-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <h3>{title}</h3>
          <Icon name="chevronDown" size={12} className="ov-card-chevron" />
          {meta ? <span className="ov-card-meta">{meta}</span> : null}
        </button>
        {action ? <span className="ov-card-action">{action}</span> : null}
      </header>
      <Collapse open={!collapsed}>
        <div className="ov-card-body" id={bodyId}>
          {children}
        </div>
      </Collapse>
    </section>
  );
}

function StatusMark({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className="ov-meta">
      <span className={`ov-dot is-${tone}`} aria-hidden="true" />
      {label}
    </span>
  );
}

/** The last two parts of a path, such as code/web, which is enough to tell folders apart. */
function shortFolder(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : parts.join("/") || path;
}

/**
 * Where the chat runs and what to do with it, as one list: the folder (with a button that shows it in the file
 * manager) and Open in; below a line the branch and Commit & push the chat card adds; then what runs for the chat,
 * such as a dev server or an app an agent started.
 * The agent and model are in the composer, so they are not repeated here.
 */
function EnvironmentBody({
  environment,
  openIn,
  actions,
  running,
  onOpenFolder,
  note,
}: {
  environment: NonNullable<OverviewData["environment"]>;
  openIn: ReactNode;
  actions: ReactNode;
  /** Servers, apps, and scripts running for the chat, such as a dev server an agent started. */
  running: ReactNode;
  onOpenFolder: (() => void) | undefined;
  note: ReactNode;
}) {
  const local = environment.place === "local";
  return (
    <>
      <div className="ov-env">
        <div className="ov-row" data-tooltip={environment.path}>
          <Icon name={local ? "monitor" : "folderTree"} size={14} className="ov-row-icon" />
          <span className="ov-row-name">{local ? "Local" : "Worktree"}</span>
          <span className="ov-row-value is-mono">{shortFolder(environment.path)}</span>
          {onOpenFolder ? (
            <IconButton
              icon="folder"
              size="xs"
              iconSize={13}
              label="Show in folder"
              tooltip="Show in the file manager"
              onClick={onOpenFolder}
            />
          ) : null}
        </div>
        {openIn}
        {actions}
        {running ? (
          <>
            <hr className="ov-divider" />
            {running}
          </>
        ) : null}
      </div>
      {note}
    </>
  );
}

const PULL_ICON: Record<PullRequestTone, IconName> = {
  open: "pullRequest",
  draft: "pullRequest",
  merged: "merge",
  closed: "pullRequest",
};

const CHECK_ICON = { pending: "loader", failed: "alert", passed: "check" } as const;

/** Checks passed out of all of them: amber while any run, red once one fails, green when all pass. */
export function ChecksCount({ checks }: { checks: ChecksView }) {
  return (
    <span className={`ov-meta ov-checks-count is-${checks.tone}`} title={`Checks ${checks.headline}`}>
      <Icon
        name={CHECK_ICON[checks.tone]}
        size={11}
        className={checks.tone === "pending" ? "ov-checks-spin" : undefined}
      />
      {checks.count}
    </span>
  );
}

function PullRequestState({ pullRequest }: { pullRequest: PullRequestInfo }) {
  const tone = pullRequestTone(pullRequest);
  return <span className={`ov-meta ov-pr-state is-${tone}`}>{pullRequestStateLabel[tone]}</span>;
}

function ChangesBody({
  changes,
  reading,
  pullRequestAction,
  foot,
  onOpen,
}: {
  changes: NonNullable<OverviewData["changes"]>;
  reading: boolean;
  pullRequestAction: ReactNode;
  foot: ReactNode;
  onOpen(pane: "review" | "pullRequest"): void;
}) {
  const { pullRequest, local, conflicts, toPush } = changes;
  const tone = pullRequest ? pullRequestTone(pullRequest) : undefined;
  const checks = pullRequest?.state === "OPEN" ? checksView(pullRequest) : undefined;
  const nothing = !pullRequest && !local && !conflicts && !toPush;
  return (
    <>
      <ul className="ov-rows">
        {pullRequest && tone ? (
          <li className="ov-pr">
            <button type="button" className="ov-row is-button is-tall" onClick={() => onOpen("pullRequest")}>
              <Icon name={PULL_ICON[tone]} size={14} className={`ov-row-icon ov-pr-icon is-${tone}`} />
              <span className="ov-row-stack">
                <span className="ov-row-name ov-pr-title">
                  {pullRequest.title ?? `Pull request #${pullRequest.number}`}
                </span>
                <span className="ov-row-sub">
                  <span>#{pullRequest.number}</span>
                  {pullRequest.additions !== undefined ? (
                    <span className="ov-add">+{count(pullRequest.additions)}</span>
                  ) : null}
                  {pullRequest.deletions !== undefined ? (
                    <span className="ov-del">−{count(pullRequest.deletions)}</span>
                  ) : null}
                  {pullRequest.changedFiles !== undefined ? (
                    <span>
                      {pullRequest.changedFiles === 1 ? "1 file" : `${count(pullRequest.changedFiles)} files`}
                    </span>
                  ) : null}
                  {checks ? <ChecksCount checks={checks} /> : null}
                </span>
              </span>
            </button>
            {pullRequestAction ? <span className="ov-pr-action">{pullRequestAction}</span> : null}
          </li>
        ) : null}
        {conflicts ? (
          <li>
            <button type="button" className="ov-row is-button" onClick={() => onOpen("review")}>
              <Icon name="alert" size={14} className="ov-row-icon is-red" />
              <span className="ov-row-name">
                {conflicts === 1 ? "1 conflict to resolve" : `${conflicts} conflicts to resolve`}
              </span>
            </button>
          </li>
        ) : null}
        {local ? (
          <li>
            <button type="button" className="ov-row is-button" onClick={() => onOpen("review")}>
              <Icon name="diff" size={14} className="ov-row-icon" />
              <span className="ov-row-name">
                {local.files === 1 ? "1 file not committed" : `${count(local.files)} files not committed`}
              </span>
              {local.additions !== undefined ? (
                <span className="ov-row-value">
                  <span className="ov-add">+{count(local.additions)}</span>{" "}
                  <span className="ov-del">−{count(local.deletions ?? 0)}</span>
                </span>
              ) : null}
            </button>
          </li>
        ) : null}
        {toPush ? (
          <li className="ov-row">
            <Icon name="upload" size={14} className="ov-row-icon" />
            <span className="ov-row-name">
              {toPush === 1 ? "1 commit to push" : `${count(toPush)} commits to push`}
            </span>
          </li>
        ) : null}
        {nothing ? (
          <li className="ov-row is-quiet">
            {reading ? (
              <span className="spinner ov-row-icon" aria-hidden="true" />
            ) : (
              <Icon name="check" size={14} className="ov-row-icon" />
            )}
            <span className="ov-row-name">{reading ? "Reading the changes" : "No changes yet"}</span>
          </li>
        ) : null}
      </ul>
      {foot ? <div className="ov-card-foot">{foot}</div> : null}
    </>
  );
}

const CHECK_MARK: Record<PullRequestCheck["state"], { icon: IconName; label: string }> = {
  passed: { icon: "check", label: "Passed" },
  failed: { icon: "x", label: "Failed" },
  pending: { icon: "loader", label: "Running" },
  skipped: { icon: "circle", label: "Skipped" },
};

function ChecksBody({ checks, onOpenLink }: { checks: ChecksView; onOpenLink(url: string): void }) {
  const [all, setAll] = useState(false);
  const shown = all ? checks.checks : checks.checks.slice(0, CHECKS_SHOWN);
  const hidden = checks.checks.length - shown.length;
  return (
    <>
      <ul className="ov-rows">
        {shown.map((check) => {
          const mark = CHECK_MARK[check.state];
          const content = (
            <>
              <Icon name={mark.icon} size={14} className={`ov-row-icon ov-check is-${check.state}`} />
              <span className="ov-row-name">{check.name}</span>
              <span className="ov-row-value">{mark.label}</span>
            </>
          );
          const url = check.url;
          return (
            <li key={`${check.workflow ?? ""}/${check.name}/${check.url ?? ""}`}>
              {url ? (
                <button
                  type="button"
                  className="ov-row is-button"
                  data-tooltip={check.workflow}
                  onClick={() => onOpenLink(url)}
                >
                  {content}
                </button>
              ) : (
                <span className="ov-row">{content}</span>
              )}
            </li>
          );
        })}
      </ul>
      {hidden > 0 || all ? (
        <button type="button" className="ov-more" onClick={() => setAll((value) => !value)}>
          {all ? "Show fewer" : hidden === 1 ? "Show 1 more check" : `Show ${hidden} more checks`}
        </button>
      ) : null}
    </>
  );
}

export function CompactButton({ action }: { action: CompactAction }) {
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={action.status !== "ready"}
      loading={action.status === "compacting"}
      tooltip={action.status === "unavailable" ? action.note : undefined}
      onClick={action.run}
    >
      {action.status === "compacting" ? "Compacting…" : "Compact now"}
    </Button>
  );
}

export function ContextBody({
  context,
  tokens,
  compact,
}: {
  context: ContextUsage;
  tokens: OverviewData["tokens"];
  compact: CompactAction | undefined;
}) {
  const share = context.window ? Math.min(1, context.tokens / context.window) : undefined;
  const note =
    compact && compact.status !== "unavailable"
      ? (compact.note ??
        (compact.autoAt !== undefined ? `Compacts by itself at ${Math.round(compact.autoAt * 100)}%.` : undefined))
      : undefined;
  return (
    <div className="ov-context">
      <div className="ov-context-line">
        <span className="ov-context-big">
          {share !== undefined ? `${percent(share)} used` : `${formatTokens(context.tokens)} used`}
        </span>
        {context.window ? (
          <span className="ov-context-of">
            {formatTokens(context.tokens)} / {formatTokens(context.window)}
          </span>
        ) : null}
      </div>
      {share !== undefined ? (
        <div
          className={`ov-bar${share >= NEARLY_FULL ? " is-full" : ""}`}
          // The share is written out above; the bar only draws it.
          aria-hidden="true"
        >
          <span style={{ width: `${Math.max(share * 100, 1)}%` }} />
        </div>
      ) : null}
      {note ? <p className="ov-note">{note}</p> : null}
      {tokens ? (
        <div className="ov-tokens">
          <div className="ov-tokens-head">
            <span>Session usage</span>
            <span className="ov-num">{formatTokens(tokens.total)} tokens</span>
          </div>
          <ul className="ov-rows">
            {tokens.rows.map((row) => (
              <li key={row.id} className="ov-row">
                <span className={`ov-token-dot is-${row.id}`} aria-hidden="true" />
                <span className="ov-row-name">{row.label}</span>
                <span className="ov-row-value ov-num">{formatTokens(row.tokens)}</span>
                <span className="ov-row-share ov-num">{percent(row.share)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

const RUNNING_STATUS: Record<RunningEntry["status"], { label: string; tone: Tone }> = {
  starting: { label: "Starting", tone: "amber" },
  running: { label: "Running", tone: "green" },
  exited: { label: "Exited", tone: "muted" },
};

export function RunningBody({
  entries,
  onOpenUrl,
  onStop,
}: {
  entries: readonly RunningEntry[];
  onOpenUrl(url: string): void;
  onStop(terminalId: string): Promise<unknown>;
}) {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const stop = (terminalId: string) => {
    setStopping((current) => new Set(current).add(terminalId));
    void onStop(terminalId).catch(() =>
      setStopping((current) => {
        const next = new Set(current);
        next.delete(terminalId);
        return next;
      }),
    );
  };
  return (
    <ul className="ov-rows">
      {entries.map((entry) => {
        const status = RUNNING_STATUS[entry.status];
        const url = entry.status === "exited" ? undefined : entry.url;
        const terminalId = entry.status === "exited" ? undefined : entry.terminalId;
        const main = (
          <>
            <Icon name={entry.icon} size={14} className="ov-row-icon" />
            <span className="ov-row-stack">
              <span className={`ov-row-name${entry.url ? "" : " is-mono"}`}>{entry.name}</span>
              {entry.detail ? <span className="ov-row-sub is-mono">{entry.detail}</span> : null}
            </span>
            <span className={`ov-dot is-${status.tone}`} role="img" aria-label={status.label} />
          </>
        );
        return (
          <li key={entry.id} className={`ov-run${entry.status === "exited" ? " is-exited" : ""}`}>
            {url ? (
              <button
                type="button"
                className="ov-row is-button is-tall"
                data-tooltip={`Open ${entry.name}`}
                onClick={() => onOpenUrl(url)}
              >
                {main}
              </button>
            ) : (
              <span className="ov-row is-tall">{main}</span>
            )}
            {terminalId ? (
              <Button
                variant="ghost"
                size="xs"
                loading={stopping.has(terminalId)}
                tooltip="Stop the terminal that runs it"
                onClick={() => stop(terminalId)}
              >
                Stop
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The cards for one chat, read where they render so the parent does not re-render for usage updates. */
export function OverviewCardsFor({
  source,
  ...rest
}: { source: OverviewSource } & Omit<Parameters<typeof OverviewCards>[0], "data">) {
  return <OverviewCards data={useOverviewData(source)} {...rest} />;
}
