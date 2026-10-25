import type { AttachmentMimeType, RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime, useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { deriveSessions, type SessionMode, sessionStatusLabel, sessionTitle } from "../sessions/sessions.js";
import { readBracketedPaste } from "../terminal/terminalModes.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
import { terminalPaste } from "./reviewComments.js";
import "./review.css";

/** A file sent along with the message; only chat agents receive these. */
export type SendAttachment = { name: string; mimeType: AttachmentMimeType; dataBase64: string };

export type SendTarget = {
  key: string;
  sessionId: string;
  mode: SessionMode;
  title: string;
  detail: string;
  updatedAt: string;
} & ({ mode: "chat"; threadId: string } | { mode: "terminal"; terminalId: string });

/** Agents in the worktree that can take a message now, the most recently active first. */
export function sendTargets(projection: RuntimeProjection, worktreeId: string): SendTarget[] {
  const targets: SendTarget[] = [];
  for (const session of deriveSessions(projection)) {
    if (session.worktreeId !== worktreeId) continue;
    const title = sessionTitle(session, projection.messages, projection.providers);
    const name = providerDisplayName(session.provider, projection.providers);
    const status = sessionStatusLabel[session.status];
    const { thread, terminal } = session;
    if (thread && (thread.status === "idle" || thread.status === "working" || thread.status === "waiting")) {
      targets.push({
        key: `${session.sessionId}:chat`,
        sessionId: session.sessionId,
        mode: "chat",
        threadId: thread.threadId,
        title,
        detail: `${name} chat · ${status}`,
        updatedAt: thread.updatedAt ?? thread.createdAt ?? "",
      });
    }
    if (terminal?.status === "running") {
      targets.push({
        key: `${session.sessionId}:terminal`,
        sessionId: session.sessionId,
        mode: "terminal",
        terminalId: terminal.terminalId,
        title,
        detail: `${name} terminal · ${status}`,
        updatedAt: terminal.updatedAt ?? terminal.createdAt ?? "",
      });
    }
  }
  return targets.sort((left, right) =>
    left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0,
  );
}

const selectProjection = (projection: RuntimeProjection | undefined) => projection;

/** Picks an agent working in the worktree and sends it a message, as chat input or a terminal paste. */
export function SendToAgentDialog({
  label,
  title,
  worktree,
  message,
  attachments = [],
  preparing,
  notice,
  noAgentMessage,
  onSent,
  onClose,
  onShowAgent,
}: {
  label: string;
  title: string;
  worktree: WorktreeProjection;
  message: string;
  attachments?: readonly SendAttachment[] | undefined;
  /** Shown in place of the preview while the message is still being put together. */
  preparing?: string | undefined;
  /** Something the person should know about the message before sending it. */
  notice?: ReactNode;
  noAgentMessage: string;
  onSent?(): void;
  onClose(): void;
  onShowAgent?: ((sessionId: string, mode: SessionMode) => void) | undefined;
}) {
  const { dispatch } = useRuntime();
  const projection = useRuntimeSelector(selectProjection);
  const targets = useMemo(
    () => (projection ? sendTargets(projection, worktree.worktreeId) : []),
    [projection, worktree.worktreeId],
  );
  const [choice, setChoice] = useState<string>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const selected = targets.find((target) => target.key === choice) ?? targets[0];
  const ready = !!selected && !preparing;

  const send = async () => {
    if (!selected || !ready || sending) return;
    setSending(true);
    setError(undefined);
    try {
      let command: Record<string, unknown>;
      if (selected.mode === "chat") {
        command = {
          type: "thread.queue",
          queueId: makeCommandId(),
          threadId: selected.threadId,
          text: message,
          ...(attachments.length > 0 ? { attachments } : {}),
        };
      } else {
        // Showing the terminal mounts its view, which knows whether the program reads bracketed paste.
        onShowAgent?.(selected.sessionId, "terminal");
        const bracketed = await readBracketedPaste(selected.terminalId);
        command = {
          type: "terminal.write",
          terminalId: selected.terminalId,
          data: terminalPaste(message, !!bracketed),
        };
      }
      const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
      if (response?.accepted === false) {
        setError(response.error.message);
        return;
      }
      onSent?.();
      onClose();
      onShowAgent?.(selected.sessionId, selected.mode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The message could not be sent.");
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void send();
    } else if (event.key === "Escape" && !sending) {
      onClose();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the shortcuts apply anywhere inside the dialog.
    <div onKeyDown={onKeyDown}>
      <Dialog
        label={label}
        className="send-comments-dialog"
        title={title}
        subtitle={
          <>
            to an agent working in <span className="is-mono">{worktree.branch}</span>
          </>
        }
        onClose={() => {
          if (!sending) onClose();
        }}
      >
        <div className="dialog-body">
          {targets.length === 0 ? (
            <div className="banner banner-warning" role="alert">
              <Icon name="alert" size={14} />
              <span className="banner-message">{noAgentMessage}</span>
            </div>
          ) : (
            <fieldset className="field">
              <legend className="field-label">Agent</legend>
              <div className="send-targets" role="radiogroup" aria-label="Agent">
                {targets.map((target) => (
                  <label className="choice-card is-compact" key={target.key}>
                    <input
                      type="radio"
                      name="send-target"
                      checked={selected?.key === target.key}
                      onChange={() => setChoice(target.key)}
                    />
                    <Icon name={target.mode === "chat" ? "message" : "terminal"} size={15} />
                    <span className="choice-copy">
                      <span className="choice-title">{target.title}</span>
                      <span className="choice-detail">{target.detail}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {notice ? (
            <div className="banner banner-info" role="status">
              <Icon name="alert" size={14} />
              <span className="banner-message">{notice}</span>
            </div>
          ) : null}
          <div className="field">
            <span className="field-label">Message</span>
            {preparing ? (
              <p className="send-preview send-preview-loading" role="status">
                <span className="spinner" aria-hidden="true" />
                {preparing}
              </p>
            ) : (
              // biome-ignore lint/a11y/noNoninteractiveTabindex: the preview scrolls, so it needs to take focus for the keyboard.
              <section className="send-preview" tabIndex={0} aria-label="Message preview">
                <pre>{message}</pre>
              </section>
            )}
          </div>
          {error ? (
            <p className="inline-error pr-error" role="alert">
              <Icon name="alert" size={13} />
              <span>{error}</span>
            </p>
          ) : null}
        </div>
        <div className="dialog-footer">
          <span className="dialog-footer-note">
            {selected?.mode === "terminal"
              ? attachments.length > 0
                ? "Pasted at the agent's prompt without the images, which only chat agents receive."
                : "Pasted at the agent's prompt without pressing Enter, so you can read it first."
              : selected
                ? attachments.length > 0
                  ? `Sent as a chat message with ${attachments.length} image${attachments.length === 1 ? "" : "s"}.`
                  : "Sent as a chat message."
                : ""}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={selected?.mode === "terminal" ? "terminal" : "message"}
            loading={sending}
            disabled={!ready}
            shortcut="Mod+Enter"
            onClick={() => void send()}
          >
            {selected?.mode === "terminal" ? "Paste in terminal" : "Send"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
