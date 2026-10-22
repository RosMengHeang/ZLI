import type {
  PermissionMode,
  RuntimeProjection,
  ThreadCheckpoint,
  ThreadId,
  ThreadMessageProjection,
  ThreadProjection,
  ThreadQueuedMessage,
  WorktreeProjection,
} from "@zli-v2/contracts";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { type FileLinks, useFileLinks } from "../files/FileIndex.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime, useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { entriesForThread, shallowArrayEqual } from "../runtime/runtimeStore.js";
import { buildTimeline, type TimelineItem } from "../sessions/sessions.js";
import { Button, IconButton } from "../ui/Button.js";
import { Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { EmptyState } from "../ui/Pane.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { latestContext } from "../usage/usage.js";
import { Composer, type ComposerAttachment } from "./Composer.js";
import { Markdown } from "./Markdown.js";
import { RequestCard } from "./RequestCard.js";
import { TurnChanges } from "./TurnChanges.js";
import { ChangedFiles, WorkLog } from "./WorkLog.js";
import "./chat.css";

export function ChatView({
  projection,
  thread,
  worktree,
  onOpenDiff,
  onRestart,
}: {
  projection: RuntimeProjection;
  thread: ThreadProjection;
  worktree: WorktreeProjection | undefined;
  onOpenDiff(path?: string): void;
  onRestart(): void;
}) {
  const { dispatch } = useRuntime();
  const [error, setError] = useState<string>();
  const [model, setModel] = useState<string | undefined>(thread.model);
  const threadMode = thread.permissionMode ?? "full-access";
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(threadMode);
  const permissionSwitch = thread.capabilities.permissionSwitch === "in-session";
  useEffect(() => setPermissionMode(threadMode), [threadMode]);
  const [peerDraft, setPeerDraft] = useState("");
  const [peerTargetId, setPeerTargetId] = useState<string>();
  const logRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const displayName = providerDisplayName(thread.provider, projection.providers);
  const discovery = projection.providers?.find((entry) => entry.provider === thread.provider);
  const models = discovery?.status === "found" ? discovery.models : undefined;
  // The projection passed in skips chat-only updates, so this thread's chat state is read from the
  // store. Each selector returns the same value while this thread is unchanged, even when another
  // thread is streaming.
  const threadId = thread.threadId;
  const messages = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => entriesForThread(value?.messages, threadId), [threadId]),
    shallowArrayEqual,
  );
  const activities = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => entriesForThread(value?.activities, threadId), [threadId]),
    shallowArrayEqual,
  );
  const request = useRuntimeSelector(
    useCallback(
      (value: RuntimeProjection | undefined) => value?.requests?.find((candidate) => candidate.threadId === threadId),
      [threadId],
    ),
  );
  const waitingCount = useRuntimeSelector(
    useCallback(
      (value: RuntimeProjection | undefined) =>
        (value?.requests ?? []).filter((candidate) => candidate.threadId === threadId).length,
      [threadId],
    ),
  );
  const queued = useRuntimeSelector(
    useCallback(
      (value: RuntimeProjection | undefined) => entriesForThread(value?.queuedMessages, threadId),
      [threadId],
    ),
    shallowArrayEqual,
  );
  const usage = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => entriesForThread(value?.usage, threadId), [threadId]),
    shallowArrayEqual,
  );
  const context = useMemo(() => latestContext(usage), [usage]);
  const checkpoints = useRuntimeSelector(
    useCallback((value: RuntimeProjection | undefined) => entriesForThread(value?.checkpoints, threadId), [threadId]),
    shallowArrayEqual,
  );
  const previousTimeline = useRef<readonly TimelineItem[]>([]);
  const timeline = useMemo(() => buildTimeline(messages, activities, previousTimeline.current), [messages, activities]);
  useEffect(() => {
    previousTimeline.current = timeline;
  }, [timeline]);
  const fileLinks = useFileLinks(worktree?.worktreeId, messages.length);
  const latestOpenDiff = useRef(onOpenDiff);
  useLayoutEffect(() => {
    latestOpenDiff.current = onOpenDiff;
  });
  const openDiff = useCallback((...args: [path?: string]) => latestOpenDiff.current(...args), []);
  const ended = thread.status === "stopped" || thread.status === "failed";
  const working = thread.status === "working" || thread.status === "waiting";
  const busy = working || queued.length > 0;
  const peers = useMemo(() => {
    if (!worktree) return [];
    return projection.threads.filter((candidate) => {
      if (candidate.threadId === thread.threadId) return false;
      if (candidate.status === "stopped" || candidate.status === "failed") return false;
      const peerWorktree = projection.worktrees.find((item) => item.worktreeId === candidate.worktreeId);
      return peerWorktree?.projectId === worktree.projectId;
    });
  }, [projection.threads, projection.worktrees, thread.threadId, worktree]);
  const selectedPeerId = peers.some((peer) => peer.threadId === peerTargetId) ? peerTargetId : peers[0]?.threadId;
  const placedCheckpoints = useMemo(() => placeCheckpoints(timeline, checkpoints), [timeline, checkpoints]);
  const worktreeBusy = projection.threads.some(
    (candidate) =>
      candidate.worktreeId === thread.worktreeId && (candidate.status === "working" || candidate.status === "waiting"),
  );
  const restoreBlocked = worktreeBusy ? "Wait for the agents in this worktree to finish their turns" : undefined;
  const turnChanges = (checkpoint: ThreadCheckpoint) => (
    <TurnChanges
      key={checkpoint.checkpointId}
      checkpoint={checkpoint}
      displayName={displayName}
      branch={worktree?.branch ?? "this worktree"}
      restoreBlocked={restoreBlocked}
    />
  );

  useEffect(() => {
    const log = logRef.current;
    if (!log || !stickToBottom.current) return;
    log.scrollTop = log.scrollHeight;
  });

  const send = async (text: string, attachments: ComposerAttachment[]): Promise<boolean> => {
    setError(undefined);
    try {
      const response = await dispatch({
        protocolVersion: 1,
        commandId: makeCommandId(),
        command: {
          type: "thread.queue",
          queueId: makeCommandId(),
          threadId: thread.threadId,
          text,
          ...(model ? { model } : {}),
          ...(permissionSwitch && permissionMode !== threadMode ? { permissionMode } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      });
      if (response?.accepted === false) {
        setError(response.error.message);
        return false;
      }
      stickToBottom.current = true;
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The message could not be sent.");
      return false;
    }
  };

  const run = async (command: Record<string, unknown>) => {
    setError(undefined);
    const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
    if (response?.accepted === false) setError(response.error.message);
  };

  const sendToPeer = async () => {
    if (!selectedPeerId || !peerDraft.trim()) return;
    const text = peerDraft.trim();
    setPeerDraft("");
    setError(undefined);
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: {
        type: "thread.a2a",
        messageId: makeCommandId(),
        sourceThreadId: thread.threadId,
        targetThreadId: selectedPeerId,
        text,
      },
    });
    if (response?.accepted === false) {
      setPeerDraft(text);
      setError(response.error.message);
    }
  };

  const lastTurnRunning = working ? thread.activeTurnId : undefined;
  const visibleError = error;

  return (
    <div className="chat-view">
      <div
        className="chat-log"
        role="log"
        aria-label="Agent conversation"
        ref={logRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          stickToBottom.current = target.scrollHeight - target.scrollTop - target.clientHeight < 48;
        }}
      >
        <div className="chat-column">
          {timeline.length === 0 ? (
            <EmptyState
              className="chat-empty"
              media={
                thread.status === "starting" ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  <ProviderMark provider={thread.provider} size={18} />
                )
              }
              title={thread.status === "starting" ? `Starting ${displayName}` : `${displayName} is ready`}
              detail={`Describe a task. ${displayName} works in ${worktree?.branch ?? "this worktree"}.`}
            />
          ) : (
            timeline.map((item, index) => (
              <Fragment key={item.kind === "work" ? `work-${item.turnId}` : item.message.messageId}>
                {item.kind === "work" ? (
                  <ChatWork
                    item={item}
                    running={item.turnId === lastTurnRunning}
                    showChangedFiles={!placedCheckpoints.turns.has(item.turnId)}
                    onOpenDiff={openDiff}
                  />
                ) : (
                  <ChatMessage
                    message={item.message}
                    links={fileLinks}
                    source={item.message.role === "agent" ? sourceLabel(projection, item.message.sourceThreadId) : ""}
                  />
                )}
                {placedCheckpoints.after.get(index)?.map(turnChanges)}
              </Fragment>
            ))
          )}
          {placedCheckpoints.unplaced.map(turnChanges)}
          {thread.status === "working" ? (
            <p className="chat-working" role="status">
              <span className="spinner" aria-hidden="true" />
              {displayName} is working
            </p>
          ) : null}
        </div>
      </div>
      <div className="chat-dock">
        <div className="chat-column">
          {request ? (
            <RequestCard
              key={request.requestId}
              request={request}
              provider={thread.provider}
              displayName={displayName}
              waitingCount={waitingCount}
              onRespond={(decision) =>
                run({ type: "thread.respond", threadId: thread.threadId, requestId: request.requestId, decision })
              }
              onAnswer={(answers) =>
                run({ type: "thread.user-input", threadId: thread.threadId, requestId: request.requestId, answers })
              }
            />
          ) : null}
          {queued.length > 0 ? (
            <QueuedMessages
              queued={queued}
              displayName={displayName}
              canSteer={!ended && thread.status !== "starting"}
              waiting={thread.status === "waiting" || waitingCount > 0}
              onSteer={(queueId) => run({ type: "thread.steer", threadId: thread.threadId, queueId })}
              onRemove={(queueId) => run({ type: "thread.queue.remove", threadId: thread.threadId, queueId })}
            />
          ) : null}
          {visibleError ? (
            <p className="inline-error" role="alert">
              {visibleError}
            </p>
          ) : null}
          {ended ? (
            <div className={`chat-ended${thread.status === "failed" ? " is-failed" : ""}`} role="status">
              <Icon name={thread.status === "failed" ? "alert" : "square"} size={13} />
              <span className="chat-ended-copy">
                <span className="chat-ended-title">
                  {thread.status === "failed" ? `${displayName} failed` : `${displayName} session ended`}
                </span>
                <span className="chat-ended-detail">
                  {thread.errorMessage ?? "A new chat starts fresh in the same worktree."}
                </span>
              </span>
              <Button variant="primary" size="sm" icon="plus" onClick={onRestart}>
                New chat
              </Button>
            </div>
          ) : (
            <Composer
              displayName={displayName}
              branch={worktree?.branch ?? "this worktree"}
              disabled={thread.status === "starting"}
              queues={busy}
              models={models}
              model={model}
              modelLocked={thread.capabilities.modelSwitch === "unsupported" && messages.length > 0}
              onModelChange={setModel}
              permissionMode={permissionMode}
              onPermissionModeChange={permissionSwitch ? setPermissionMode : undefined}
              projectId={worktree?.projectId}
              context={context}
              onSubmit={send}
            />
          )}
          {peers.length > 0 && selectedPeerId && !ended ? (
            <details className="chat-peer">
              <summary>
                <Icon name="chevronRight" size={12} />
                Message another agent in this project
              </summary>
              <form
                aria-label="Send to another agent"
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendToPeer();
                }}
              >
                <Select
                  className="input-sm"
                  aria-label="Another thread in this project"
                  value={selectedPeerId}
                  onChange={(event) => setPeerTargetId(event.target.value)}
                >
                  {peers.map((peer) => (
                    <option key={peer.threadId} value={peer.threadId}>
                      {peerOptionLabel(projection, peer.threadId)}
                    </option>
                  ))}
                </Select>
                <textarea
                  className="textarea"
                  value={peerDraft}
                  onChange={(event) => setPeerDraft(event.target.value)}
                  placeholder="Message for that agent"
                  aria-label="Message for the other agent"
                  rows={2}
                />
                <Button size="sm" type="submit" disabled={!peerDraft.trim()}>
                  Send to agent
                </Button>
              </form>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function QueuedMessages({
  queued,
  displayName,
  canSteer,
  waiting,
  onSteer,
  onRemove,
}: {
  queued: readonly ThreadQueuedMessage[];
  displayName: string;
  canSteer: boolean;
  waiting: boolean;
  onSteer(queueId: string): void;
  onRemove(queueId: string): void;
}) {
  return (
    <section className="chat-queue" aria-label="Queued messages">
      <p className="chat-queue-head">
        {queued.length === 1 ? "1 queued message" : `${queued.length} queued messages`}
        <span>{canSteer ? `Sent in order after ${displayName}'s current turn` : "Not sent"}</span>
      </p>
      <ol className="chat-queue-list">
        {queued.map((message, index) => {
          const preview = message.text.trim().split(/\r?\n/u)[0] ?? "";
          const files = message.attachments ?? [];
          const onlyImages = files.every((file) => file.mimeType !== "text/plain");
          return (
            <li className="chat-queue-item" key={message.queueId}>
              <span className="chat-queue-index" aria-hidden="true">
                {index + 1}
              </span>
              <span className="chat-queue-text" title={message.text}>
                {preview}
              </span>
              {files.length > 0 ? (
                <span className="chat-queue-meta" title={files.map((file) => file.name).join(", ")}>
                  <Icon name={onlyImages ? "image" : "paperclip"} size={11} />
                  {files.length}
                  <span className="sr-only">{files.length === 1 ? " attachment" : " attachments"}</span>
                </span>
              ) : null}
              {canSteer ? (
                <Button
                  variant="ghost"
                  size="xs"
                  icon="arrowUp"
                  disabled={waiting}
                  tooltip={
                    waiting
                      ? `Answer ${displayName}'s request first`
                      : `Stop the current turn and send this to ${displayName} now`
                  }
                  aria-label={`Send now: ${preview}`}
                  onClick={() => onSteer(message.queueId)}
                >
                  Send now
                </Button>
              ) : null}
              <IconButton
                label={`Remove from queue: ${preview}`}
                tooltip="Remove from queue"
                icon="x"
                size="xs"
                iconSize={11}
                onClick={() => onRemove(message.queueId)}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const ChatWork = memo(function ChatWork({
  item,
  running,
  showChangedFiles,
  onOpenDiff,
}: {
  item: Extract<TimelineItem, { kind: "work" }>;
  running: boolean;
  /** Off once the turn has a checkpoint, which lists the same files with their real diff. */
  showChangedFiles: boolean;
  onOpenDiff(path?: string): void;
}) {
  return (
    <div className="chat-work">
      <WorkLog activities={item.activities} running={running} />
      {showChangedFiles && item.changedFiles.length > 0 ? (
        <ChangedFiles files={item.changedFiles} onOpenDiff={onOpenDiff} />
      ) : null}
    </div>
  );
});

/**
 * Each turn's changes go after the last timeline item of that turn. A turn with no reply and no
 * tool calls in the timeline, for example one stopped early, has nowhere to go and is listed last.
 */
export function placeCheckpoints(
  timeline: readonly TimelineItem[],
  checkpoints: readonly ThreadCheckpoint[],
): { after: Map<number, ThreadCheckpoint[]>; unplaced: ThreadCheckpoint[]; turns: Set<string> } {
  const lastIndex = new Map<string, number>();
  timeline.forEach((item, index) => {
    const turnId = item.kind === "work" ? item.turnId : item.message.turnId;
    if (turnId) lastIndex.set(turnId, index);
  });
  const after = new Map<number, ThreadCheckpoint[]>();
  const unplaced: ThreadCheckpoint[] = [];
  for (const checkpoint of checkpoints) {
    const index = lastIndex.get(checkpoint.turnId);
    if (index === undefined) {
      unplaced.push(checkpoint);
      continue;
    }
    after.set(index, [...(after.get(index) ?? []), checkpoint]);
  }
  return { after, unplaced, turns: new Set(checkpoints.map((checkpoint) => checkpoint.turnId)) };
}

const ChatMessage = memo(function ChatMessage({
  message,
  links,
  source,
}: {
  message: ThreadMessageProjection;
  links: FileLinks | undefined;
  source: string;
}) {
  if (message.role === "user") {
    return (
      <article className="chat-message chat-message-user">
        {message.attachments && message.attachments.length > 0 ? (
          <ul className="chat-attachments">
            {message.attachments.map((attachment) => (
              <li key={attachment.path} title={attachment.path}>
                <Icon name={attachment.mimeType === "text/plain" ? "fileText" : "image"} size={12} />
                {attachment.name}
              </li>
            ))}
          </ul>
        ) : null}
        <p>{message.text}</p>
      </article>
    );
  }
  if (message.role === "agent") {
    return (
      <article className="chat-message chat-message-peer" data-trust="untrusted">
        <span className="chat-message-label">
          <Icon name="message" size={12} />
          {source}
        </span>
        <p>{message.text}</p>
      </article>
    );
  }
  if (message.role === "system") return <p className="chat-system">{message.text}</p>;
  return (
    <article className="chat-message chat-message-assistant">
      <Markdown text={message.text} links={links} />
    </article>
  );
});
function sourceLabel(projection: RuntimeProjection, sourceThreadId: ThreadId | undefined): string {
  const thread = projection.threads.find((candidate) => candidate.threadId === sourceThreadId);
  const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === thread?.worktreeId);
  if (!worktree) return "From another agent";
  return `From another agent, ${worktree.branch}`;
}

function peerOptionLabel(projection: RuntimeProjection, threadId: string): string {
  const thread = projection.threads.find((candidate) => candidate.threadId === threadId);
  const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === thread?.worktreeId);
  const provider = thread ? providerDisplayName(thread.provider, projection.providers) : "Agent";
  return `${provider} in ${worktree?.branch ?? "a worktree"}`;
}
