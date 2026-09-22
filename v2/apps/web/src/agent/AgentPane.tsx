import { useMemo, useState } from "react";

import type { RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { makeCommandId } from "../runtime/commandId.js";

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
  const thread = projection.threads.find((candidate) => candidate.worktreeId === worktree?.worktreeId);
  const request = projection.requests?.find((candidate) => candidate.threadId === thread?.threadId);
  const messages = useMemo(
    () => (projection.messages ?? []).filter((message) => message.threadId === thread?.threadId),
    [projection.messages, thread?.threadId],
  );

  const start = async () => {
    if (!worktree) return;
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
          provider: "codex",
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

  const send = async (event: React.FormEvent) => {
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

  return (
    <div className="tool-pane agent-pane">
      <div className="tool-pane-header">
        <div>
          <span className="eyebrow">Agent</span>
          <h2>{worktree?.branch ?? "No worktree selected"}</h2>
        </div>
        <span className="pane-meta">{thread?.status ?? "Idle"}</span>
      </div>
      {!worktree ? (
        <EmptyAgent title="Select a worktree" detail="Agent sessions are isolated to the selected worktree." />
      ) : !thread ? (
        <div className="empty-pane">
          <p className="empty-title">No Codex session</p>
          <p className="empty-detail">Start the structured Codex app-server session for this worktree.</p>
          <button className="primary-button" type="button" onClick={() => void start()} disabled={busy}>
            {busy ? "Starting" : "Start Codex"}
          </button>
          {error && (
            <p className="inline-error" role="alert">
              {error}
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
              placeholder="Ask Codex to change this workspace…"
              aria-label="Message Codex"
              rows={3}
            />
            <div className="agent-composer-footer">
              <span className="pane-meta">
                {thread.provider} · {thread.status}
              </span>
              <button className="primary-button" type="submit" disabled={!draft.trim() || thread.status === "starting"}>
                Send
              </button>
            </div>
          </form>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </div>
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
