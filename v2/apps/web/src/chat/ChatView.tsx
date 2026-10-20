import type { RuntimeProjection, ThreadId, ThreadProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { useFileLinks } from "../files/FileIndex.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { buildTimeline } from "../sessions/sessions.js";
import { Button } from "../ui/Button.js";
import { Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { EmptyState } from "../ui/Pane.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { Composer, type ComposerAttachment } from "./Composer.js";
import { Markdown } from "./Markdown.js";
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
  const [answers, setAnswers] = useState("{}");
  const [model, setModel] = useState<string | undefined>(thread.model);
  const [peerDraft, setPeerDraft] = useState("");
  const [peerTargetId, setPeerTargetId] = useState<string>();
  const logRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const displayName = providerDisplayName(thread.provider, projection.providers);
  const discovery = projection.providers?.find((entry) => entry.provider === thread.provider);
  const models = discovery?.status === "found" ? discovery.models : undefined;
  const messages = useMemo(
    () => (projection.messages ?? []).filter((message) => message.threadId === thread.threadId),
    [projection.messages, thread.threadId],
  );
  const activities = useMemo(
    () => (projection.activities ?? []).filter((activity) => activity.threadId === thread.threadId),
    [projection.activities, thread.threadId],
  );
  const timeline = useMemo(() => buildTimeline(messages, activities), [messages, activities]);
  const fileLinks = useFileLinks(worktree?.worktreeId, messages.length);
  const request = projection.requests?.find((candidate) => candidate.threadId === thread.threadId);
  const ended = thread.status === "stopped" || thread.status === "failed";
  const working = thread.status === "working" || thread.status === "waiting";
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
          type: "thread.send",
          threadId: thread.threadId,
          text,
          ...(model ? { model } : {}),
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

  const submitAnswers = async () => {
    if (!request) return;
    try {
      const parsed = JSON.parse(answers) as unknown;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((value) => typeof value !== "string")
      )
        throw new Error("Answers must be a JSON object of strings.");
      await run({
        type: "thread.user-input",
        threadId: thread.threadId,
        requestId: request.requestId,
        answers: parsed,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Answers must be a JSON object of strings.");
    }
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
            timeline.map((item) => {
              if (item.kind === "work") {
                return (
                  <div className="chat-work" key={`work-${item.turnId}`}>
                    <WorkLog activities={item.activities} running={item.turnId === lastTurnRunning} />
                    {item.changedFiles.length > 0 ? (
                      <ChangedFiles files={item.changedFiles} onOpenDiff={onOpenDiff} />
                    ) : null}
                  </div>
                );
              }
              const message = item.message;
              if (message.role === "user") {
                return (
                  <article className="chat-message chat-message-user" key={message.messageId}>
                    {message.attachments && message.attachments.length > 0 ? (
                      <ul className="chat-attachments">
                        {message.attachments.map((attachment) => (
                          <li key={attachment.path} title={attachment.path}>
                            <Icon name="image" size={12} />
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
                  <article className="chat-message chat-message-peer" data-trust="untrusted" key={message.messageId}>
                    <span className="chat-message-label">
                      <Icon name="message" size={12} />
                      {sourceLabel(projection, message.sourceThreadId)}
                    </span>
                    <p>{message.text}</p>
                  </article>
                );
              }
              if (message.role === "system") {
                return (
                  <p className="chat-system" key={message.messageId}>
                    {message.text}
                  </p>
                );
              }
              return (
                <article className="chat-message chat-message-assistant" key={message.messageId}>
                  <Markdown text={message.text} links={fileLinks} />
                </article>
              );
            })
          )}
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
            <section
              className="chat-request"
              aria-label={request.kind === "approval" ? "Approval request" : "User input request"}
            >
              <span className="chat-request-title">
                <Icon name="alert" size={14} />
                {request.kind === "approval" ? "Approval required" : "Input required"}
              </span>
              <pre>{JSON.stringify(request.payload, null, 2)}</pre>
              {request.kind === "approval" ? (
                <div className="chat-request-actions">
                  <Button
                    variant="primary"
                    size="sm"
                    icon="check"
                    onClick={() =>
                      void run({
                        type: "thread.respond",
                        threadId: thread.threadId,
                        requestId: request.requestId,
                        decision: { approved: true },
                      })
                    }
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      void run({
                        type: "thread.respond",
                        threadId: thread.threadId,
                        requestId: request.requestId,
                        decision: { approved: false },
                      })
                    }
                  >
                    Reject
                  </Button>
                </div>
              ) : (
                <>
                  <textarea
                    className="textarea is-mono"
                    value={answers}
                    onChange={(event) => setAnswers(event.target.value)}
                    aria-label="Structured user input answers"
                    rows={3}
                  />
                  <div className="chat-request-actions">
                    <Button variant="primary" size="sm" onClick={() => void submitAnswers()}>
                      Submit answers
                    </Button>
                  </div>
                </>
              )}
            </section>
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
              models={models}
              model={model}
              modelLocked={thread.capabilities.modelSwitch === "unsupported" && messages.length > 0}
              onModelChange={setModel}
              permissionMode={thread.permissionMode ?? "full-access"}
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
