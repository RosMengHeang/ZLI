import {
  type ListedProviderKind,
  type ProviderDiscovery,
  type RuntimeProjection,
  type ThreadId,
  threadOccupiesWorktree,
  type WorktreeProjection,
} from "@zli-v2/contracts";
import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { isSelectableProvider, listedDiscoveries, preferredProvider, providerDisplayName } from "./providers.js";
import { defaultWorktreeForNewAgent } from "./worktreeChoice.js";

export function AgentPane({
  projection,
  worktree,
  onSelectWorktree,
  onCreateWorktree,
}: {
  projection: RuntimeProjection;
  worktree: WorktreeProjection | undefined;
  onSelectWorktree?(worktree: WorktreeProjection): void;
  onCreateWorktree?(): void;
}) {
  const { dispatch } = useRuntime();
  const [draft, setDraft] = useState("");
  const [peerDraft, setPeerDraft] = useState("");
  const [peerTargetId, setPeerTargetId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [answers, setAnswers] = useState("{}");
  const [providerChoice, setProviderChoice] = useState<ListedProviderKind>();
  const [sharePrompt, setSharePrompt] = useState<{ worktreeId: string; provider: ListedProviderKind } | null>(null);
  const shareConfirmRef = useRef<HTMLButtonElement>(null);
  const listed = useMemo(() => listedDiscoveries(projection.providers), [projection.providers]);
  const runningHere = projection.threads
    .filter((candidate) => candidate.worktreeId === worktree?.worktreeId && threadOccupiesWorktree(candidate.status))
    .map((candidate) => candidate.provider)
    .find(
      (provider): provider is ListedProviderKind =>
        isSelectableProvider(provider) && listed.some((entry) => entry.provider === provider),
    );
  const selectedKind =
    providerChoice && listed.some((entry) => entry.provider === providerChoice)
      ? providerChoice
      : (runningHere ?? preferredProvider(listed));
  const selected = listed.find((entry) => entry.provider === selectedKind);
  const thread = projection.threads.findLast(
    (candidate) => candidate.worktreeId === worktree?.worktreeId && candidate.provider === selectedKind,
  );
  const threadEnded = thread?.status === "stopped" || thread?.status === "failed";
  const threadLive = thread !== undefined && !threadEnded && thread.status !== "starting";
  const discoveryError = selected?.status === "missing" ? selected.reason : undefined;
  const request = projection.requests?.find((candidate) => candidate.threadId === thread?.threadId);
  const messages = useMemo(
    () => (projection.messages ?? []).filter((message) => message.threadId === thread?.threadId),
    [projection.messages, thread?.threadId],
  );
  const peers = useMemo(() => {
    if (!worktree || !thread) return [];
    return projection.threads.filter((candidate) => {
      if (candidate.threadId === thread.threadId) return false;
      const peerWorktree = projection.worktrees.find((item) => item.worktreeId === candidate.worktreeId);
      return peerWorktree?.projectId === worktree.projectId;
    });
  }, [projection.threads, projection.worktrees, thread, worktree]);
  const selectedPeerId = peers.some((peer) => peer.threadId === peerTargetId) ? peerTargetId : peers[0]?.threadId;
  const displayName = selected?.displayName ?? (selectedKind ? providerDisplayName(selectedKind, listed) : "Agent");
  const placement = defaultWorktreeForNewAgent(projection, worktree);
  const occupants = useMemo(() => {
    if (!worktree) return [];
    return projection.threads.filter(
      (candidate) => candidate.worktreeId === worktree.worktreeId && threadOccupiesWorktree(candidate.status),
    );
  }, [projection.threads, worktree]);
  const occupantLabel = occupants
    .map((candidate) => providerDisplayName(candidate.provider, projection.providers))
    .filter((name, index, names) => names.indexOf(name) === index)
    .join(", ");
  const confirmShare =
    sharePrompt !== null && sharePrompt.worktreeId === worktree?.worktreeId && sharePrompt.provider === selectedKind;

  useEffect(() => {
    if (!confirmShare) return;
    shareConfirmRef.current?.focus();
  }, [confirmShare]);

  const startOn = async (target: WorktreeProjection, share: boolean) => {
    if (selected?.status !== "found") return;
    setBusy(true);
    setError(undefined);
    try {
      if (worktree && target.worktreeId !== worktree.worktreeId) onSelectWorktree?.(target);
      const response = await dispatch({
        protocolVersion: 1,
        commandId: makeCommandId(),
        command: {
          type: "thread.start",
          threadId: makeCommandId(),
          worktreeId: target.worktreeId,
          provider: selected.provider,
          cwd: target.path,
          ...(share ? { shareWorktree: true } : {}),
        },
      });
      if (response?.accepted === false) setError(response.error.message);
      else setSharePrompt(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The agent could not start.");
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!worktree || !selected || placement.mode === "missing") return;
    if (placement.mode === "create") {
      onCreateWorktree?.();
      return;
    }
    const target = placement.mode === "free" ? placement.worktree : worktree;
    await startOn(target, false);
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!thread || !draft.trim() || thread.status === "starting" || thread.status === "stopped") return;
    const text = draft.trim();
    setDraft("");
    setError(undefined);
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "thread.send", threadId: thread.threadId, text },
    });
    if (response?.accepted === false) {
      setDraft(text);
      setError(response.error.message);
    }
  };

  const sendToThread = async (event: FormEvent) => {
    event.preventDefault();
    if (!thread || !selectedPeerId || !peerDraft.trim()) return;
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

  const respond = async (decision: unknown) => {
    if (!thread || !request) return;
    setError(undefined);
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "thread.respond", threadId: thread.threadId, requestId: request.requestId, decision },
    });
    if (response?.accepted === false) setError(response.error.message);
  };

  const submitAnswers = async () => {
    if (!thread || !request) return;
    try {
      const parsed = JSON.parse(answers) as unknown;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((value) => typeof value !== "string")
      )
        throw new Error("Answers must be a JSON object of strings.");
      setError(undefined);
      const response = await dispatch({
        protocolVersion: 1,
        commandId: makeCommandId(),
        command: {
          type: "thread.user-input",
          threadId: thread.threadId,
          requestId: request.requestId,
          answers: parsed,
        },
      });
      if (response?.accepted === false) setError(response.error.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Answers must be a JSON object of strings.");
    }
  };

  const control = async (command: "thread.interrupt" | "thread.stop") => {
    if (!thread) return;
    setError(undefined);
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command:
        command === "thread.interrupt"
          ? {
              type: "thread.interrupt",
              threadId: thread.threadId,
              ...(thread.activeTurnId ? { turnId: thread.activeTurnId } : {}),
            }
          : { type: "thread.stop", threadId: thread.threadId },
    });
    if (response?.accepted === false) setError(response.error.message);
  };

  const visibleError = error ?? discoveryError ?? (threadEnded ? thread?.errorMessage : undefined);
  const statusLabel =
    thread && discoveryError && (thread.status === "starting" || thread.status === "failed")
      ? "CLI missing"
      : (thread?.status ?? "Idle");

  return (
    <div className="tool-pane agent-pane">
      <div className="agent-toolbar">
        <ProviderPicker
          discoveries={projection.providers}
          listed={listed}
          selected={selectedKind}
          onSelect={setProviderChoice}
        />
        <span className={`agent-state status-text-${thread?.status ?? "none"}`}>{statusLabel}</span>
        {thread && threadLive ? (
          <span className="agent-controls">
            {thread.status === "working" || thread.status === "waiting" ? (
              <button className="secondary-button" type="button" onClick={() => void control("thread.interrupt")}>
                Interrupt
              </button>
            ) : null}
            <button className="secondary-button" type="button" onClick={() => void control("thread.stop")}>
              Stop
            </button>
          </span>
        ) : null}
      </div>
      <p className="provider-picker-note">
        {placement.mode === "current" || placement.mode === "missing"
          ? "Changing the agent starts a new thread in this worktree. It does not continue the other agent's session."
          : `${occupantSentence(occupantLabel, occupants.length)} already using this worktree. A new agent gets its own worktree. It does not continue the session already here.`}
      </p>
      {!worktree ? (
        <EmptyAgent title="Select a worktree" detail="Agent sessions are isolated to the selected worktree." />
      ) : !thread ? (
        <div className="empty-pane">
          {projection.providers === undefined ? (
            <>
              <p className="empty-title">Checking agent CLIs</p>
              <p className="empty-detail">
                Installed agents show up here when discovery finishes. Nothing is starting.
              </p>
            </>
          ) : !selected ? (
            <>
              <p className="empty-title">No agent CLIs listed</p>
              <p className="empty-detail">Codex, Claude Code, Cursor, and Droid could not be listed.</p>
            </>
          ) : (
            <>
              <p className="empty-title">No {displayName} session</p>
              <p className="empty-detail">
                {startDetail(displayName, worktree.branch, occupantLabel, occupants.length, placement)}
              </p>
              {confirmShare ? (
                <fieldset
                  className="agent-request agent-share"
                  aria-label="Confirm shared worktree"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      setSharePrompt(null);
                    }
                  }}
                >
                  <p className="empty-detail">
                    Share {worktree.branch} with {displayName}? The agent already here keeps running in this worktree
                    too.
                  </p>
                  <div className="agent-share-actions">
                    <button
                      className="primary-button"
                      type="button"
                      ref={shareConfirmRef}
                      onClick={() => void startOn(worktree, true)}
                      disabled={busy || selected.status !== "found"}
                    >
                      {busy ? "Starting" : "Share worktree"}
                    </button>
                    <button className="secondary-button" type="button" onClick={() => setSharePrompt(null)}>
                      Cancel
                    </button>
                  </div>
                </fieldset>
              ) : (
                <div className="agent-share-actions">
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => void start()}
                    disabled={primaryDisabled(placement.mode, busy, selected.status !== "found", onCreateWorktree)}
                  >
                    {primaryLabel(busy, displayName, placement)}
                  </button>
                  {placement.mode !== "current" ? (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => {
                        if (selectedKind) setSharePrompt({ worktreeId: worktree.worktreeId, provider: selectedKind });
                      }}
                      disabled={selected.status !== "found"}
                    >
                      Share this worktree
                    </button>
                  ) : null}
                </div>
              )}
            </>
          )}
          {visibleError && (
            <p className="inline-error" role="alert">
              {visibleError}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="agent-messages" role="log" aria-label="Agent conversation">
            {messages.length === 0 ? (
              <p className="agent-empty">Send a task to begin.</p>
            ) : (
              messages.map((message) =>
                message.role === "agent" ? (
                  <article className="agent-message" data-trust="untrusted" key={message.messageId}>
                    <span className="pane-meta">{sourceLabel(projection, message.sourceThreadId)}</span>
                    <p>{message.text}</p>
                  </article>
                ) : (
                  <article className={`agent-message agent-message-${message.role}`} key={message.messageId}>
                    <span className="agent-message-role">{message.role}</span>
                    <p>{message.text}</p>
                  </article>
                ),
              )
            )}
          </div>
          {request && (
            <section
              className="agent-request"
              aria-label={request.kind === "approval" ? "Approval request" : "User input request"}
            >
              <span className="agent-message-role">
                {request.kind === "approval" ? "Approval required" : "Input required"}
              </span>
              <pre>{JSON.stringify(request.payload, null, 2)}</pre>
              {request.kind === "approval" ? (
                <div className="agent-request-actions">
                  <button className="primary-button" type="button" onClick={() => void respond({ approved: true })}>
                    Approve
                  </button>
                  <button className="secondary-button" type="button" onClick={() => void respond({ approved: false })}>
                    Reject
                  </button>
                </div>
              ) : (
                <>
                  <textarea
                    value={answers}
                    onChange={(event) => setAnswers(event.target.value)}
                    aria-label="Structured user input answers"
                    rows={3}
                  />
                  <button className="primary-button" type="button" onClick={() => void submitAnswers()}>
                    Submit answers
                  </button>
                </>
              )}
            </section>
          )}
          {visibleError && (
            <p className="inline-error" role="alert">
              {visibleError}
            </p>
          )}
          {threadEnded ? (
            <div className="agent-ended">
              <span className="pane-meta">
                {thread.status === "failed" ? `${displayName} failed.` : `${displayName} session ended.`} Starting again
                opens a new thread in this worktree.
              </span>
              <button
                className="primary-button"
                type="button"
                onClick={() => void start()}
                disabled={busy || selected?.status !== "found" || placement.mode === "missing"}
              >
                {busy ? "Starting" : "New thread"}
              </button>
            </div>
          ) : null}
          <form className="agent-composer" onSubmit={(event) => void send(event)}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={`Ask ${displayName} to change this worktree`}
              aria-label={`Message ${displayName}`}
              rows={3}
            />
            <div className="agent-composer-footer">
              <span className="pane-meta">
                {displayName} · {thread.status}
                <span className="composer-hint"> · Enter to send, Shift+Enter for a new line</span>
              </span>
              <button
                className="primary-button"
                type="submit"
                disabled={!draft.trim() || thread.status === "starting" || thread.status === "stopped"}
              >
                Send
              </button>
            </div>
          </form>
          {peers.length > 0 && selectedPeerId && (
            <details className="agent-peer-wrap">
              <summary>Message another agent in this project</summary>
              <form
                className="agent-peer"
                aria-label="Send to another agent"
                onSubmit={(event) => void sendToThread(event)}
              >
                <label className="pane-meta agent-peer-label" htmlFor="agent-peer-target">
                  Another thread in this project
                </label>
                <select
                  id="agent-peer-target"
                  className="agent-peer-target"
                  value={selectedPeerId}
                  onChange={(event) => setPeerTargetId(event.target.value)}
                >
                  {peers.map((peer) => (
                    <option key={peer.threadId} value={peer.threadId}>
                      {peerOptionLabel(projection, peer.threadId)}
                    </option>
                  ))}
                </select>
                <textarea
                  value={peerDraft}
                  onChange={(event) => setPeerDraft(event.target.value)}
                  placeholder="Message for that thread"
                  aria-label="Message for the other agent"
                  rows={2}
                />
                <div className="agent-composer-footer">
                  <span className="pane-meta">Stays in this project</span>
                  <button className="secondary-button" type="submit" disabled={!peerDraft.trim()}>
                    Send to thread
                  </button>
                </div>
              </form>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function occupantSentence(label: string, count: number): string {
  if (!label) return "Another agent is";
  return count > 1 ? `${label} are` : `${label} is`;
}

function startDetail(
  displayName: string,
  branch: string,
  occupantLabel: string,
  occupantCount: number,
  placement: ReturnType<typeof defaultWorktreeForNewAgent>,
): string {
  const who = occupantSentence(occupantLabel, occupantCount);
  if (placement.mode === "free") {
    return `${who} already using ${branch}. Start ${displayName} in ${placement.worktree.branch} instead.`;
  }
  if (placement.mode === "create") {
    return `${who} already using ${branch}. Create a worktree, then start ${displayName} there.`;
  }
  return "Start a new thread in this worktree. The session uses this worktree as its working directory.";
}

function primaryLabel(
  busy: boolean,
  displayName: string,
  placement: ReturnType<typeof defaultWorktreeForNewAgent>,
): string {
  if (placement.mode === "create") return "Create worktree";
  if (busy) return "Starting";
  if (placement.mode === "free") return `Start ${displayName} in ${placement.worktree.branch}`;
  return `Start ${displayName}`;
}

function primaryDisabled(
  mode: ReturnType<typeof defaultWorktreeForNewAgent>["mode"],
  busy: boolean,
  providerMissing: boolean,
  onCreateWorktree: (() => void) | undefined,
): boolean {
  if (providerMissing) return true;
  if (mode === "create") return !onCreateWorktree;
  return busy;
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
  const branch = worktree?.branch ?? "thread";
  const provider = thread?.provider ?? "agent";
  return `${branch} (${provider})`;
}

function ProviderPicker({
  discoveries,
  listed,
  selected,
  onSelect,
}: {
  discoveries: readonly ProviderDiscovery[] | undefined;
  listed: readonly ProviderDiscovery[];
  selected: ListedProviderKind | undefined;
  onSelect(provider: ListedProviderKind): void;
}) {
  if (discoveries === undefined) return null;
  if (listed.length === 0) return null;
  return (
    <fieldset className="provider-picker">
      <legend className="pane-meta">Which agent</legend>
      <div className="provider-options" role="radiogroup" aria-label="Installed agent CLIs">
        {listed.map((provider) => {
          const detail =
            provider.status === "found"
              ? provider.version
                ? `${provider.path} (${provider.version})`
                : provider.path
              : provider.reason;
          return (
            <label className={`provider-option is-${provider.status}`} key={provider.provider} title={detail}>
              <input
                type="radio"
                name="worktree-agent"
                value={provider.provider}
                checked={selected === provider.provider}
                onChange={() => onSelect(provider.provider)}
              />
              <span className="provider-option-copy">
                <span className="pane-meta">
                  {provider.displayName}: {provider.status === "found" ? "found" : "not found"}
                </span>
                <span className="provider-availability-detail">{detail}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function EmptyAgent({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-pane">
      <p className="empty-title">{title}</p>
      <p className="empty-detail">{detail}</p>
    </div>
  );
}
