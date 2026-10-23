import type { ListedProviderKind, RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { type KeyboardEvent, useId, useMemo, useRef, useState } from "react";

import { listedDiscoveries, providerDisplayName } from "../agent/providers.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { Switch } from "../ui/Switch.js";
import { type HandoffMessage, handoffMessage } from "./handoff.js";
import { LaunchRow } from "./NewAgentDialog.js";
import { type AgentSession, type SessionMode, sessionStopCommands, sessionTitle } from "./sessions.js";

export type HandoffRequest = {
  provider: ListedProviderKind;
  mode: SessionMode;
  message: HandoffMessage;
  /** Stop the current agent and close its tile, so only one agent edits the files. */
  stopCurrent: boolean;
};

/** Hands a chat to another agent: a new session in the same worktree that starts from the conversation. */
export function HandoffDialog({
  projection,
  session,
  worktree,
  onClose,
  onSubmit,
}: {
  projection: RuntimeProjection;
  session: AgentSession;
  worktree: WorktreeProjection;
  onClose(): void;
  onSubmit(request: HandoffRequest): Promise<string | undefined>;
}) {
  const fromName = providerDisplayName(session.provider, projection.providers);
  const installed = useMemo(
    () => listedDiscoveries(projection.providers).filter((entry) => entry.status === "found"),
    [projection.providers],
  );
  const [provider, setProvider] = useState<ListedProviderKind | undefined>(
    () => (installed.find((entry) => entry.provider !== session.provider) ?? installed[0])?.provider,
  );
  const [mode, setMode] = useState<SessionMode>("chat");
  const [note, setNote] = useState("");
  const canStop = sessionStopCommands(session).length > 0;
  const [stopCurrent, setStopCurrent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submitting = useRef(false);
  const noteId = useId();
  const threadId = session.thread?.threadId;
  const messages = useMemo(
    () => (threadId ? (projection.messages ?? []).filter((message) => message.threadId === threadId) : []),
    [projection.messages, threadId],
  );
  const message = useMemo(
    () =>
      handoffMessage({
        title: sessionTitle(session, projection.messages, projection.providers),
        fromName,
        branch: worktree.branch,
        messages,
        note,
      }),
    [session, projection.messages, projection.providers, fromName, worktree.branch, messages, note],
  );
  const toName = provider ? providerDisplayName(provider, projection.providers) : "another agent";

  const submit = async () => {
    if (!provider || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const failure = await onSubmit({ provider, mode, message, stopCurrent: canStop && stopCurrent });
      if (failure) setError(failure);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The new agent could not start.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const carried = message.included === 1 ? "1 message" : `${message.included.toLocaleString()} messages`;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the shortcut applies anywhere inside the dialog.
    <div onKeyDown={onKeyDown}>
      <Dialog
        label="Continue with another agent"
        title="Continue with another agent"
        subtitle={
          <>
            Picks up from {fromName} in <span className="is-mono">{worktree.branch}</span>
          </>
        }
        className="handoff-dialog"
        onClose={() => {
          if (!busy) onClose();
        }}
      >
        <div className="dialog-body">
          <div className="launch-rows">
            <LaunchRow label="Agent">
              {installed.length === 0 ? (
                <p className="field-hint">No agent CLIs are installed.</p>
              ) : (
                <div className="chip-group" role="radiogroup" aria-label="Agent">
                  {installed.map((entry) => (
                    <label className="chip-choice" key={entry.provider} title={entry.path}>
                      <input
                        type="radio"
                        name="handoff-provider"
                        checked={provider === entry.provider}
                        onChange={() => setProvider(entry.provider)}
                      />
                      <ProviderMark provider={entry.provider} size={14} />
                      <span>{entry.displayName}</span>
                    </label>
                  ))}
                </div>
              )}
            </LaunchRow>
            <LaunchRow label="Work in">
              <div className="chip-group" role="radiogroup" aria-label="Mode">
                <label className="chip-choice" title="Messages with a work log and changed files">
                  <input type="radio" name="handoff-mode" checked={mode === "chat"} onChange={() => setMode("chat")} />
                  <Icon name="message" size={13} />
                  <span>Chat</span>
                </label>
                <label className="chip-choice" title="The agent's own CLI, full screen in a tile">
                  <input
                    type="radio"
                    name="handoff-mode"
                    checked={mode === "terminal"}
                    onChange={() => setMode("terminal")}
                  />
                  <Icon name="terminal" size={13} />
                  <span>Terminal</span>
                </label>
              </div>
            </LaunchRow>
          </div>
          <div className="field">
            <label className="field-label" htmlFor={noteId}>
              What to do next
            </label>
            <textarea
              id={noteId}
              className="textarea"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Optional. Without it, the agent reads the conversation and carries on."
            />
          </div>
          <div className="field">
            <span className="field-label">First message</span>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the preview scrolls, so it needs to take focus for the keyboard. */}
            <section className="handoff-preview" tabIndex={0} aria-label="First message preview">
              <pre>{message.text}</pre>
            </section>
            <p className="handoff-file">
              <Icon name="fileText" size={13} />
              <span className="handoff-file-name">{message.transcript.name}</span>
              <span className="handoff-file-meta">
                {message.omitted > 0 ? `${carried}, ${message.omitted.toLocaleString()} older left out` : carried}
              </span>
            </p>
          </div>
          {canStop ? (
            <Switch
              label={`Stop ${fromName} and close its tile`}
              hint="Two agents in one folder edit the same files. The chat stays in the sidebar."
              checked={stopCurrent}
              onChange={setStopCurrent}
            />
          ) : null}
          {error ? (
            <p className="inline-error" role="alert">
              <Icon name="alert" size={13} />
              <span>{error}</span>
            </p>
          ) : null}
        </div>
        <div className="dialog-footer">
          <span className="dialog-footer-note">
            {mode === "chat"
              ? "The conversation goes along as an attached file."
              : "The conversation is pasted after the message."}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="handoff"
            loading={busy}
            disabled={!provider}
            shortcut="Mod+Enter"
            onClick={() => void submit()}
          >
            {busy ? "Starting" : `Continue with ${toName}`}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
