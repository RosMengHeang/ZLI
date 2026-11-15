import {
  type BuddyProjection,
  firstSentence,
  isActiveTask,
  openQuestion,
  type RuntimeProjection,
  type TaskProjection,
  type ThreadActivityProjection,
} from "@zli-v2/contracts";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { liveStepLabel } from "../chat/liveStatus.js";
import { makeCommandId } from "../runtime/commandId.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import type { Buddy } from "../teammates/buddies.js";
import { IconButton } from "../ui/Button.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { triggerLabel } from "./team.js";
import "./buddyChat.css";

type Run = (command: Record<string, unknown>) => Promise<boolean>;

type Who = { name: string; color: Buddy };

/** One entry in a buddy's chat. Conversation, events and cards share one timeline. */
export type ChatItem =
  | { kind: "you"; key: string; at: string; text: string }
  | { kind: "say"; key: string; at: string; text: string }
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
  | { kind: "live"; key: string; at: string; task: TaskProjection };

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
    } else {
      items.push({ kind: "you", key: `${task.taskId}-start`, at: task.createdAt, text: task.goal });
    }
    if (task.pick && task.startedAt) {
      items.push({ kind: "say", key: `${task.taskId}-ack`, at: task.startedAt, text: "On it." });
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
  projectId,
  onOpenThread,
  renderReply,
}: {
  buddy: BuddyProjection;
  projection: RuntimeProjection;
  run: Run;
  projectId: string | undefined;
  onOpenThread(threadId: string): void;
  /** The card under the buddy's reply: its question, result, or what to do next. */
  renderReply(task: TaskProjection): ReactNode;
}) {
  const items = useMemo(() => buddyTranscript(buddy, projection), [buddy, projection]);
  const end = useRef<HTMLDivElement>(null);
  const count = items.length;
  useEffect(() => {
    if (count > 0) end.current?.scrollIntoView?.({ block: "end" });
  }, [count]);
  return (
    <div className="buddy-chat">
      <div className="buddy-chat-log" role="log" aria-label={`Chat with ${buddy.name}`}>
        <div className="buddy-chat-column">
          {items.length === 0 ? (
            <div className="buddy-chat-empty">
              <BuddyAvatar buddy={buddy.color} size={64} name={buddy.name} />
              <h3>{buddy.name}</h3>
              <p>
                {buddy.role === "primary"
                  ? "Tell me what you need. I'll split it into jobs and hand them to the team."
                  : `Tell me what to do. I'll work on my own branch and show you the result${buddy.title ? `. ${buddy.title} work is my thing` : ""}.`}
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
              />
            </div>
          ))}
          <div ref={end} />
        </div>
      </div>
      <Composer buddy={buddy} projection={projection} run={run} projectId={projectId} />
    </div>
  );
}

function ChatEntry({
  item,
  buddy,
  projection,
  onOpenThread,
  renderReply,
}: {
  item: ChatItem;
  buddy: BuddyProjection;
  projection: RuntimeProjection;
  onOpenThread(threadId: string): void;
  renderReply(task: TaskProjection): ReactNode;
}) {
  switch (item.kind) {
    case "you":
      return <div className="buddy-chat-you">{item.text}</div>;
    case "say":
      return <div className="buddy-chat-say">{item.text}</div>;
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

/** The buddy's computer: a window onto the job it is running. */
export function BuddyComputer({
  buddy,
  task,
  projection,
  onOpenThread,
}: {
  buddy: BuddyProjection;
  task: TaskProjection | undefined;
  projection: RuntimeProjection;
  onOpenThread(threadId: string): void;
}) {
  const steps = recentSteps(projection, task?.threadId, 4);
  return (
    <div className={`buddy-card buddy-computer-card${task ? " is-on" : ""}`}>
      <button
        type="button"
        className="buddy-computer-row"
        disabled={!task?.threadId}
        onClick={() => task?.threadId && onOpenThread(task.threadId)}
      >
        <span className="buddy-card-text">
          <span className="buddy-card-title">{buddy.name}'s computer</span>
          <span className="buddy-card-sub">{task ? (task.branch ?? "Working") : "Asleep"}</span>
        </span>
        <span className="buddy-screen">
          <BuddyAvatar buddy={buddy.color} size={22} mood={task ? "working" : "idle"} />
        </span>
      </button>
      {task && steps.length > 0 ? <StepTicker steps={steps} /> : null}
    </div>
  );
}

function Composer({
  buddy,
  projection,
  run,
  projectId,
}: {
  buddy: BuddyProjection;
  projection: RuntimeProjection;
  run: Run;
  projectId: string | undefined;
}) {
  const [text, setText] = useState("");
  const [project, setProject] = useState(projectId ?? projection.projects[0]?.projectId ?? "");
  const [busy, setBusy] = useState(false);
  const projectName = projection.projects.find((entry) => entry.projectId === project)?.name;
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const goal = text.trim();
    if (!goal || !project || busy) return;
    setBusy(true);
    const ok = await run({
      type: "task.assign",
      task: {
        taskId: makeCommandId(),
        buddyId: buddy.buddyId,
        projectId: project,
        kind: "job",
        goal,
        origin: { kind: "buddy" },
      },
    });
    setBusy(false);
    if (ok) setText("");
  };
  if (projection.projects.length === 0)
    return <p className="buddies-hint buddy-chat-note">Add a project to give jobs.</p>;
  const nextProject = () => {
    const index = projection.projects.findIndex((entry) => entry.projectId === project);
    const next = projection.projects[(index + 1) % projection.projects.length];
    if (next) setProject(next.projectId);
  };
  return (
    <form className="buddy-chat-composer" onSubmit={(event) => void send(event)}>
      {/* Jobs run in a project; with more than one, the chip switches between them. */}
      <button
        type="button"
        className="buddy-chat-project"
        onClick={nextProject}
        disabled={projection.projects.length < 2}
        title={projection.projects.length > 1 ? "Switch project" : "The project this job runs in"}
      >
        <Icon name="folder" size={13} />
        {projectName}
      </button>
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
      <IconButton
        label="Send"
        icon="arrowUp"
        type="submit"
        className="buddy-chat-send"
        disabled={!text.trim() || busy}
      />
    </form>
  );
}
