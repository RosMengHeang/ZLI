import {
  type BuddyProjection,
  buddiesInOrder,
  buddyNamed,
  isActiveTask,
  isOpenTask,
  type ProjectProjection,
  RoutineTrigger,
  type RuntimeProjection,
  type TaskProjection,
  taskLine,
} from "@zli-v2/contracts";
import { z } from "zod";

import { BrowserControlError } from "../browser/BrowserControlActions.js";

export const BUDDY_ACTIONS = [
  "buddydone",
  "buddyask",
  "buddyremember",
  "buddyverdict",
  "buddyhandoff",
  "buddylist",
  "buddyassign",
  "buddystatus",
  "buddyrevise",
  "buddyroutine",
] as const;
export type BuddyAction = (typeof BUDDY_ACTIONS)[number];

export type BuddyActionHost = {
  projection(): RuntimeProjection;
  /** The caller's worktree and project, from its cwd. */
  caller(input: Record<string, unknown>, state: RuntimeProjection): { worktreeId: string; project: ProjectProjection };
  run(command: Record<string, unknown>): Promise<unknown>;
  newId(): string;
};

const Text = (max: number) => z.string().trim().min(1).max(max);
const Inputs = {
  buddydone: z.object({ summary: Text(2_000), screenshots: z.array(Text(4_000)).max(8).optional() }),
  buddyask: z.object({ question: Text(2_000), options: z.array(Text(200)).max(6).optional() }),
  buddyremember: z.object({ note: Text(400) }),
  buddyverdict: z.object({ verdict: z.enum(["ok", "notes"]), notes: z.array(Text(1_000)).max(20).optional() }),
  buddyhandoff: z.object({ buddy: Text(40).optional(), goal: Text(4_000), project: Text(200).optional() }),
  buddylist: z.object({}),
  buddyassign: z.object({
    buddy: Text(40),
    goal: Text(4_000),
    project: Text(200).optional(),
    baseRef: Text(255).optional(),
  }),
  buddystatus: z.object({ taskId: Text(200).optional() }),
  buddyrevise: z.object({ taskId: Text(200), note: Text(2_000) }),
  buddyroutine: z.object({
    buddy: Text(40),
    goal: Text(4_000),
    project: Text(200).optional(),
    schedule: Text(100).optional(),
    when: z.enum(["ci_failed", "review_requested", "issue_labeled"]).optional(),
    branch: Text(255).optional(),
    label: Text(100).optional(),
  }),
} satisfies Record<BuddyAction, z.ZodType>;

function parse<A extends BuddyAction>(action: A, raw: unknown): z.infer<(typeof Inputs)[A]> {
  const parsed = Inputs[action].safeParse(raw);
  if (!parsed.success) throw new BrowserControlError(parsed.error.issues[0]?.message ?? "Check the tool input.", 400);
  return parsed.data as z.infer<(typeof Inputs)[A]>;
}

/** Words in a goal that suit each kind of buddy, read from its title or name. */
const SUITS: ReadonlyArray<[RegExp, RegExp]> = [
  [/test|qa/iu, /\b(tests?|spec|coverage|flaky|e2e)\b/iu],
  [/doc|writer/iu, /\b(docs?|readme|changelog|release notes|document)\b/iu],
  [/review/iu, /\b(review|check|look over)\b/iu],
  [/release|ship/iu, /\b(release|version|changelog|tag)\b/iu],
  [/triage|bug/iu, /\b(bug|issue|crash|triage)\b/iu],
  [/build|dev|engineer/iu, /\b(build|add|implement|fix|feature|make)\b/iu],
];

/** The buddy that best suits a goal: by title, then the least busy. Never the caller. */
export function suitedBuddy(
  state: RuntimeProjection,
  goal: string,
  exceptBuddyId?: string,
): BuddyProjection | undefined {
  const team = buddiesInOrder(state).filter((buddy) => buddy.buddyId !== exceptBuddyId && buddy.role !== "primary");
  const busy = (buddy: BuddyProjection) =>
    (state.tasks ?? []).filter((task) => task.buddyId === buddy.buddyId && isActiveTask(task)).length;
  const scored = team.map((buddy) => {
    const label = `${buddy.title ?? ""} ${buddy.name}`;
    const fit = SUITS.some(([who, what]) => who.test(label) && what.test(goal)) ? 1 : 0;
    return { buddy, score: fit * 10 - busy(buddy) };
  });
  scored.sort((left, right) => right.score - left.score || left.buddy.order - right.buddy.order);
  return scored[0]?.buddy;
}

function summary(state: RuntimeProjection, task: TaskProjection) {
  const buddy = (state.buddies ?? []).find((candidate) => candidate.buddyId === task.buddyId);
  return {
    taskId: task.taskId,
    buddy: buddy?.name ?? "?",
    status: task.status,
    line: taskLine(task),
    goal: task.goal,
    ...(task.branch ? { branch: task.branch } : {}),
    ...(task.result ? { result: task.result.summary, files: task.result.files } : {}),
    ...(task.pick ? { setup: `${task.pick.model ?? task.pick.provider} · ${task.pick.reason}` } : {}),
  };
}

/** The tools buddies use from inside a job, and the Primary's planning tools. */
export function createBuddyActions(host: BuddyActionHost): Record<BuddyAction, (raw: unknown) => Promise<unknown>> {
  /** The job the caller is working on, found by its worktree. */
  const callerJob = (
    raw: unknown,
    prefer?: "review",
  ): { state: RuntimeProjection; task: TaskProjection; project: ProjectProjection } => {
    const state = host.projection();
    const { worktreeId, project } = host.caller((raw ?? {}) as Record<string, unknown>, state);
    const open = (state.tasks ?? []).filter((task) => task.worktreeId === worktreeId && isOpenTask(task));
    const task =
      open.find((candidate) => prefer === "review" && candidate.kind === "review" && candidate.status === "working") ??
      open.find((candidate) => candidate.status === "working" && candidate.kind !== "review") ??
      open.find((candidate) => candidate.status === "working") ??
      open.at(-1);
    if (!task)
      throw new BrowserControlError(
        "This chat is not a buddy job. Buddy tools work inside jobs that buddies were given.",
        404,
      );
    return { state, task, project };
  };

  const projectFor = (state: RuntimeProjection, ref: string | undefined, fallback: ProjectProjection) => {
    if (!ref) return fallback;
    const wanted = ref.toLowerCase();
    const project = state.projects.find(
      (candidate) => candidate.projectId === ref || candidate.name.toLowerCase() === wanted,
    );
    if (!project) throw new BrowserControlError(`No project called ${ref}.`, 404);
    return project;
  };

  const buddyFor = (state: RuntimeProjection, ref: string) => {
    const buddy = buddyNamed(state, ref) ?? (state.buddies ?? []).find((candidate) => candidate.buddyId === ref);
    if (!buddy || buddy.archived)
      throw new BrowserControlError(
        `No buddy called ${ref}. The team: ${buddiesInOrder(state)
          .map((candidate) => candidate.name)
          .join(", ")}.`,
        404,
      );
    return buddy;
  };

  /** The Primary's tools work from its job or from its own chat in the project checkout. */
  const primaryContext = (raw: unknown) => {
    const state = host.projection();
    const { worktreeId, project } = host.caller((raw ?? {}) as Record<string, unknown>, state);
    const job = (state.tasks ?? []).find((task) => task.worktreeId === worktreeId && isOpenTask(task));
    return { state, project, job };
  };

  return {
    buddydone: async (raw) => {
      const input = parse("buddydone", raw);
      const { task } = callerJob(raw);
      await host.run({
        type: "task.finish",
        taskId: task.taskId,
        summary: input.summary,
        ...(input.screenshots ? { screenshots: input.screenshots } : {}),
      });
      return { done: true, note: "Recorded. End your turn now; the person gets the result card." };
    },
    buddyask: async (raw) => {
      const input = parse("buddyask", raw);
      const { task } = callerJob(raw);
      await host.run({
        type: "task.question.ask",
        taskId: task.taskId,
        questionId: host.newId(),
        text: input.question,
        ...(input.options ? { options: input.options } : {}),
      });
      return {
        asked: true,
        note: "The person sees it in Needs you. End your turn; the answer arrives as your next message.",
      };
    },
    buddyremember: async (raw) => {
      const input = parse("buddyremember", raw);
      const { task } = callerJob(raw);
      await host.run({
        type: "buddy.memory.propose",
        buddyId: task.buddyId,
        note: {
          noteId: host.newId(),
          text: input.note,
          source: "told",
          projectId: task.projectId,
          taskId: task.taskId,
        },
      });
      return { proposed: true, note: "The person decides whether to keep it." };
    },
    buddyverdict: async (raw) => {
      const input = parse("buddyverdict", raw);
      const { task } = callerJob(raw, "review");
      if (task.kind !== "review" || !task.parentTaskId)
        throw new BrowserControlError("review_verdict is for review jobs. Use task_done for other jobs.", 409);
      const notes = input.notes ?? [];
      if (input.verdict === "notes" && notes.length === 0)
        throw new BrowserControlError("List the notes the other buddy should fix.", 400);
      await host.run({
        type: "task.review.attach",
        taskId: task.parentTaskId,
        review: { taskId: task.taskId, buddyId: task.buddyId, verdict: input.verdict, notes },
      });
      await host.run({
        type: "task.finish",
        taskId: task.taskId,
        summary: input.verdict === "ok" ? "Looks good." : `Notes: ${notes.join("; ").slice(0, 1_900)}`,
      });
      return { recorded: true };
    },
    buddyhandoff: async (raw) => {
      const input = parse("buddyhandoff", raw);
      const { state, task, project } = callerJob(raw);
      const buddy = input.buddy ? buddyFor(state, input.buddy) : suitedBuddy(state, input.goal, task.buddyId);
      if (!buddy) throw new BrowserControlError("There is no other buddy to hand this to.", 404);
      const taskId = host.newId();
      await host.run({
        type: "task.assign",
        task: {
          taskId,
          buddyId: buddy.buddyId,
          projectId: projectFor(state, input.project, project).projectId,
          kind: "job",
          goal: input.goal,
          origin: { kind: "agent" },
          parentTaskId: task.taskId,
          ...(task.branch ? { baseRef: task.branch } : {}),
        },
      });
      return {
        handedTo: buddy.name,
        taskId,
        note: `${buddy.name} starts on its own branch from yours. Its result comes back here as a message; carry on with your part.`,
      };
    },
    buddylist: async () => {
      const state = host.projection();
      return {
        paused: state.buddySettings?.paused ?? false,
        buddies: buddiesInOrder(state).map((buddy) => ({
          name: buddy.name,
          ...(buddy.title ? { title: buddy.title } : {}),
          role: buddy.role,
          engine: buddy.engine.mode === "auto" ? "auto" : `${buddy.engine.mode} ${buddy.engine.provider}`,
          ...(buddy.lastLine ? { latest: buddy.lastLine.text } : {}),
          jobs: (state.tasks ?? [])
            .filter((task) => task.buddyId === buddy.buddyId && isOpenTask(task))
            .map((task) => summary(state, task)),
        })),
      };
    },
    buddyassign: async (raw) => {
      const input = parse("buddyassign", raw);
      const { state, project, job } = primaryContext(raw);
      const buddy = buddyFor(state, input.buddy);
      const taskId = host.newId();
      await host.run({
        type: "task.assign",
        task: {
          taskId,
          buddyId: buddy.buddyId,
          projectId: projectFor(state, input.project, project).projectId,
          kind: "job",
          goal: input.goal,
          origin: { kind: "primary" },
          ...(job ? { parentTaskId: job.taskId } : {}),
          ...(input.baseRef ? { baseRef: input.baseRef } : {}),
        },
      });
      return { assigned: buddy.name, taskId };
    },
    buddystatus: async (raw) => {
      const input = parse("buddystatus", raw);
      const state = host.projection();
      if (input.taskId) {
        const task = (state.tasks ?? []).find((candidate) => candidate.taskId.startsWith(input.taskId as string));
        if (!task) throw new BrowserControlError(`No job ${input.taskId}.`, 404);
        return summary(state, task);
      }
      const day = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      return {
        open: (state.tasks ?? []).filter(isOpenTask).map((task) => summary(state, task)),
        finishedToday: (state.tasks ?? [])
          .filter((task) => !isOpenTask(task) && (task.endedAt ?? task.updatedAt) > day)
          .map((task) => summary(state, task)),
      };
    },
    buddyrevise: async (raw) => {
      const input = parse("buddyrevise", raw);
      const state = host.projection();
      const task = (state.tasks ?? []).find((candidate) => candidate.taskId.startsWith(input.taskId));
      if (!task) throw new BrowserControlError(`No job ${input.taskId}.`, 404);
      await host.run({ type: "task.revise", taskId: task.taskId, note: input.note });
      return { revised: true };
    },
    buddyroutine: async (raw) => {
      const input = parse("buddyroutine", raw);
      const { state, project } = primaryContext(raw);
      const buddy = buddyFor(state, input.buddy);
      const trigger = RoutineTrigger.safeParse(
        input.schedule
          ? { kind: "schedule", cron: input.schedule }
          : input.when === "ci_failed"
            ? { kind: "ci_failed", branch: input.branch ?? "main" }
            : input.when === "issue_labeled"
              ? { kind: "issue_labeled", label: input.label }
              : { kind: input.when ?? "" },
      );
      if (!trigger.success)
        throw new BrowserControlError(
          'Give schedule as five-field cron, such as "0 9 * * 1-5", or when as ci_failed, review_requested or issue_labeled (with label).',
          400,
        );
      const routineId = host.newId();
      await host.run({
        type: "routine.create",
        routine: {
          routineId,
          buddyId: buddy.buddyId,
          projectId: projectFor(state, input.project, project).projectId,
          goal: input.goal,
          trigger: trigger.data,
          paused: false,
        },
      });
      return {
        created: true,
        routineId,
        note: "The person sees it under the buddy's routines and can pause or remove it.",
      };
    },
  };
}
