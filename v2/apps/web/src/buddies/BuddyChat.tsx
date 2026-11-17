import {
  type BuddyProjection,
  firstSentence,
  isActiveTask,
  openQuestion,
  type RuntimeProjection,
  type TaskProjection,
  type ThreadActivityProjection,
} from "@zli-v2/contracts";
import { type CSSProperties, type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { fileName, splitAttachedFiles, withAttachedFiles } from "../chat/attachedFiles.js";
import { liveStepLabel } from "../chat/liveStatus.js";
import { useDockHeight } from "../chat/useDockHeight.js";
import { getBridge } from "../runtime/bridge.js";
import { makeCommandId } from "../runtime/commandId.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { type Buddy, buddyHex } from "../teammates/buddies.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { triggerLabel } from "./team.js";
import "./buddyChat.css";

type Run = (command: Record<string, unknown>) => Promise<boolean>;

type Who = { name: string; color: Buddy };

/** One entry in a buddy's chat. Conversation, events and cards share one timeline. */
export type ChatItem =
  | { kind: "you"; key: string; at: string; text: string }
  /** resend: the person's message the buddy could not answer, offered to send again. */
  | { kind: "say"; key: string; at: string; text: string; resend?: string | undefined }
  /** A message between this buddy and a teammate: one it got, an answer brought back, or one it sent. */
  | { kind: "teammate"; key: string; at: string; text: string; who: Who; way: "asked" | "replied" | "sent" }
  | {
      kind: "event";
      key: string;
      at: string;
      icon: IconName;
      text: string;
      who?: Who | undefined;
      threadId?: string | undefined;
    }
  | { kind: "reply"; key: string; at: string; task: TaskProjection }
  | { kind: "live"; key: string; at: string; task: TaskProjection }
  | { kind: "thinking"; key: string; at: string; threadId?: string | undefined };

function who(state: RuntimeProjection, buddyId: string): Who | undefined {
  const buddy = state.buddies?.find((entry) => entry.buddyId === buddyId);
  return buddy ? { name: buddy.name, color: buddy.color } : undefined;
}

/** What the buddy says when a job ends, before its card. */
function closingLine(task: TaskProjection): string | undefined {
  if (task.status === "failed") return `I got stuck${task.needs?.text ? `: ${task.needs.text}` : "."}`;
  if (task.status === "stopped") return "I stopped before finishing.";
  if (task.status === "cancelled") return "Dropped.";
  if (openQuestion(task)) return undefined;
  if (task.status === "needs_you") return task.needs?.text ?? "I need you for a moment.";
  return task.result?.summary ?? task.finished?.summary;
}

/** The buddy's whole history as one transcript, oldest first. */
export function buddyTranscript(buddy: BuddyProjection, state: RuntimeProjection): ChatItem[] {
  const items: ChatItem[] = [];
  const tasks = state.tasks ?? [];
  const messages = (state.buddyMessages ?? []).filter((message) => message.buddyId === buddy.buddyId);
  let lastAsked: string | undefined;
  for (const message of messages) {
    if (message.role === "you" && !message.from) lastAsked = message.text;
    // A message between teammates is shown as theirs, named, since you did not write it.
    const teammateId = message.from ?? message.to;
    const teammate = teammateId ? (who(state, teammateId) ?? { name: "A teammate", color: "slate" }) : undefined;
    if (teammate) {
      items.push({
        kind: "teammate",
        key: message.messageId,
        at: message.at,
        text: message.text,
        who: teammate,
        way: message.to ? "sent" : message.role === "you" ? "asked" : "replied",
      });
      continue;
    }
    if (message.role === "you") {
      items.push({ kind: "you", key: message.messageId, at: message.at, text: message.text });
      continue;
    }
    items.push({
      kind: "say",
      key: message.messageId,
      at: message.at,
      text: message.text,
      ...(message.unanswered && lastAsked ? { resend: lastAsked } : {}),
    });
  }
  for (const routine of state.routines ?? [])
    if (routine.buddyId === buddy.buddyId)
      items.push({
        kind: "event",
        key: `routine-${routine.routineId}`,
        at: routine.createdAt,
        icon: "history",
        text: `Created routine · ${triggerLabel(routine.trigger)}: ${firstSentence(routine.goal, 80)}`,
      });
  for (const task of tasks) {
    if (task.buddyId !== buddy.buddyId) continue;
    const origin = task.origin;
    if (origin.kind === "routine") {
      const routine = state.routines?.find((entry) => entry.routineId === origin.routineId);
      items.push({
        kind: "event",
        key: `${task.taskId}-start`,
        at: task.createdAt,
        icon: "history",
        text: `Routine ran${routine ? ` · ${triggerLabel(routine.trigger)}` : ""}: ${firstSentence(task.goal, 100)}`,
      });
    } else if (task.parentTaskId) {
      const parent = tasks.find((entry) => entry.taskId === task.parentTaskId);
      const from = parent ? who(state, parent.buddyId) : undefined;
      items.push({
        kind: "event",
        key: `${task.taskId}-start`,
        at: task.createdAt,
        icon: "handoff",
        who: from,
        text: `${from?.name ?? "A buddy"} handed this on${task.round ? ` · round ${task.round}` : ""}: ${firstSentence(task.goal, 100)}`,
      });
    } else if (origin.kind === "primary") {
      items.push({
        kind: "event",
        key: `${task.taskId}-start`,
        at: task.createdAt,
        icon: "handoff",
        text: `The Primary buddy gave this job: ${firstSentence(task.goal, 100)}`,
      });
    } else if (origin.kind === "buddy" && origin.threadId) {
      // Started from the chat: the conversation already says why, so the job is one line.
      const project =
        state.projects.length > 1 ? state.projects.find((entry) => entry.projectId === task.projectId) : undefined;
      items.push({
        kind: "event",
        key: `${task.taskId}-start`,
        at: task.createdAt,
        icon: "zap",
        text: `Started a job${project ? ` in ${project.name}` : ""}: ${firstSentence(task.goal, 100)}`,
        threadId: task.threadId,
      });
    } else {
      items.push({ kind: "you", key: `${task.taskId}-start`, at: task.createdAt, text: task.goal });
    }
    if (task.pick && task.startedAt) {
      // A job from the chat was already acknowledged there.
      const fromChat = origin.kind === "buddy" && origin.threadId;
      // With more than one project, it says which one it took the job to, since nobody picked.
      const project =
        state.projects.length > 1 ? state.projects.find((entry) => entry.projectId === task.projectId) : undefined;
      if (!fromChat)
        items.push({
          kind: "say",
          key: `${task.taskId}-ack`,
          at: task.startedAt,
          text: project ? `On it, in ${project.name}.` : "On it.",
        });
      const model = task.pick.model ?? providerDisplayName(task.pick.provider, state.providers);
      items.push({
        kind: "event",
        key: `${task.taskId}-pick`,
        at: task.startedAt,
        icon: "cpu",
        text: `${model}${task.pick.effort ? ` · ${task.pick.effort}` : ""} — ${task.pick.reason}`,
        threadId: task.threadId,
      });
    }
    for (const [index, revision] of task.revisions.entries())
      items.push({ kind: "you", key: `${task.taskId}-revise-${index}`, at: revision.at, text: revision.note });
    for (const question of task.questions) {
      if (question.answer === undefined) continue;
      items.push({
        kind: "say",
        key: `${task.taskId}-q-${question.questionId}`,
        at: question.askedAt,
        text: question.text,
      });
      items.push({
        kind: "you",
        key: `${task.taskId}-a-${question.questionId}`,
        at: question.askedAt,
        text: question.answer,
      });
    }
    const children = tasks.filter((child) => child.parentTaskId === task.taskId && child.buddyId !== buddy.buddyId);
    for (const child of children) {
      const to = who(state, child.buddyId);
      items.push({
        kind: "event",
        key: `${task.taskId}-handoff-${child.taskId}`,
        at: child.createdAt,
        icon: "handoff",
        who: to,
        text: `Handed to ${to?.name ?? "a buddy"}: ${firstSentence(child.goal, 100)}`,
        threadId: child.threadId,
      });
    }
    for (const review of task.reviews) {
      const reviewer = who(state, review.buddyId);
      items.push({
        kind: "event",
        key: `${task.taskId}-review-${review.taskId}`,
        at: task.updatedAt,
        icon: review.verdict === "ok" ? "check" : "alert",
        who: reviewer,
        text:
          review.verdict === "ok"
            ? `${reviewer?.name ?? "A buddy"} checked it: looks good`
            : `${reviewer?.name ?? "A buddy"} has ${review.notes.length} note${review.notes.length === 1 ? "" : "s"}`,
      });
    }
    if (isActiveTask(task) && task.status !== "needs_you") {
      items.push({ kind: "live", key: `${task.taskId}-live`, at: task.updatedAt, task });
      continue;
    }
    if (task.status === "queued") continue;
    const line = closingLine(task);
    if (line) items.push({ kind: "say", key: `${task.taskId}-end`, at: task.updatedAt, text: line });
    items.push({ kind: "reply", key: `${task.taskId}-reply`, at: task.updatedAt, task });
  }
  // Your message is waiting on its answer.
  const last = messages.at(-1);
  if (last?.role === "you")
    items.push({ kind: "thinking", key: `${last.messageId}-thinking`, at: last.at, threadId: buddy.chatThreadId });
  // Stable by time, so entries recorded at the same moment keep the order they were added in.
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.at.localeCompare(right.item.at) || left.index - right.index)
    .map(({ item }) => item);
}

function clock(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${date.toLocaleDateString([], { weekday: "long" })} ${time}`;
}

/** Shows the time before an entry when it is the first one or a while after the last. */
function showTime(items: readonly ChatItem[], index: number): boolean {
  if (index === 0) return true;
  const gap = Date.parse(items[index]?.at ?? "") - Date.parse(items[index - 1]?.at ?? "");
  return gap > 15 * 60_000;
}

/** The newest steps of a job's chat, oldest first. */
export function recentSteps(
  state: RuntimeProjection,
  threadId: string | undefined,
  count: number,
): ThreadActivityProjection[] {
  if (!threadId) return [];
  return (state.activities ?? []).filter((activity) => activity.threadId === threadId).slice(-count);
}

/** The steps a buddy took, newest last, older ones fading out. */
export function StepTicker({ steps }: { steps: readonly ThreadActivityProjection[] }) {
  return (
    <ul className="buddy-steps">
      {steps.map((step, index) => (
        <li key={step.activityId} style={{ opacity: Math.max(0.3, 1 - (steps.length - 1 - index) * 0.22) }}>
          <span className="buddy-step-title">{liveStepLabel(step)}</span>
          {step.lines ? (
            <span className="buddy-step-lines">
              <span className="is-added">+{step.lines.added}</span>{" "}
              <span className="is-removed">−{step.lines.removed}</span>
            </span>
          ) : step.command ? (
            <span className="buddy-step-detail">{step.command}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function BuddyChat({
  buddy,
  projection,
  run,
  onOpenThread,
  renderReply,
}: {
  buddy: BuddyProjection;
  projection: RuntimeProjection;
  run: Run;
  onOpenThread(threadId: string): void;
  /** The card under the buddy's reply: its question, result, or what to do next. */
  renderReply(task: TaskProjection): ReactNode;
}) {
  const items = useMemo(() => buddyTranscript(buddy, projection), [buddy, projection]);
  const view = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  useDockHeight(view, dock, log);
  // The chat follows its newest line, as long replies grow too, until the person scrolls up to read.
  const stick = useRef(true);
  useEffect(() => {
    const element = log.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  });
  // A note that the buddy could not answer offers the person's message again, as a new message.
  const resend = (text: string) => {
    stick.current = true;
    void run({ type: "buddy.chat.send", buddyId: buddy.buddyId, messageId: makeCommandId(), text });
  };
  return (
    <div className="buddy-chat" ref={view}>
      <div
        className="buddy-chat-log"
        ref={log}
        role="log"
        aria-label={`Chat with ${buddy.name}`}
        onScroll={(event) => {
          const target = event.currentTarget;
          stick.current = target.scrollHeight - target.scrollTop - target.clientHeight < 48;
        }}
      >
        <div className="buddy-chat-column">
          {items.length === 0 ? (
            <div className="buddy-chat-empty">
              <BuddyAvatar buddy={buddy.color} size={64} name={buddy.name} />
              <h3>{buddy.name}</h3>
              <p>
                {buddy.role === "primary"
                  ? "Ask me anything. When you need something built, I'll plan it and hand the parts to the team."
                  : `Ask me anything. When you need work done, I'll take it as a job on my own branch and show you the result.`}
              </p>
            </div>
          ) : null}
          {items.map((item, index) => (
            <div key={item.key} className={`buddy-chat-entry is-${item.kind}`}>
              {showTime(items, index) ? <div className="buddy-chat-time">{clock(item.at)}</div> : null}
              <ChatEntry
                item={item}
                buddy={buddy}
                projection={projection}
                onOpenThread={onOpenThread}
                renderReply={renderReply}
                // Only the newest note offers to send again: an older one was already followed by something.
                {...(index === items.length - 1 ? { onResend: resend } : {})}
              />
            </div>
          ))}
          <div className="buddy-chat-end" />
        </div>
      </div>
      <div className="buddy-chat-dock" ref={dock}>
        <Composer buddy={buddy} projection={projection} run={run} />
      </div>
    </div>
  );
}

const TEAMMATE_WAY = { asked: "asked", replied: "replied", sent: "To" } as const;

/** A note between teammates: whose words they are, and which way they went. */
function TeammateNote({ item }: { item: Extract<ChatItem, { kind: "teammate" }> }) {
  return (
    <figure
      className={`buddy-chat-teammate is-${item.way}`}
      style={{ "--teammate": buddyHex(item.who.color) } as CSSProperties}
    >
      <figcaption className="buddy-chat-teammate-head">
        <BuddyAvatar buddy={item.who.color} size={16} />
        {item.way === "sent" ? (
          <span>
            {TEAMMATE_WAY.sent} <strong>{item.who.name}</strong>
          </span>
        ) : (
          <span>
            <strong>{item.who.name}</strong> {TEAMMATE_WAY[item.way]}
          </span>
        )}
      </figcaption>
      <blockquote className="buddy-chat-teammate-text">{item.text}</blockquote>
    </figure>
  );
}

function ChatEntry({
  item,
  buddy,
  projection,
  onOpenThread,
  renderReply,
  onResend,
}: {
  item: ChatItem;
  buddy: BuddyProjection;
  projection: RuntimeProjection;
  onOpenThread(threadId: string): void;
  renderReply(task: TaskProjection): ReactNode;
  onResend?: (text: string) => void;
}) {
  switch (item.kind) {
    case "you":
      return <YouMessage text={item.text} />;
    case "say":
      return (
        <>
          <div className="buddy-chat-say">{item.text}</div>
          {item.resend && onResend ? (
            <div className="buddy-chat-resend">
              <Button size="sm" icon="reload" onClick={() => onResend(item.resend as string)}>
                Send again
              </Button>
            </div>
          ) : null}
        </>
      );
    case "teammate":
      return <TeammateNote item={item} />;
    case "event":
      return (
        <div className="buddy-chat-event">
          {item.who ? <BuddyAvatar buddy={item.who.color} size={14} /> : <Icon name={item.icon} size={12} />}
          <span>{item.text}</span>
          {item.threadId ? (
            <button type="button" className="buddy-chat-open" onClick={() => onOpenThread(item.threadId as string)}>
              Open
            </button>
          ) : null}
        </div>
      );
    case "live":
      return <LiveRow task={item.task} buddy={buddy} projection={projection} onOpenThread={onOpenThread} />;
    case "reply":
      return <div className="buddy-chat-card">{renderReply(item.task)}</div>;
    case "thinking": {
      const steps = recentSteps(projection, item.threadId, 3);
      return (
        <div className="buddy-chat-live is-thinking" role="status" aria-label={`${buddy.name} is thinking`}>
          <div className="buddy-chat-live-head">
            <span className="buddy-typing" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </div>
          {steps.length > 0 ? <StepTicker steps={steps} /> : null}
        </div>
      );
    }
  }
}

/** A running job: the face shows it is busy, with the last few steps underneath. */
function LiveRow({
  task,
  buddy,
  projection,
  onOpenThread,
}: {
  task: TaskProjection;
  buddy: BuddyProjection;
  projection: RuntimeProjection;
  onOpenThread(threadId: string): void;
}) {
  const steps = recentSteps(projection, task.threadId, 4);
  const preparing = task.status === "preparing";
  return (
    <div className="buddy-chat-live" title={preparing ? "Setting up its worktree" : liveStepLabel(steps.at(-1))}>
      <div className="buddy-chat-live-head">
        <BuddyAvatar buddy={buddy.color} size={18} mood="working" name={buddy.name} />
        <span>{preparing ? "Setting up its worktree…" : "Working…"}</span>
        {task.threadId ? (
          <button type="button" className="buddy-chat-open" onClick={() => onOpenThread(task.threadId as string)}>
            Watch
          </button>
        ) : null}
      </div>
      {steps.length > 0 ? <StepTicker steps={steps} /> : null}
    </div>
  );
}

function Composer({ buddy, projection, run }: { buddy: BuddyProjection; projection: RuntimeProjection; run: Run }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const attach = (list: FileList | null) => {
    const bridge = getBridge();
    const paths = [...(list ?? [])].flatMap((file) => {
      const path = bridge?.pathForFile?.(file);
      return path ? [path] : [];
    });
    setFiles((current) => [...current, ...paths.filter((path) => !current.includes(path))]);
  };
  // A message is just a message: the buddy decides whether it is a job, and asks where when it can't tell.
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const typed = text.trim();
    if ((!typed && files.length === 0) || busy) return;
    setBusy(true);
    const ok = await run({
      type: "buddy.chat.send",
      buddyId: buddy.buddyId,
      messageId: makeCommandId(),
      text: withAttachedFiles(files, typed || "Look at these files."),
    });
    setBusy(false);
    if (ok) {
      setText("");
      setFiles([]);
    }
  };
  // Replying: your last message has no answer yet. Stop ends the reply and drops what is queued behind it.
  const messages = (projection.buddyMessages ?? []).filter((message) => message.buddyId === buddy.buddyId);
  const replying = messages.at(-1)?.role === "you";
  const stop = async () => {
    const threadId = buddy.chatThreadId;
    if (threadId) {
      for (const queued of projection.queuedMessages ?? [])
        if (queued.threadId === threadId) await run({ type: "thread.queue.remove", threadId, queueId: queued.queueId });
      const thread = projection.threads.find((entry) => entry.threadId === threadId);
      if (thread && (thread.status === "working" || thread.status === "waiting" || thread.status === "starting"))
        await run({ type: "thread.interrupt", threadId });
    }
    await run({ type: "buddy.chat.reply", buddyId: buddy.buddyId, messageId: makeCommandId(), text: "Stopped." });
  };
  if (projection.projects.length === 0)
    return <p className="buddies-hint buddy-chat-note">Add a project to give jobs.</p>;
  return (
    <form
      className="buddy-chat-composer"
      onSubmit={(event) => void send(event)}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        attach(event.dataTransfer.files);
      }}
    >
      {files.length > 0 ? (
        <ul className="buddy-chat-files" aria-label="Attachments">
          {files.map((path) => (
            <li key={path} title={path}>
              <Icon name="file" size={12} />
              <span>{fileName(path)}</span>
              <IconButton
                label={`Remove ${fileName(path)}`}
                icon="x"
                size="xs"
                onClick={() => setFiles((current) => current.filter((entry) => entry !== path))}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="buddy-chat-row">
        <IconButton
          label="Attach files"
          tooltip="Attach files. You can also drop them here"
          icon="paperclip"
          className="buddy-chat-attach"
          onClick={() => picker.current?.click()}
        />
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            attach(event.target.files);
            event.target.value = "";
          }}
        />
        <textarea
          className="buddy-chat-input"
          aria-label={`Message ${buddy.name}`}
          placeholder={`Message ${buddy.name}`}
          value={text}
          rows={1}
          maxLength={4_000}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {replying && !text.trim() && files.length === 0 ? (
          <button
            className="send-button is-stop"
            type="button"
            aria-label={`Stop ${buddy.name}`}
            data-tooltip="Stop"
            onClick={() => void stop()}
          >
            <Icon name="stop" size={13} />
          </button>
        ) : (
          <button
            className="send-button"
            type="submit"
            aria-label="Send"
            data-tooltip="Send"
            data-shortcut="Enter"
            disabled={(!text.trim() && files.length === 0) || busy}
          >
            <Icon name="arrowUp" size={15} />
          </button>
        )}
      </div>
    </form>
  );
}

/** What you sent: the words in a pill, the files under it. */
function YouMessage({ text }: { text: string }) {
  const { text: body, paths } = splitAttachedFiles(text);
  return (
    <>
      {body ? <div className="buddy-chat-you">{body}</div> : null}
      {paths.length > 0 ? (
        <ul className="buddy-chat-files is-sent" aria-label="Attached files">
          {paths.map((path) => (
            <li key={path} title={path}>
              <Icon name="file" size={12} />
              <span>{fileName(path)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
