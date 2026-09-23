import type { ListedProviderKind, ProviderDiscovery, RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { listedDiscoveries, preferredProvider, providerDisplayName } from "./providers.js";

export function AgentPane({
  projection,
  worktree,
}: {
  projection: RuntimeProjection;
  worktree: WorktreeProjection | undefined;
}) {
  const { dispatch } = useRuntime();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [answers, setAnswers] = useState("{}");
  const [providerChoice, setProviderChoice] = useState<ListedProviderKind>();
  const listed = useMemo(() => listedDiscoveries(projection.providers), [projection.providers]);
  const selectedKind =
    providerChoice && listed.some((entry) => entry.provider === providerChoice)
      ? providerChoice
      : preferredProvider(listed);
  const selected = listed.find((entry) => entry.provider === selectedKind);
  const thread = projection.threads.find(
    (candidate) => candidate.worktreeId === worktree?.worktreeId && candidate.provider === selectedKind,
  );
  const discoveryError = selected?.status === "missing" ? selected.reason : undefined;
  const request = projection.requests?.find((candidate) => candidate.threadId === thread?.threadId);
  const messages = useMemo(
    () => (projection.messages ?? []).filter((message) => message.threadId === thread?.threadId),
    [projection.messages, thread?.threadId],
  );
  const displayName = selected?.displayName ?? (selectedKind ? providerDisplayName(selectedKind, listed) : "Agent");

  const start = async () => {
    if (!worktree || !selected || selected.status !== "found") return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await dispatch({
        protocolVersion: 1,
        commandId: makeCommandId(),
        command: {
          type: "thread.start",
          threadId: makeCommandId(),
          worktreeId: worktree.worktreeId,
          provider: selected.provider,
          cwd: worktree.path,
        },
      });
      if (response?.accepted === false) setError(response.error.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The agent could not start.");
    } finally {
      setBusy(false);
    }
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!thread || !draft.trim() || thread.status === "starting") return;
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

  const visibleError = error ?? discoveryError ?? (thread?.status === "failed" ? thread.errorMessage : undefined);
  const statusLabel =
    thread && discoveryError && (thread.status === "starting" || thread.status === "failed")
      ? "CLI missing"
      : (thread?.status ?? "Idle");

  return (
    <div className="tool-pane agent-pane">
      <div className="tool-pane-header">
        <div>
          <span className="eyebrow">Agent</span>
          <h2>{worktree?.branch ?? "No worktree selected"}</h2>
        </div>
        <span className="pane-meta">{statusLabel}</span>
      </div>
      <ProviderPicker
        discoveries={projection.providers}
        listed={listed}
        selected={selectedKind}
        onSelect={setProviderChoice}
      />
      <p className="provider-picker-note">
        Changing the agent starts a new thread in this worktree. It does not continue the other agent's session.
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
              <p className="empty-detail">Codex, Claude Code, and Cursor could not be listed.</p>
            </>
          ) : (
            <>
              <p className="empty-title">No {displayName} session</p>
              <p className="empty-detail">
                Start a new thread in this worktree. The session uses this worktree as its working directory.
              </p>
              <button
                className="primary-button"
                type="button"
                onClick={() => void start()}
                disabled={busy || selected.status !== "found"}
              >
                {busy ? "Starting" : `Start ${displayName}`}
              </button>
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
              messages.map((message) => (
                <article className={"agent-message agent-message-" + message.role} key={message.messageId}>
                  <span className="agent-message-role">{message.role}</span>
                  <p>{message.text}</p>
                </article>
              ))
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
          <form className="agent-composer" onSubmit={(event) => void send(event)}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={`Ask ${displayName} to change this worktree…`}
              aria-label={`Message ${displayName}`}
              rows={3}
            />
            <div className="agent-composer-footer">
              <span className="pane-meta">
                {displayName} · {thread.status}
              </span>
              <button className="primary-button" type="submit" disabled={!draft.trim() || thread.status === "starting"}>
                Send
              </button>
            </div>
          </form>
          {visibleError && (
            <p className="inline-error" role="alert">
              {visibleError}
            </p>
          )}
        </>
      )}
    </div>
  );
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
            <label className="provider-option" key={provider.provider}>
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
