import type { WorktreeProjection } from "@zli-v2/contracts";
import { type MouseEvent, type ReactNode, useEffect, useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import type { SessionMode } from "../sessions/sessions.js";
import { type ButtonSize, type ButtonVariant, cx } from "../ui/Button.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { Menu, type MenuItem, type MenuRequest } from "../ui/Menu.js";
import { SendToAgentDialog, sendGroupLabel, useSendTargets } from "./SendToAgentDialog.js";
import {
  defaultSendTarget,
  deliverToAgent,
  lastSendTarget,
  messageForTarget,
  type OtherWorktrees,
  rememberSendTarget,
  type SendAttachment,
  type SendTarget,
  sendTargetGroups,
  sentNotice,
} from "./sendToAgent.js";

const GAP = 4;

/** A confirmation for the shell to show, with a way to bring the agent forward. */
export type SentNotice = { message: string; action?: { label: string; run(): void } };

type Props = {
  worktree: WorktreeProjection;
  /** The accessible name of the main button. */
  label: string;
  /** The dialog's accessible name and its title. */
  dialogLabel: string;
  dialogTitle: string;
  message: string;
  attachments?: readonly SendAttachment[] | undefined;
  noAgentMessage: string;
  /** Also offers the agents in the project's other worktrees. One click still only goes to one picked before. */
  otherWorktrees?: OtherWorktrees | undefined;
  disabled?: boolean | undefined;
  /** Why the button is disabled. */
  disabledTooltip?: string | undefined;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName | undefined;
  className?: string | undefined;
  children: ReactNode;
  onSent?: (() => void) | undefined;
  onNotice?: ((notice: SentNotice) => void) | undefined;
  /** Reports when the menu or the dialog opens and closes, for views that must make room for them. */
  onOpenChange?: ((open: boolean) => void) | undefined;
  onShowAgent?: ((sessionId: string, mode: SessionMode) => void) | undefined;
};

/**
 * Sends a message to an agent with one click when it is clear which one should get it: the agent the
 * worktree's last message went to, or the only one running in the worktree. Otherwise, or with Shift held, it
 * opens the dialog to pick the agent and read the message first. The arrow lists the agents and the dialog too.
 */
export function SendToAgentButton({
  worktree,
  label,
  dialogLabel,
  dialogTitle,
  message,
  attachments = [],
  noAgentMessage,
  otherWorktrees,
  disabled = false,
  disabledTooltip,
  variant = "primary",
  size = "sm",
  icon,
  className,
  children,
  onSent,
  onNotice,
  onOpenChange,
  onShowAgent,
}: Props) {
  const { dispatch } = useRuntime();
  const worktreeId = worktree.worktreeId;
  const targets = useSendTargets(worktreeId, { otherWorktrees: !!otherWorktrees });
  const [sending, setSending] = useState(false);
  const [dialog, setDialog] = useState<{ target?: string | undefined; error?: string | undefined }>();
  const [menu, setMenu] = useState<MenuRequest>();
  const target = defaultSendTarget(targets, lastSendTarget(worktreeId), worktreeId);
  const open = !!dialog || !!menu;

  useEffect(() => {
    if (!open) return;
    onOpenChange?.(true);
    return () => onOpenChange?.(false);
  }, [onOpenChange, open]);

  const notify = (next: SendTarget) =>
    onNotice?.({
      message: sentNotice(next, attachments, worktreeId),
      ...(onShowAgent ? { action: { label: "Show", run: () => onShowAgent(next.sessionId, next.mode) } } : {}),
    });

  const sendTo = async (next: SendTarget) => {
    if (disabled || sending) return;
    setSending(true);
    try {
      await deliverToAgent({
        dispatch,
        target: next,
        message: messageForTarget(message, next, worktreeId, otherWorktrees),
        attachments,
        worktreeId,
        onShowAgent,
      });
      rememberSendTarget(worktreeId, next.key);
      onSent?.();
      notify(next);
    } catch (cause) {
      setDialog({
        target: next.key,
        error: cause instanceof Error ? cause.message : "The message could not be sent.",
      });
    } finally {
      setSending(false);
    }
  };

  const onMainClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.shiftKey || !target) setDialog({ target: target?.key });
    else void sendTo(target);
  };

  const menuItem = (candidate: SendTarget): MenuItem => ({
    id: candidate.key,
    label: candidate.title,
    icon: candidate.mode === "chat" ? "message" : "terminal",
    title: candidate.detail,
    checked: candidate.key === target?.key,
    run: () => void sendTo(candidate),
  });
  const menuItems = (): MenuItem[] => {
    const groups = sendTargetGroups(targets);
    const grouped = groups.length > 1 || groups.some((group) => group.worktreeId !== worktreeId);
    return [
      ...(grouped
        ? groups.flatMap((group): MenuItem[] => [
            { heading: sendGroupLabel(group.branch, group.worktreeId === worktreeId) },
            ...group.targets.map(menuItem),
          ])
        : targets.map(menuItem)),
      ...(targets.length > 0 ? [{ separator: true as const }] : []),
      { label: "Edit message before sending…", icon: "pencil", run: () => setDialog({ target: target?.key }) },
    ];
  };

  const noneHere = targets.length > 0 && !targets.some((candidate) => candidate.worktreeId === worktreeId);
  const tooltip = disabled
    ? disabledTooltip
    : target
      ? target.worktreeId === worktreeId
        ? `Send to ${target.agent}. Shift+click to edit it first.`
        : `Send to ${target.agent} on ${target.branch}. Shift+click to edit it first.`
      : targets.length === 0
        ? "No agent is running here yet"
        : noneHere
          ? "No agent is running here. Pick one in another worktree."
          : "Pick an agent and read the message first";
  const buttonClass = (part: string) => cx("btn", `btn-${variant}`, size !== "md" && `btn-${size}`, part);

  return (
    <div className={cx("agent-send", className)}>
      <button
        type="button"
        className={buttonClass("agent-send-main")}
        aria-label={label}
        aria-busy={sending || undefined}
        data-tooltip={tooltip}
        disabled={disabled || sending}
        onClick={onMainClick}
      >
        {sending ? (
          <span className="spinner" aria-hidden="true" />
        ) : icon ? (
          <Icon name={icon} size={size === "xs" ? 12 : 13} />
        ) : null}
        {children}
      </button>
      <button
        type="button"
        className={buttonClass("agent-send-more")}
        aria-label="Choose agent"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        data-tooltip={menu ? undefined : "Choose an agent or edit the message first"}
        disabled={disabled || sending}
        onClick={(event) => {
          if (menu) {
            setMenu(undefined);
            return;
          }
          const anchor = event.currentTarget;
          const rect = anchor.getBoundingClientRect();
          setMenu({
            x: rect.right,
            y: rect.bottom + GAP,
            align: "end",
            anchor,
            label: "Send to",
            items: menuItems(),
          });
        }}
      >
        <Icon name="chevronDown" size={12} />
      </button>
      {menu ? <Menu request={menu} onClose={() => setMenu(undefined)} /> : null}
      {dialog ? (
        <SendToAgentDialog
          label={dialogLabel}
          title={dialogTitle}
          worktree={worktree}
          message={message}
          attachments={attachments}
          noAgentMessage={noAgentMessage}
          otherWorktrees={otherWorktrees}
          initialTarget={dialog.target}
          initialError={dialog.error}
          onSent={(sent) => {
            onSent?.();
            // The dialog shows an agent here once the message is sent; one elsewhere gets the notice instead.
            if (sent.worktreeId !== worktreeId) notify(sent);
          }}
          onClose={() => setDialog(undefined)}
          onShowAgent={onShowAgent}
        />
      ) : null}
    </div>
  );
}
