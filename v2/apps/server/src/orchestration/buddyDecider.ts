import {
  type BuddyCommand,
  type BuddyProjection,
  buddyNamed,
  findBuddy,
  isBuddyHome,
  isOpenTask,
  MAX_BUDDIES,
  MAX_HANDOFF_DEPTH,
  MAX_OPEN_JOBS,
  type RuntimeProjection,
  screenNote,
  type TaskProjection,
  type TaskStatus,
} from "@zli-v2/contracts";

import { type DomainDecision, DomainError } from "./decider.js";

/** Statuses a job can move to from each status, for the reactor's own updates. */
const ALLOWED: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["preparing", "working", "failed", "stopped"],
  preparing: ["working", "failed", "stopped", "queued"],
  working: ["needs_you", "ready", "failed", "stopped"],
  needs_you: ["working", "ready", "failed", "stopped"],
  ready: ["working", "needs_you", "failed"],
  shipped: [],
  closed: [],
  failed: ["working", "queued"],
  stopped: ["working", "queued"],
  cancelled: [],
};

export function decideBuddy(projection: RuntimeProjection, command: BuddyCommand): DomainDecision[] {
  switch (command.type) {
    case "buddy.create": {
      const live = (projection.buddies ?? []).filter((buddy) => !buddy.archived);
      if (findBuddy(projection, command.buddy.buddyId))
        throw new DomainError("buddy_exists", `Buddy already exists: ${command.buddy.buddyId}`);
      if (live.length >= MAX_BUDDIES)
        throw new DomainError("buddy_limit", `A team has at most ${MAX_BUDDIES} buddies.`);
      if (buddyNamed(projection, command.buddy.name))
        throw new DomainError("buddy_name_taken", `Another buddy is already called ${command.buddy.name}.`);
      const hasPrimary = live.some((buddy) => buddy.role === "primary");
      // Exactly one Primary: the first buddy becomes it, and a second one asked for joins as a buddy.
      const role = hasPrimary ? "buddy" : "primary";
      const order = live.reduce((most, buddy) => Math.max(most, buddy.order + 1), 0);
      return [{ type: "buddy.created", buddy: { ...command.buddy, role }, order }];
    }
    case "buddy.chat.send":
    case "buddy.chat.reply": {
      const buddy = requireBuddy(projection, command.buddyId);
      if (buddy.archived) throw new DomainError("buddy_missing", `${buddy.name} was removed from the team.`);
      // A message lands once, however often it is sent.
      if ((projection.buddyMessages ?? []).some((message) => message.messageId === command.messageId)) return [];
      if (command.type === "buddy.chat.send" && command.from !== undefined) {
        const sender = requireBuddy(projection, command.from);
        if (sender.archived || sender.buddyId === buddy.buddyId)
          throw new DomainError("buddy_missing", "Only another buddy on the team can send this.");
        return [
          {
            type: "buddy.chat.sent",
            buddyId: buddy.buddyId,
            messageId: command.messageId,
            text: command.text,
            from: sender.buddyId,
          },
        ];
      }
      if (command.type === "buddy.chat.send")
        return [{ type: "buddy.chat.sent", buddyId: buddy.buddyId, messageId: command.messageId, text: command.text }];
      // A teammate named on a reply must be someone else on the team.
      for (const teammateId of [command.from, command.to]) {
        if (teammateId === undefined) continue;
        const teammate = requireBuddy(projection, teammateId);
        if (teammate.archived || teammate.buddyId === buddy.buddyId)
          throw new DomainError("buddy_missing", "Only another buddy on the team can be named here.");
      }
      return [
        {
          type: "buddy.chat.replied",
          buddyId: buddy.buddyId,
          messageId: command.messageId,
          text: command.text,
          ...(command.from ? { from: command.from } : {}),
          ...(command.to ? { to: command.to } : {}),
          ...(command.unanswered ? { unanswered: true } : {}),
        },
      ];
    }
    case "buddy.chat.thread": {
      const buddy = requireBuddy(projection, command.buddyId);
      if (buddy.chatThreadId === command.threadId) return [];
      return [{ type: "buddy.chat.thread.set", buddyId: buddy.buddyId, threadId: command.threadId }];
    }
    case "buddy.update": {
      requireBuddy(projection, command.buddyId);
      const { name } = command.changes;
      if (name !== undefined) {
        const other = buddyNamed(projection, name);
        if (other && other.buddyId !== command.buddyId)
          throw new DomainError("buddy_name_taken", `Another buddy is already called ${name}.`);
      }
      return [{ type: "buddy.updated", buddyId: command.buddyId, changes: command.changes }];
    }
    case "buddy.archive": {
      const buddy = requireBuddy(projection, command.buddyId);
      const events: DomainDecision[] = [];
      for (const task of projection.tasks ?? [])
        if (task.buddyId === buddy.buddyId && task.status === "queued")
          events.push({ type: "task.cancelled", taskId: task.taskId });
      events.push({ type: "buddy.archived", buddyId: buddy.buddyId });
      if (buddy.role === "primary") {
        const next = (projection.buddies ?? [])
          .filter((other) => !other.archived && other.buddyId !== buddy.buddyId)
          .sort((left, right) => left.order - right.order)[0];
        if (next) events.push({ type: "buddy.primary.changed", buddyId: next.buddyId });
      }
      return events;
    }
    case "buddy.setPrimary": {
      const buddy = requireBuddy(projection, command.buddyId);
      if (buddy.role === "primary") return [];
      return [{ type: "buddy.primary.changed", buddyId: buddy.buddyId }];
    }
    case "buddy.reorder": {
      const ids = new Set((projection.buddies ?? []).filter((buddy) => !buddy.archived).map((buddy) => buddy.buddyId));
      if (command.buddyIds.length !== ids.size || command.buddyIds.some((id) => !ids.has(id)))
        throw new DomainError("buddy_missing", "Reorder needs every buddy once.");
      return [{ type: "buddy.reordered", buddyIds: command.buddyIds }];
    }
    case "buddy.handoff.set": {
      requireBuddy(projection, command.buddyId);
      requireBuddy(projection, command.rule.to);
      if (command.rule.to === command.buddyId)
        throw new DomainError("handoff_invalid", "A buddy cannot hand its work to itself.");
      return [{ type: "buddy.handoff.set", buddyId: command.buddyId, rule: command.rule }];
    }
    case "buddy.handoff.remove":
      requireBuddy(projection, command.buddyId);
      return [{ type: "buddy.handoff.removed", buddyId: command.buddyId, ruleId: command.ruleId }];
    case "buddy.memory.propose": {
      const buddy = requireBuddy(projection, command.buddyId);
      const clean = safeNote(command.note.text);
      const text = clean.toLowerCase();
      // A note it already has, or already proposed, is not proposed again.
      if ([...buddy.memory, ...buddy.pendingMemory].some((note) => note.text.trim().toLowerCase() === text)) return [];
      return [{ type: "buddy.memory.proposed", buddyId: command.buddyId, note: { ...command.note, text: clean } }];
    }
    case "buddy.memory.accept": {
      const buddy = requireBuddy(projection, command.buddyId);
      if (!buddy.pendingMemory.some((note) => note.noteId === command.noteId)) return [];
      return [
        {
          type: "buddy.memory.accepted",
          buddyId: command.buddyId,
          noteId: command.noteId,
          ...(command.text ? { text: safeNote(command.text) } : {}),
        },
      ];
    }
    case "buddy.memory.add": {
      const buddy = requireBuddy(projection, command.buddyId);
      const clean = safeNote(command.note.text);
      if (buddy.memory.some((note) => note.text.trim().toLowerCase() === clean.toLowerCase())) return [];
      return [{ type: "buddy.memory.added", buddyId: command.buddyId, note: { ...command.note, text: clean } }];
    }
    case "buddy.playbook.save": {
      requireBuddy(projection, command.buddyId);
      if (!projection.projects.some((project) => project.projectId === command.playbook.projectId))
        throw new DomainError("project_missing", "That project is not in ZLI.");
      const { taskId, ...rest } = command.playbook;
      return [
        {
          type: "buddy.playbook.saved",
          buddyId: command.buddyId,
          playbook: {
            ...rest,
            title: safeNote(command.playbook.title),
            steps: command.playbook.steps.map((step) => safeNote(step)),
            ...(taskId ? { taskId } : {}),
          },
        },
      ];
    }
    case "buddy.playbook.remove": {
      const buddy = requireBuddy(projection, command.buddyId);
      if (!(buddy.playbooks ?? []).some((entry) => entry.playbookId === command.playbookId)) return [];
      return [{ type: "buddy.playbook.removed", buddyId: command.buddyId, playbookId: command.playbookId }];
    }
    case "buddy.memory.remove":
      requireBuddy(projection, command.buddyId);
      return [{ type: "buddy.memory.removed", buddyId: command.buddyId, noteId: command.noteId }];
    case "buddies.pause":
      return projection.buddySettings?.paused ? [] : [{ type: "buddies.paused" }];
    case "buddies.resume":
      return projection.buddySettings?.paused ? [{ type: "buddies.resumed" }] : [];
    case "buddies.quality":
      return [{ type: "buddies.quality.changed", quality: command.quality }];
    case "task.assign": {
      const buddy = requireBuddy(projection, command.task.buddyId);
      if (buddy.archived) throw new DomainError("buddy_missing", `${buddy.name} was removed from the team.`);
      if (findTask(projection, command.task.taskId)) return [];
      if (!projection.projects.some((project) => project.projectId === command.task.projectId))
        throw new DomainError("project_missing", "That project is not in ZLI.");
      const parent = command.task.parentTaskId ? findTask(projection, command.task.parentTaskId) : undefined;
      if (command.task.parentTaskId && !parent)
        throw new DomainError("task_missing", "The job this hands on from is gone.");
      const handoffDepth = parent ? parent.handoffDepth + 1 : 0;
      if (handoffDepth > MAX_HANDOFF_DEPTH)
        throw new DomainError(
          "handoff_limit",
          `Jobs can be handed on ${MAX_HANDOFF_DEPTH} times. Ask the person before handing this on again.`,
        );
      if (parent && parent.buddyId === buddy.buddyId && command.task.origin.kind === "agent")
        throw new DomainError("handoff_invalid", "Hand this to another buddy, not yourself.");
      const open = (projection.tasks ?? []).filter((task) => task.buddyId === buddy.buddyId && isOpenTask(task)).length;
      if (open >= MAX_OPEN_JOBS)
        throw new DomainError(
          "job_limit",
          `${buddy.name} already has ${open} jobs open. Finish or drop some before giving it more.`,
        );
      return [{ type: "task.assigned", task: { ...command.task, kind: command.task.kind ?? "job" }, handoffDepth }];
    }
    case "task.prepare": {
      const task = requireTask(projection, command.taskId);
      if (task.status !== "queued") return [];
      return [{ type: "task.preparing", taskId: task.taskId }];
    }
    case "task.start": {
      const task = requireTask(projection, command.taskId);
      if (task.status !== "queued" && task.status !== "preparing") return [];
      const { type: _type, ...fields } = command;
      return [{ type: "task.started", ...fields }];
    }
    case "task.status": {
      const task = requireTask(projection, command.taskId);
      if (task.status === command.status && task.needs?.kind === command.needs?.kind && !command.nudged) return [];
      if (task.status !== command.status && !ALLOWED[task.status].includes(command.status)) return [];
      return [
        {
          type: "task.status.changed",
          taskId: task.taskId,
          status: command.status,
          ...(command.needs ? { needs: command.needs } : {}),
          ...(command.nudged ? { nudged: true as const } : {}),
        },
      ];
    }
    case "task.question.ask": {
      const task = requireOpenTask(projection, command.taskId);
      return [
        {
          type: "task.question.asked",
          taskId: task.taskId,
          question: {
            questionId: command.questionId,
            text: command.text,
            ...(command.options?.length ? { options: command.options } : {}),
          },
        },
      ];
    }
    case "task.question.answer": {
      const task = requireTask(projection, command.taskId);
      const question = task.questions.find((candidate) => candidate.questionId === command.questionId);
      if (!question) throw new DomainError("task_missing", "That question is gone.");
      if (question.answer !== undefined) return [];
      return [
        {
          type: "task.question.answered",
          taskId: task.taskId,
          questionId: question.questionId,
          answer: command.answer,
        },
      ];
    }
    case "task.finish": {
      const task = requireOpenTask(projection, command.taskId);
      return [
        {
          type: "task.finished",
          taskId: task.taskId,
          summary: command.summary,
          screenshots: command.screenshots ?? [],
        },
      ];
    }
    case "task.result": {
      const task = requireTask(projection, command.taskId);
      if (!isOpenTask(task)) return [];
      return [{ type: "task.result.recorded", taskId: task.taskId, result: command.result }];
    }
    case "task.review.attach":
      requireTask(projection, command.taskId);
      return [{ type: "task.review.attached", taskId: command.taskId, review: command.review }];
    case "task.revise": {
      const task = requireTask(projection, command.taskId);
      if (!task.threadId || !["ready", "working", "needs_you", "failed", "stopped"].includes(task.status))
        throw new DomainError("task_closed", "This job can no longer be changed. Give a new job instead.");
      return [{ type: "task.revised", taskId: task.taskId, note: command.note }];
    }
    case "task.ship": {
      const task = requireTask(projection, command.taskId);
      if (task.status !== "ready") throw new DomainError("task_closed", "Only a finished job can be shipped.");
      return [{ type: "task.shipped", taskId: task.taskId, ...(command.prUrl ? { prUrl: command.prUrl } : {}) }];
    }
    case "task.cancel": {
      const task = requireTask(projection, command.taskId);
      if (!isOpenTask(task)) return [];
      return [{ type: "task.cancelled", taskId: task.taskId }];
    }
    case "task.close": {
      const task = requireTask(projection, command.taskId);
      if (task.status === "closed" || task.status === "cancelled") return [];
      return [{ type: "task.closed", taskId: task.taskId, ...(command.undo ? { undone: true } : {}) }];
    }
    case "task.retry": {
      const task = requireTask(projection, command.taskId);
      if (!["failed", "stopped", "cancelled"].includes(task.status))
        throw new DomainError("task_closed", "Only a stopped or failed job can start again.");
      return [{ type: "task.retried", taskId: task.taskId }];
    }
    case "task.engine": {
      const task = requireOpenTask(projection, command.taskId);
      return [{ type: "task.engine.changed", taskId: task.taskId, pick: command.pick, threadId: command.threadId }];
    }
    case "routine.create": {
      requireBuddy(projection, command.routine.buddyId);
      if ((projection.routines ?? []).some((routine) => routine.routineId === command.routine.routineId)) return [];
      return [{ type: "routine.created", routine: command.routine }];
    }
    case "routine.update":
      requireRoutine(projection, command.routineId);
      if (command.changes.buddyId) requireBuddy(projection, command.changes.buddyId);
      return [{ type: "routine.updated", routineId: command.routineId, changes: command.changes }];
    case "routine.remove":
      if (!(projection.routines ?? []).some((routine) => routine.routineId === command.routineId)) return [];
      return [{ type: "routine.removed", routineId: command.routineId }];
    case "routine.setPaused": {
      const routine = requireRoutine(projection, command.routineId);
      if (routine.paused === command.paused) return [];
      return [{ type: "routine.paused.changed", routineId: routine.routineId, paused: command.paused }];
    }
    case "routine.fire": {
      const routine = requireRoutine(projection, command.routineId);
      // The same slot or GitHub event fires once, however often it is seen.
      if (routine.seen.includes(command.key) || routine.paused || projection.buddySettings?.paused) return [];
      const buddy = findBuddy(projection, routine.buddyId);
      if (!buddy || buddy.archived) return [];
      return [
        { type: "routine.fired", routineId: routine.routineId, key: command.key, taskId: command.taskId },
        {
          type: "task.assigned",
          task: {
            taskId: command.taskId,
            buddyId: routine.buddyId,
            projectId: routine.projectId,
            kind: "job",
            goal: command.goal ?? routine.goal,
            origin: { kind: "routine", routineId: routine.routineId },
          },
          handoffDepth: 0,
        },
      ];
    }
    case "buddy.home": {
      const buddy = requireBuddy(projection, command.buddyId);
      if (buddy.home?.worktreeId === command.worktreeId && buddy.home.path === command.path) return [];
      if (!projection.worktrees.some((worktree) => worktree.worktreeId === command.worktreeId))
        throw new DomainError("worktree_missing", "That home folder is not in the workspace.");
      return [{ type: "buddy.home.set", buddyId: buddy.buddyId, worktreeId: command.worktreeId, path: command.path }];
    }
    case "goal.create": {
      const lead = requireBuddy(projection, command.goal.buddyId);
      if (lead.archived) throw new DomainError("buddy_missing", `${lead.name} was removed from the team.`);
      if (findGoal(projection, command.goal.goalId)) return [];
      const projectId =
        command.goal.projectId ?? projection.projects.find((project) => isBuddyHome(project))?.projectId;
      if (!projectId || !projection.projects.some((project) => project.projectId === projectId))
        throw new DomainError("project_missing", "That project is not in ZLI.");
      const live = (projection.goals ?? []).filter((goal) => goal.status === "working" || goal.status === "needs_you");
      if (live.length >= MAX_LIVE_GOALS)
        throw new DomainError(
          "goal_limit",
          `The team already has ${live.length} goals going. Finish or stop one before adding another.`,
        );
      return [{ type: "goal.created", goal: { ...command.goal, projectId } }];
    }
    case "goal.stop": {
      const goal = requireGoal(projection, command.goalId);
      if (goal.status === "done" || goal.status === "stopped") return [];
      // Stopping a goal drops its jobs that have not started, and stops the ones running.
      const events: DomainDecision[] = [];
      for (const task of projection.tasks ?? [])
        if (task.origin.goalId === goal.goalId && isOpenTask(task) && task.status !== "ready")
          events.push({ type: "task.cancelled", taskId: task.taskId });
      events.push({ type: "goal.stopped", goalId: goal.goalId });
      return events;
    }
    case "goal.resume": {
      const goal = requireGoal(projection, command.goalId);
      if (goal.status === "working") return [];
      return [{ type: "goal.resumed", goalId: goal.goalId }];
    }
    case "goal.round": {
      const goal = requireGoal(projection, command.goalId);
      if (goal.status !== "working" || findTask(projection, command.taskId)) return [];
      const lead = findBuddy(projection, goal.buddyId);
      if (!lead || lead.archived) return [{ type: "goal.needed", goalId: goal.goalId, text: "Its lead left the team" }];
      return [
        { type: "goal.round.started", goalId: goal.goalId },
        {
          type: "task.assigned",
          task: {
            taskId: command.taskId,
            buddyId: lead.buddyId,
            projectId: goal.projectId,
            kind: "job",
            goal: goal.text,
            origin: { kind: "goal", goalId: goal.goalId },
            // A planning turn is the lead's own business: its result never lands in Needs you.
            quiet: true,
          },
          handoffDepth: 0,
        },
      ];
    }
    case "goal.finish": {
      const goal = requireGoal(projection, command.goalId);
      if (goal.status === "done" || goal.status === "stopped") return [];
      return [{ type: "goal.finished", goalId: goal.goalId, summary: command.summary }];
    }
    case "goal.needs": {
      const goal = requireGoal(projection, command.goalId);
      if (goal.status !== "working") return [];
      return [{ type: "goal.needed", goalId: goal.goalId, text: command.text }];
    }
  }
}

/** Goals running at once, so a misled chat cannot start a pile of them. */
const MAX_LIVE_GOALS = 6;

function findGoal(projection: RuntimeProjection, goalId: string) {
  return (projection.goals ?? []).find((goal) => goal.goalId === goalId);
}

function requireGoal(projection: RuntimeProjection, goalId: string) {
  const goal = findGoal(projection, goalId);
  if (!goal) throw new DomainError("goal_missing", `No goal with id ${goalId}.`);
  return goal;
}

function requireBuddy(projection: RuntimeProjection, buddyId: string): BuddyProjection {
  const buddy = findBuddy(projection, buddyId);
  if (!buddy) throw new DomainError("buddy_missing", `No buddy with id ${buddyId}.`);
  return buddy;
}

function findTask(projection: RuntimeProjection, taskId: string): TaskProjection | undefined {
  return (projection.tasks ?? []).find((task) => task.taskId === taskId);
}

function requireTask(projection: RuntimeProjection, taskId: string): TaskProjection {
  const task = findTask(projection, taskId);
  if (!task) throw new DomainError("task_missing", `No job with id ${taskId}.`);
  return task;
}

function requireOpenTask(projection: RuntimeProjection, taskId: string): TaskProjection {
  const task = requireTask(projection, taskId);
  if (!isOpenTask(task)) throw new DomainError("task_closed", "This job has ended.");
  return task;
}

function requireRoutine(projection: RuntimeProjection, routineId: string) {
  const routine = (projection.routines ?? []).find((candidate) => candidate.routineId === routineId);
  if (!routine) throw new DomainError("routine_missing", `No routine with id ${routineId}.`);
  return routine;
}

/** A note goes into every brief the buddy reads, so one that could steer or leak is never kept. */
function safeNote(text: string): string {
  const check = screenNote(text);
  if (!check.ok) throw new DomainError("memory_unsafe", `Not kept: ${check.reason}`);
  return check.text;
}
