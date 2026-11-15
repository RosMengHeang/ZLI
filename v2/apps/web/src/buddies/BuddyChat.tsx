import {
  type BuddyProjection,
  firstSentence,
  isActiveTask,
  type RuntimeProjection,
  type TaskProjection,
} from "@zli-v2/contracts";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { liveStepLabel } from "../chat/liveStatus.js";
import { makeCommandId } from "../runtime/commandId.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { IconButton } from "../ui/Button.js";
import { Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { triggerLabel } from "./team.js";

type Run = (command: Record<string, unknown>) => Promise<boolean>;

/** One entry in a buddy's chat. Conversation, events and cards share one timeline. */
export type ChatItem =
  | { kind: "you"; key: string; at: string; text: string }
  | {
      kind: "event";
      key: string;
      at: string;
      icon: "zap" | "handoff" | "check" | "alert" | "history";
      text: string;
      threadId?: string | undefined;
    }
  | { kind: "reply"; key: string; at: string; task: TaskProjection }
  | { kind: "live"; key: string; at: string; task: TaskProjection };

function nameOf(state: RuntimeProjection, buddyId: string): string {
  return state.buddies?.find((buddy) => buddy.buddyId === buddyId)?.name ?? "A buddy";
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
        icon: "zap",
        text: `Routine ran${routine ? ` · ${triggerLabel(routine.trigger)}` : ""}: ${firstSentence(task.goal, 100)}`,
      });
    } else if (task.parentTaskId) {
      const parent = tasks.find((entry) => entry.taskId === task.parentTaskId);
      items.push({
        kind: "event",
        key: `${task.taskId}-start`,
        at: task.createdAt,
        icon: "handoff",
        text: `${parent ? nameOf(state, parent.buddyId) : "A buddy"} handed this on${task.round ? ` · round ${task.round}` : ""}: ${firstSentence(task.goal, 100)}`,
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
    for (const [index, revision] of task.revisions.entries())
      items.push({ kind: "you", key: `${task.taskId}-revise-${index}`, at: revision.at, text: revision.note });
    for (const question of task.questions)
      if (question.answer !== undefined)
        items.push({
          kind: "you",
          key: `${task.taskId}-answer-${question.questionId}`,
          at: question.askedAt,
          text: question.answer,
        });
    for (const child of tasks)
      if (child.parentTaskId === task.taskId && child.buddyId !== buddy.buddyId)
        items.push({
          kind: "event",
          key: `${task.taskId}-handoff-${child.taskId}`,
          at: child.createdAt,
          icon: "handoff",
          text: `Handed to ${nameOf(state, child.buddyId)}: ${firstSentence(child.goal, 100)}`,
          threadId: child.threadId,
        });
    for (const review of task.reviews)
      items.push({
        kind: "event",
        key: `${task.taskId}-review-${review.taskId}`,
        at: task.updatedAt,
        icon: review.verdict === "ok" ? "check" : "alert",
        text:
          review.verdict === "ok"
            ? `${nameOf(state, review.buddyId)} checked it: looks good`
            : `${nameOf(state, review.buddyId)} has ${review.notes.length} note${review.notes.length === 1 ? "" : "s"}`,
      });
    if (isActiveTask(task) && task.status !== "needs_you")
      items.push({ kind: "live", key: `${task.taskId}-live`, at: task.updatedAt, task });
    else if (task.status !== "queued")
      items.push({ kind: "reply", key: `${task.taskId}-reply`, at: task.updatedAt, task });
  }
  return items.sort((left, right) => left.at.localeCompare(right.at));
}

function clock(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** Shows the time before an entry when it is the first one or a while after the last. */
function showTime(items: readonly ChatItem[], index: number): boolean {
  if (index === 0) return true;
  const gap = Date.parse(items[index]?.at ?? "") - Date.parse(items[index - 1]?.at ?? "");
  return gap > 15 * 60_000;
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
  /** The buddy's answer for a job: its question, result card, or why it stopped. */
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
        {items.length === 0 ? (
          <div className="buddy-chat-empty">
            <BuddyAvatar buddy={buddy.color} size={56} name={buddy.name} />
            <p>
              Hi, I'm {buddy.name}.{" "}
              {buddy.role === "primary"
                ? "Tell me what you need and I'll hand the parts to the team."
                : `Tell me what to do and I'll take it from here${buddy.title ? `, ${buddy.title.toLowerCase()} style` : ""}.`}
            </p>
          </div>
        ) : null}
        {items.map((item, index) => (
          <div key={item.key} className="buddy-chat-entry">
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
    case "event":
      return (
        <div className="buddy-chat-event">
          <Icon name={item.icon} size={12} />
          <span>{item.text}</span>
          {item.threadId ? (
            <button type="button" className="job-card-link" onClick={() => onOpenThread(item.threadId as string)}>
              Open
            </button>
          ) : null}
        </div>
      );
    case "live":
      return <LiveRow task={item.task} buddy={buddy} projection={projection} onOpenThread={onOpenThread} />;
    case "reply":
      return (
        <div className="buddy-chat-reply">
          <BuddyAvatar buddy={buddy.color} size={24} name={buddy.name} />
          <div className="buddy-chat-reply-body">{renderReply(item.task)}</div>
        </div>
      );
  }
}

/** A running job: the face shows it is busy, and hovering says the step it is on. */
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
  const step = useMemo(() => {
    if (!task.threadId) return undefined;
    const steps = (projection.activities ?? []).filter((activity) => activity.threadId === task.threadId);
    return steps.findLast((activity) => activity.status === "running") ?? steps.at(-1);
  }, [projection.activities, task.threadId]);
  const label = task.status === "preparing" ? "Setting up its worktree" : liveStepLabel(step);
  return (
    <div className="buddy-chat-reply" title={label}>
      <BuddyAvatar buddy={buddy.color} size={24} mood="working" name={buddy.name} />
      <div className="buddy-chat-live">
        <span className="buddy-chat-live-label">{task.status === "preparing" ? "Getting ready…" : "Working…"}</span>
        {label !== "Working" ? <span className="buddy-chat-live-step">{label}</span> : null}
        {task.pick ? (
          <span className="buddy-chat-live-step">
            {task.pick.model ?? providerDisplayName(task.pick.provider, projection.providers)} · {task.pick.reason}
          </span>
        ) : null}
        {task.threadId ? (
          <button type="button" className="job-card-link" onClick={() => onOpenThread(task.threadId as string)}>
            Watch
          </button>
        ) : null}
      </div>
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
  return (
    <form className="buddy-chat-composer" onSubmit={(event) => void send(event)}>
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
      <div className="buddy-chat-tools">
        {projection.projects.length > 1 ? (
          <Select
            label="Project"
            value={project}
            options={projection.projects.map((entry) => ({ value: entry.projectId, label: entry.name }))}
            onChange={setProject}
          />
        ) : null}
        <span className="buddy-spacer" />
        <IconButton
          label="Send"
          icon="arrowUp"
          type="submit"
          className="buddy-chat-send"
          disabled={!text.trim() || busy}
        />
      </div>
    </form>
  );
}
