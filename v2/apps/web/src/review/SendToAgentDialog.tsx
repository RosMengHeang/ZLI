import type { RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";

import { useRuntime, useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import type { SessionMode } from "../sessions/sessions.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Icon } from "../ui/Icon.js";
import {
  deliverToAgent,
  lastSendTarget,
  rememberSendTarget,
  type SendAttachment,
  type SendTarget,
  sendTargets,
} from "./sendToAgent.js";
import "./review.css";

const selectProjection = (projection: RuntimeProjection | undefined) => projection;

/** The agents in the worktree that can take a message now, kept current with the runtime. */
export function useSendTargets(worktreeId: string): SendTarget[] {
  const projection = useRuntimeSelector(selectProjection);
  return useMemo(() => (projection ? sendTargets(projection, worktreeId) : []), [projection, worktreeId]);
}

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
  initialTarget,
  initialError,
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
  /** The agent picked when the dialog opens; without it, the one the worktree's last message went to. */
  initialTarget?: string | undefined;
  /** Why a send started outside the dialog failed. */
  initialError?: string | undefined;
  onSent?: ((target: SendTarget) => void) | undefined;
  onClose(): void;
  onShowAgent?: ((sessionId: string, mode: SessionMode) => void) | undefined;
}) {
  const { dispatch } = useRuntime();
  const targets = useSendTargets(worktree.worktreeId);
  const [choice, setChoice] = useState(() => initialTarget ?? lastSendTarget(worktree.worktreeId));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(initialError);
  const selected = targets.find((target) => target.key === choice) ?? targets[0];
  const ready = !!selected && !preparing;

  const send = async () => {
    if (!selected || !ready || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await deliverToAgent({ dispatch, target: selected, message, attachments, onShowAgent });
      rememberSendTarget(worktree.worktreeId, selected.key);
      onSent?.(selected);
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
