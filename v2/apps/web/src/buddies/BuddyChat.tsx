import {
  type BuddyLook,
  type BuddyProjection,
  firstSentence,
  isActiveTask,
  isAppDraft,
  openQuestion,
  type RuntimeProjection,
  type TaskProjection,
  type ThreadActivityProjection,
} from "@zli-v2/contracts";
import { type CSSProperties, type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { fileName, splitAttachedFiles, withAttachedFiles } from "../chat/attachedFiles.js";
import { readDraft, writeDraft } from "../chat/drafts.js";
import { Markdown } from "../chat/Markdown.js";
import { RequestPager } from "../chat/RequestCard.js";
import { useDockHeight } from "../chat/useDockHeight.js";
import { getBridge } from "../runtime/bridge.js";
import { makeCommandId } from "../runtime/commandId.js";
import { type AvatarMood, BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { type Buddy, buddyHex } from "../teammates/buddies.js";
import { lookOf } from "../teammates/pixelBuddies.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { AppDraftCard } from "./AppDraftCard.js";
import { friendlySteps } from "./stepLabel.js";
import { triggerLabel } from "./team.js";
import "./buddyChat.css";

type Run = (command: Record<string, unknown>) => Promise<boolean>;

type Who = { name: string; color: Buddy; look?: BuddyLook | undefined; image?: string | undefined };

/** One entry in a buddy's chat. Conversation, events and cards share one timeline. */
export type ChatItem =
  /** sending: your message on its way, shown before the runtime has it, or one that did not get there. */
  | { kind: "you"; key: string; at: string; text: string; sending?: "sending" | "failed" | undefined }
  /** resend: the person's message the buddy could not answer, offered to send again. */
  | { kind: "say"; key: string; at: string; text: string; resend?: string | undefined }
  /** A message between this buddy and a teammate: one it got, an answer brought back, or one it sent. */
  | {
      kind: "teammate";
      key: string;
      at: string;
      text: string;
      who: Who;
      way: "asked" | "replied" | "sent";
      /** A job this buddy gave the teammate: what it is, and how far the teammate got. */
      job?: { goal: string; status: TaskProjection["status"] | undefined } | undefined;
    }
  | {
      kind: "event";
      key: string;
      at: string;
      icon: IconName;
      text: string;
      who?: Who | undefined;
      /** The agent the line is about, shown by its own logo. */
      provider?: string | undefined;
      threadId?: string | undefined;
    }
  | { kind: "reply"; key: string; at: string; task: TaskProjection }
  | { kind: "live"; key: string; at: string; task: TaskProjection }
  | { kind: "thinking"; key: string; at: string; threadId?: string | undefined };

function who(state: RuntimeProjection, buddyId: string): Who | undefined {
  const buddy = state.buddies?.find((entry) => entry.buddyId === buddyId);
  return buddy ? { name: buddy.name, color: buddy.color, look: lookOf(buddy), image: buddy.image } : undefined;
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
      const goal = message.to && message.text.startsWith(JOB_NOTE) ? message.text.slice(JOB_NOTE.length) : undefined;
      const task =
        goal === undefined
          ? undefined
          : tasks.findLast((entry) => entry.buddyId === message.to && entry.goal.slice(0, 600) === goal);
      items.push({
        ...(goal === undefined ? {} : { job: { goal, status: task?.status } }),
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
        provider: task.pick.provider,
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
  // Lines the buddy sent while working do not answer it: it keeps working after them.
  const last = messages.at(-1);
  const asked = messages.findLast((message) => !(message.role === "buddy" && message.progress));
  if (asked?.role === "you" && last)
    items.push({ kind: "thinking", key: `${asked.messageId}-thinking`, at: last.at, threadId: buddy.chatThreadId });
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

/** Who an entry speaks for. Entries without one never group. */
function senderOf(item: ChatItem | undefined): string | undefined {
  if (item?.kind === "you") return "you";
  if (item?.kind === "say") return "buddy";
  if (item?.kind === "teammate" && !item.job) return `${item.way}:${item.who.name}`;
  return undefined;
}

/** True when an entry follows one from the same sender with no time shown between: it joins that group. */
export function continuesGroup(items: readonly ChatItem[], index: number): boolean {
  if (index === 0 || showTime(items, index)) return false;
  const sender = senderOf(items[index]);
  return sender !== undefined && sender === senderOf(items[index - 1]);
}

/** A message you sent that the runtime has not shown yet. */
type Outgoing = { buddyId: string; messageId: string; text: string; at: string; state: "sending" | "sent" | "failed" };

/** The newest steps of a job's chat, oldest first. */
export function recentSteps(
  state: RuntimeProjection,
  threadId: string | undefined,
  count: number,
): ThreadActivityProjection[] {
  if (!threadId) return [];
  return (state.activities ?? []).filter((activity) => activity.threadId === threadId).slice(-count);
}

/** The steps a buddy took, newest last, older ones fading out, in plain words. */
export function StepTicker({ steps, max = 3 }: { steps: readonly ThreadActivityProjection[]; max?: number }) {
  const shown = friendlySteps(steps).slice(-max);
  return (
    <ul className="buddy-steps">
      {shown.map((step, index) => (
        <li key={step.id} style={{ opacity: Math.max(0.3, 1 - (shown.length - 1 - index) * 0.22) }}>
          <span className="buddy-step-title">{step.label}</span>
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
  const transcript = useMemo(() => buddyTranscript(buddy, projection), [buddy, projection]);
  const [outgoing, setOutgoing] = useState<Outgoing[]>([]);
  // Your message shows at once, dimmed until it lands, and leaves this list when the runtime has it.
  const landed = useMemo(
    () => new Set((projection.buddyMessages ?? []).map((message) => message.messageId)),
    [projection.buddyMessages],
  );
  const items = useMemo<ChatItem[]>(
    () => [
      ...transcript,
      ...outgoing
        .filter((entry) => entry.buddyId === buddy.buddyId && !landed.has(entry.messageId))
        .map((entry) => ({
          kind: "you" as const,
          key: entry.messageId,
          at: entry.at,
          text: entry.text,
          sending: entry.state === "sent" ? undefined : entry.state,
        })),
    ],
    [transcript, outgoing, landed, buddy.buddyId],
  );
  useEffect(() => {
    setOutgoing((current) => {
      const next = current.filter((entry) => !landed.has(entry.messageId));
      return next.length === current.length ? current : next;
    });
  }, [landed]);
  // What the buddy wants to do in the person's apps waits here until they send or discard it, after its turn too.
  const drafts = (projection.requests ?? []).filter(
    (request) => request.threadId === buddy.chatThreadId && isAppDraft(request.requestId),
  );
  const view = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  useDockHeight(view, dock, log);
  // The chat follows its newest line, as long replies grow too, until the person scrolls up to read.
  const stick = useRef(true);
  // Scrolled up while something new arrives: a button offers the way back down.
  const [behind, setBehind] = useState(false);
  const height = useRef(0);
  useEffect(() => {
    const element = log.current;
    if (!element) return;
    const grew = element.scrollHeight > height.current;
    height.current = element.scrollHeight;
    if (stick.current) element.scrollTop = element.scrollHeight;
    else if (grew && !behind) setBehind(true);
  });
  const toLatest = () => {
    const element = log.current;
    stick.current = true;
    setBehind(false);
    if (element) element.scrollTop = element.scrollHeight;
  };
  // Sending again uses the same id, so a message that did land is never added twice.
  const deliver = async (messageId: string, text: string): Promise<boolean> => {
    stick.current = true;
    const at = new Date().toISOString();
    setOutgoing((current) => [
      ...current.filter((entry) => entry.messageId !== messageId),
      { buddyId: buddy.buddyId, messageId, text, at, state: "sending" },
    ]);
    const ok = await run({ type: "buddy.chat.send", buddyId: buddy.buddyId, messageId, text }).catch(() => false);
    setOutgoing((current) =>
      current.map((entry) => (entry.messageId === messageId ? { ...entry, state: ok ? "sent" : "failed" } : entry)),
    );
    return ok;
  };
  // A note that the buddy could not answer offers the person's message again, as a new message.
  const resend = (text: string) => void deliver(makeCommandId(), text);
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
          if (stick.current && behind) setBehind(false);
        }}
      >
        <div className="buddy-chat-column">
          {items.length === 0 ? (
            <div className="buddy-chat-empty">
              <BuddyAvatar buddy={buddy.color} look={lookOf(buddy)} image={buddy.image} size={64} name={buddy.name} />
              <h3>{buddy.name}</h3>
              <p>
                {buddy.role === "primary"
                  ? "Ask me anything, or give me a goal. I'll plan it and hand the parts to the team, in code or on the web."
                  : `Ask me anything, or have me do it: code in your projects, or anything on the web in my own browser.`}
              </p>
            </div>
          ) : null}
          {items.map((item, index) => (
            <div
              key={item.key}
              className={`buddy-chat-entry is-${item.kind}${continuesGroup(items, index) ? " is-grouped" : ""}`}
            >
              {showTime(items, index) ? <div className="buddy-chat-time">{clock(item.at)}</div> : null}
              <ChatEntry
                item={item}
                grouped={continuesGroup(items, index)}
                onRetry={(messageId, text) => void deliver(messageId, text)}
                buddy={buddy}
                projection={projection}
                onOpenThread={onOpenThread}
                renderReply={renderReply}
                run={run}
                // Only the newest note offers to send again: an older one was already followed by something.
                {...(index === items.length - 1 ? { onResend: resend } : {})}
              />
            </div>
          ))}
          {drafts.map((request) => (
            <div key={request.requestId} className="buddy-chat-entry is-draft">
              <AppDraftCard
                request={request}
                onRespond={(decision) =>
                  run({ type: "thread.respond", threadId: request.threadId, requestId: request.requestId, decision })
                }
              />
            </div>
          ))}
          <div className="buddy-chat-end" />
        </div>
      </div>
      <div className="buddy-chat-dock" ref={dock}>
        {behind ? (
          <Button size="sm" icon="chevronDown" className="buddy-chat-latest" onClick={toLatest}>
            Jump to latest
          </Button>
        ) : null}
        <Composer key={buddy.buddyId} buddy={buddy} projection={projection} run={run} deliver={deliver} />
      </div>
    </div>
  );
}

const TEAMMATE_WAY = { asked: "asked", replied: "replied", sent: "To" } as const;

/** Dark ink on a light buddy color, white on the rest, so the send arrow always reads. */
function inkOn(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const light = 0.299 * (value >> 16) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255);
  return light > 170 ? "#16151a" : "#ffffff";
}

/** How the runtime words a job handed to a teammate in the giver's chat. */
const JOB_NOTE = "New job: ";

/** A job's status as the teammate's face and a word. */
const JOB_STATE: Record<TaskProjection["status"], { mood: AvatarMood; label: string; tone: string }> = {
  queued: { mood: "idle", label: "Queued", tone: "quiet" },
  preparing: { mood: "thinking", label: "Starting", tone: "busy" },
  working: { mood: "working", label: "Working", tone: "busy" },
  needs_you: { mood: "waiting", label: "Needs you", tone: "needs" },
  ready: { mood: "done", label: "Done", tone: "done" },
  shipped: { mood: "done", label: "Shipped", tone: "done" },
  closed: { mood: "done", label: "Done", tone: "done" },
  failed: { mood: "failed", label: "Failed", tone: "failed" },
  stopped: { mood: "stopped", label: "Stopped", tone: "quiet" },
  cancelled: { mood: "stopped", label: "Cancelled", tone: "quiet" },
};

/** A job handed to a teammate: one line with their face, the job, and how it is going. */
function JobLine({ who, job }: { who: Who; job: { goal: string; status: TaskProjection["status"] | undefined } }) {
  const state = job.status ? JOB_STATE[job.status] : { mood: "idle" as const, label: "Sent", tone: "quiet" };
  return (
    <div className="buddy-chat-job" style={{ "--teammate": buddyHex(who.color) } as CSSProperties}>
      <BuddyAvatar buddy={who.color} look={who.look} image={who.image} mood={state.mood} size={22} />
      <span className="buddy-chat-job-text">
        <strong>{who.name}</strong> <span>{job.goal}</span>
      </span>
      <span className={`buddy-chat-job-state is-${state.tone}`}>
        {state.tone === "busy" ? <Icon name="loader" size={12} className="activity-spin" /> : null}
        {state.tone === "done" ? <Icon name="check" size={12} /> : null}
        {state.label}
      </span>
    </div>
  );
}

/** A note between teammates: whose words they are, and which way they went. */
function TeammateNote({ item, grouped }: { item: Extract<ChatItem, { kind: "teammate" }>; grouped: boolean }) {
  return (
    <figure
      className={`buddy-chat-teammate is-${item.way}`}
      style={{ "--teammate": buddyHex(item.who.color) } as CSSProperties}
    >
      <figcaption className="buddy-chat-teammate-head" hidden={grouped}>
        <BuddyAvatar buddy={item.who.color} look={item.who.look} image={item.who.image} size={16} />
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
  run,
  grouped = false,
  onRetry,
}: {
  item: ChatItem;
  /** Follows an entry from the same sender, so the name is not repeated. */
  grouped?: boolean;
  onRetry?: (messageId: string, text: string) => void;
  buddy: BuddyProjection;
  projection: RuntimeProjection;
  onOpenThread(threadId: string): void;
  renderReply(task: TaskProjection): ReactNode;
  onResend?: (text: string) => void;
  run: Run;
}) {
  switch (item.kind) {
    case "you":
      return (
        <YouMessage
          text={item.text}
          sending={item.sending}
          {...(onRetry ? { onRetry: () => onRetry(item.key, item.text) } : {})}
        />
      );
    case "say":
      return (
        <>
          {/* The buddy talks in a grey bubble on the left, like the other side of any chat. */}
          <div className="buddy-chat-say is-bubble">
            {/* Replies are Markdown: lists, bold, and links shown as their words, never as raw addresses. */}
            <Markdown text={item.text} />
            <CopyReply text={item.text} />
          </div>
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
      return item.job ? <JobLine who={item.who} job={item.job} /> : <TeammateNote item={item} grouped={grouped} />;
    case "event":
      return (
        <div className="buddy-chat-event">
          {item.who ? (
            <BuddyAvatar buddy={item.who.color} look={item.who.look} image={item.who.image} size={14} />
          ) : item.provider ? (
            <ProviderMark provider={item.provider} size={13} />
          ) : (
            <Icon name={item.icon} size={12} />
          )}
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
      const steps = recentSteps(projection, item.threadId, 12);
      // Something only the person can allow: asked right here, like any chat, and the buddy carries on after.
      const thread = projection.threads.find((entry) => entry.threadId === item.threadId);
      const asks = (projection.requests ?? [])
        .filter((request) => request.threadId === item.threadId && !isAppDraft(request.requestId))
        .map((request) => ({
          request,
          provider: thread?.provider ?? "",
          displayName: buddy.name,
          onRespond: async (decision: unknown) => {
            await run({ type: "thread.respond", threadId: request.threadId, requestId: request.requestId, decision });
          },
          onAnswer: async (answers: Record<string, string>) => {
            await run({ type: "thread.user-input", threadId: request.threadId, requestId: request.requestId, answers });
          },
        }));
      if (asks.length > 0)
        return (
          <div className="buddy-chat-ask">
            <RequestPager requests={asks} />
          </div>
        );
      return (
        <div className="buddy-chat-live is-thinking" role="status" aria-label={`${buddy.name} is thinking`}>
          <div className="buddy-chat-live-head">
            <span className="buddy-typing" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </div>
          {steps.length > 0 ? <StepTicker steps={steps} max={1} /> : null}
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
  const steps = recentSteps(projection, task.threadId, 12);
  const preparing = task.status === "preparing";
  return (
    <div
      className="buddy-chat-live"
      title={preparing ? "Setting up its worktree" : steps.length > 0 ? friendlySteps(steps).at(-1)?.label : "Working"}
    >
      <div className="buddy-chat-live-head">
        <BuddyAvatar
          buddy={buddy.color}
          look={lookOf(buddy)}
          image={buddy.image}
          size={18}
          mood="working"
          name={buddy.name}
        />
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

function Composer({
  buddy,
  projection,
  run,
  deliver,
}: {
  buddy: BuddyProjection;
  projection: RuntimeProjection;
  run: Run;
  /** Puts the message in the chat at once and sends it. */
  deliver(messageId: string, text: string): Promise<boolean>;
}) {
  const draftKey = `buddy:${buddy.buddyId}`;
  const [text, setText] = useState(() => readDraft(draftKey));
  const sendingNow = useRef(false);
  useEffect(() => writeDraft(draftKey, text), [draftKey, text]);
  const [files, setFiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
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
    // The ref turns a second Enter away at once, before the state that disables Send has rendered.
    if ((!typed && files.length === 0) || busy || sendingNow.current) return;
    sendingNow.current = true;
    setBusy(true);
    // The message moves into the chat right away. If it does not get there, it offers a retry there.
    const message = withAttachedFiles(files, typed || "Look at these files.");
    setText("");
    setFiles([]);
    box.current?.focus();
    await deliver(makeCommandId(), message).finally(() => {
      sendingNow.current = false;
    });
    setBusy(false);
  };
  // Replying: your last message has no answer yet. Stop ends the reply and drops what is queued behind it.
  const messages = (projection.buddyMessages ?? []).filter((message) => message.buddyId === buddy.buddyId);
  const replying = messages.findLast((message) => !(message.role === "buddy" && message.progress))?.role === "you";
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
      // The send button wears the buddy's color.
      style={{ "--buddy": buddyHex(buddy.color), "--buddy-ink": inkOn(buddyHex(buddy.color)) } as CSSProperties}
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
          icon="plus"
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
          ref={box}
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

/** What you sent: the words in a pill, the files under it, and whether it got there. */
function YouMessage({
  text,
  sending,
  onRetry,
}: {
  text: string;
  sending?: "sending" | "failed" | undefined;
  onRetry?: () => void;
}) {
  const { text: body, paths } = splitAttachedFiles(text);
  return (
    <>
      {body ? <div className={`buddy-chat-you${sending ? " is-pending" : ""}`}>{body}</div> : null}
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
      {sending === "sending" ? (
        <span className="buddy-chat-sending" role="status">
          Sending
        </span>
      ) : null}
      {sending === "failed" ? (
        <span className="buddy-chat-sending is-failed" role="alert">
          Not sent.{" "}
          {onRetry ? (
            <button type="button" className="buddy-chat-open" onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

/** Copies a reply as written, shown when the pointer is over it. */
function CopyReply({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <span className="buddy-chat-say-tools">
      <IconButton
        label={copied ? "Copied" : "Copy"}
        icon={copied ? "check" : "copy"}
        size="xs"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(text)
            .then(() => setCopied(true))
            .catch(() => undefined);
        }}
      />
    </span>
  );
}
