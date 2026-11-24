import {
  CommandId,
  findBuddy,
  firstSentence,
  type GoalProjection,
  isBuddyHome,
  isBusyTask,
  isOpenTask,
  isTeam,
  MAX_OPEN_JOBS,
  type RuntimeCommand,
  type RuntimeEventEnvelope,
  type RuntimeProjection,
  type TaskProjection,
  type TeamState,
  teamReviewer,
  teamTaskState,
} from "@zli-v2/contracts";

import type { CommandReceipt, Engine } from "../orchestration/Engine.js";
import { stableId } from "./stableId.js";
import type { TeamGit } from "./teamGit.js";

export type TeamReactorOptions = {
  git: TeamGit;
  onError?: (error: unknown) => void;
};

type Team = GoalProjection & { team: TeamState };

/** The team branch's worktree id, the same after a restart. */
export function teamWorktreeId(goalId: string): string {
  return stableId(`team-worktree:${goalId}`);
}

/** The job id of one review round of a team task. */
export function teamReviewId(taskId: string, round: number): string {
  return stableId(`team-review:${taskId}:${round}`);
}

/** The job id of the buddy job resolving one task's merge conflict. */
export function teamResolveId(goalId: string, taskId: string, resumes: number): string {
  return stableId(`team-resolve:${goalId}:${taskId}:${resumes}`);
}

export function teamBranch(goal: Pick<GoalProjection, "goalId" | "text">): string {
  const slug =
    goal.text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 32)
      .replace(/-+$/u, "") || "work";
  return `team/${slug}-${goal.goalId.slice(0, 4)}`;
}

/**
 * Moves a team along once its plan went. Each task that is done gets a review job from another buddy, for as
 * many rounds as the team allows (notes go back to the task's buddy through the job reactor). When every task
 * is approved or dropped, it makes the team branch from the base and merges the approved branches into it one
 * by one, in plan order. A merge that conflicts is undone and handed to the task's buddy as a job on a branch
 * from the team branch; once that job is done its branch is merged instead. Then the diff is measured and the
 * lead's summary turn follows (the goal reactor starts it).
 *
 * Every command it sends has an id made from the team and the step, so after a restart a step is never taken
 * twice, and a merge git already made just comes back as merged.
 */
export class TeamReactor {
  private readonly unsubscribe: () => void;
  private running: Promise<void> | undefined;
  private dirty = false;
  /** How often each review assignment was refused, so the next try goes out under a key of its own. */
  private readonly refusals = new Map<string, number>();

  constructor(
    private readonly engine: Engine,
    private readonly options: TeamReactorOptions,
  ) {
    this.unsubscribe = engine.subscribe((envelope) => this.observe(envelope));
    this.schedule();
  }

  stop(): void {
    this.unsubscribe();
  }

  async waitForIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  private observe(envelope: RuntimeEventEnvelope): void {
    const type = envelope.event.type;
    if (
      type.startsWith("goal.") ||
      type.startsWith("task.") ||
      type.startsWith("worktree.") ||
      type === "buddies.resumed" ||
      type === "runtime.ready"
    )
      this.schedule();
  }

  private schedule(): void {
    this.dirty = true;
    if (this.running) return;
    this.running = this.loop().finally(() => {
      this.running = undefined;
    });
  }

  private async loop(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      try {
        const state = await this.engine.projection();
        for (const goal of state.goals ?? []) {
          if (!isTeam(goal) || goal.status !== "working") continue;
          if (goal.team.phase === "working") {
            if (!state.buddySettings?.paused) await this.review(state, goal);
            await this.startCombining(state, goal);
          } else if (goal.team.phase === "combining") await this.combine(state, goal);
        }
        // Reviews that handed in their verdict are closed, whatever the team is doing now.
        for (const goal of state.goals ?? []) {
          if (!isTeam(goal)) continue;
          for (const reviewId of finishedReviews(state, goal))
            await this.dispatch(
              { type: "task.close", taskId: reviewId },
              `team:${goal.goalId}:review-close:${reviewId}`,
            );
        }
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }

  /** Gives each finished task its next review round, once its buddy has worked in the last round's notes. */
  private async review(state: RuntimeProjection, goal: Team): Promise<void> {
    const rounds = goal.team.reviewRounds;
    if (rounds <= 0) return;
    // Reviews this pass gives out count against each reviewer's open jobs at once, not on the next read.
    const given = new Map<string, number>();
    for (const item of goal.team.plan) {
      if (!item.taskId || item.accepted) continue;
      const task = state.tasks?.find((entry) => entry.taskId === item.taskId);
      if (task?.status !== "ready" || task.undone) continue;
      const last = task.reviews.at(-1);
      if (last?.verdict === "ok" || task.reviews.length >= rounds) continue;
      const round = task.reviews.length + 1;
      const reviewId = teamReviewId(task.taskId, round);
      if (state.tasks?.some((entry) => entry.taskId === reviewId)) continue;
      // Notes came back: wait until the buddy was asked to fix every round's notes. Being ready again after that
      // ask means it finished; the reviewer's own end time is not compared, since it can land after the ask.
      if (last && task.revisions.length < task.reviews.length) continue;
      // A review already running from the buddy's own handoff rules counts as this round.
      if (
        state.tasks?.some((entry) => entry.kind === "review" && entry.parentTaskId === task.taskId && isBusyTask(entry))
      )
        continue;
      const reviewer = teamReviewer(state, goal, task);
      if (!reviewer) continue;
      // A reviewer at its open-job limit is asked again on a later pass, once a job of its closes, rather than
      // sent an assignment that is refused for good under this round's key.
      const open = (state.tasks ?? []).filter((entry) => entry.buddyId === reviewer.buddyId && isOpenTask(entry));
      if (open.length + (given.get(reviewer.buddyId) ?? 0) >= MAX_OPEN_JOBS) continue;
      const owner = findBuddy(state, task.buddyId);
      const base = `team:${goal.goalId}:review:${task.taskId}:${round}`;
      const refused = this.refusals.get(base) ?? 0;
      const receipt = await this.dispatch(
        {
          type: "task.assign",
          task: {
            taskId: reviewId,
            buddyId: reviewer.buddyId,
            projectId: task.projectId,
            kind: "review",
            goal: `Check ${owner?.name ?? "the buddy"}'s work on: ${firstSentence(item.title, 200)}`,
            origin: { kind: "primary", goalId: goal.goalId },
            parentTaskId: task.taskId,
            round,
            quiet: true,
          },
        },
        refused > 0 ? `${base}:retry-${refused}` : base,
      );
      if (receipt.status === "rejected") this.refusals.set(base, refused + 1);
      else given.set(reviewer.buddyId, (given.get(reviewer.buddyId) ?? 0) + 1);
    }
  }

  /** When every task is approved or dropped, the team branch is made and merging starts. */
  private async startCombining(state: RuntimeProjection, goal: Team): Promise<void> {
    const items = goal.team.plan.filter((item) => item.taskId);
    if (items.length === 0) return;
    const states = items.map((item) => teamTaskState(state, goal, item));
    if (states.some((entry) => entry !== "done" && entry !== "dropped")) return;
    if (!states.includes("done")) {
      await this.dispatch(
        { type: "goal.needs", goalId: goal.goalId, text: "Every task was dropped, so there is nothing to combine" },
        `team:${goal.goalId}:nothing:${goal.resumes}`,
      );
      return;
    }
    const project = state.projects.find((entry) => entry.projectId === goal.projectId);
    const worktreeId = teamWorktreeId(goal.goalId);
    const branch = teamBranch(goal);
    if (!project || isBuddyHome(project)) {
      // Web work has no branches to merge: it goes straight to the summary.
      await this.dispatch(
        { type: "goal.combine", goalId: goal.goalId, branch: "web", worktreeId },
        `team:${goal.goalId}:combine`,
      );
      await this.dispatch(
        { type: "goal.combine.done", goalId: goal.goalId, diff: { files: 0, insertions: 0, deletions: 0 } },
        `team:${goal.goalId}:combined`,
      );
      return;
    }
    if (!state.worktrees.some((entry) => entry.worktreeId === worktreeId)) {
      const workspaceRoot = `${project.path.replace(/[\\/]+$/u, "")}-worktrees`;
      const receipt = await this.dispatch(
        {
          type: "worktree.create",
          worktreeId,
          projectId: project.projectId,
          path: `${workspaceRoot}/${branch.replace(/[\\/]/gu, "-")}`,
          workspaceRoot,
          branch,
          ...(goal.team.baseRef ? { baseRef: goal.team.baseRef } : {}),
        } as RuntimeCommand,
        `team:${goal.goalId}:worktree`,
      );
      if (receipt.status === "rejected") {
        await this.needs(goal, `The team branch could not be made: ${receipt.error?.message ?? "git refused it"}`);
        return;
      }
    }
    await this.dispatch(
      { type: "goal.combine", goalId: goal.goalId, branch, worktreeId },
      `team:${goal.goalId}:combine`,
    );
  }

  /** One merge step at a time; each event it causes runs the next. */
  private async combine(state: RuntimeProjection, goal: Team): Promise<void> {
    const combine = goal.team.combine;
    if (!combine) return;
    const worktree = state.worktrees.find((entry) => entry.worktreeId === combine.worktreeId);
    if (!worktree) {
      await this.needs(goal, "The team branch's worktree is gone");
      return;
    }
    if (worktree.status === "failed" || worktree.status === "cancelled" || worktree.status === "cancelling") {
      await this.needs(goal, "The team branch could not be made");
      return;
    }
    if (worktree.status !== "ready") return;
    const tasks = state.tasks ?? [];
    const taskOf = (taskId: string | undefined) => tasks.find((entry) => entry.taskId === taskId);

    // After the person says to go on, a conflict whose fix failed is tried again from the start: they may have
    // merged it by hand, and if not, a new job gets it.
    const conflict = combine.conflict;
    if (conflict && conflict.resolveTaskId === teamResolveId(goal.goalId, conflict.taskId, goal.resumes)) {
      const resolve = taskOf(conflict.resolveTaskId);
      if (!resolve || isBusyTask(resolve)) return;
      const original = taskOf(conflict.taskId);
      const title = this.titleOf(goal, conflict.taskId);
      if (
        resolve.status === "failed" ||
        resolve.status === "stopped" ||
        resolve.status === "cancelled" ||
        resolve.undone
      ) {
        await this.needs(goal, `Merging “${firstSentence(title, 60)}” needs you: the conflict was not resolved`);
        return;
      }
      if (!resolve.branch) {
        await this.needs(goal, `Merging “${firstSentence(title, 60)}” needs you: the fix has no branch`);
        return;
      }
      const outcome = await this.mergeBranch(state, resolve, combine.worktreeId, `Merge ${original?.branch ?? title}`);
      if (outcome.kind === "merged") {
        await this.dispatch(
          { type: "goal.merge", goalId: goal.goalId, taskId: conflict.taskId },
          `team:${goal.goalId}:merge:${conflict.taskId}`,
        );
        return;
      }
      await this.needs(
        goal,
        outcome.kind === "conflict"
          ? `“${firstSentence(title, 60)}” still conflicts in ${outcome.files.slice(0, 3).join(", ")}. Fix it on ${combine.branch}`
          : `Merging “${firstSentence(title, 60)}” failed: ${outcome.message}`,
      );
      return;
    }

    const next = goal.team.plan.find(
      (item) => item.taskId && !combine.merged.includes(item.taskId) && teamTaskState(state, goal, item) === "done",
    );
    if (!next?.taskId) {
      const base =
        goal.team.baseRef ??
        state.worktrees.find((entry) => entry.projectId === goal.projectId && entry.kind === "checkout")?.branch;
      const diff = await this.options.git.diff(worktree.path, base);
      await this.dispatch(
        { type: "goal.combine.done", goalId: goal.goalId, diff },
        `team:${goal.goalId}:combined:${goal.resumes}`,
      );
      return;
    }
    const task = taskOf(next.taskId);
    if (!task?.branch) {
      // A task with no branch of its own (it worked in the project's checkout) has nothing to merge.
      await this.dispatch(
        { type: "goal.merge", goalId: goal.goalId, taskId: next.taskId },
        `team:${goal.goalId}:merge:${next.taskId}`,
      );
      return;
    }
    const outcome = await this.mergeBranch(
      state,
      task,
      combine.worktreeId,
      `Merge task: ${firstSentence(next.title, 120)}`,
    );
    if (outcome.kind === "merged") {
      await this.dispatch(
        { type: "goal.merge", goalId: goal.goalId, taskId: next.taskId },
        `team:${goal.goalId}:merge:${next.taskId}`,
      );
      return;
    }
    if (outcome.kind === "failed") {
      await this.needs(goal, `Merging “${firstSentence(next.title, 60)}” failed: ${outcome.message}`);
      return;
    }
    const owner = findBuddy(state, task.buddyId);
    const fixer = owner && !owner.archived ? owner : findBuddy(state, goal.buddyId);
    if (!fixer) {
      await this.needs(goal, `“${firstSentence(next.title, 60)}” conflicts and nobody is left to fix it`);
      return;
    }
    await this.dispatch(
      {
        type: "goal.conflict",
        goalId: goal.goalId,
        taskId: next.taskId,
        files: outcome.files,
        resolveTaskId: teamResolveId(goal.goalId, next.taskId, goal.resumes),
        buddyId: fixer.buddyId,
      },
      `team:${goal.goalId}:conflict:${next.taskId}:${goal.resumes}`,
    );
  }

  /** Commits what the job left in its worktree, then merges its branch into the team branch. */
  private async mergeBranch(state: RuntimeProjection, task: TaskProjection, teamWorktree: string, message: string) {
    const team = state.worktrees.find((entry) => entry.worktreeId === teamWorktree);
    if (!team) return { kind: "failed", message: "The team branch's worktree is gone" } as const;
    const own = state.worktrees.find((entry) => entry.worktreeId === task.worktreeId);
    if (own && own.worktreeId !== teamWorktree && own.kind !== "checkout")
      try {
        await this.options.git.commitLeftovers(own.path, firstSentence(task.goal, 72));
      } catch (error) {
        return {
          kind: "failed",
          message: error instanceof Error ? error.message.slice(0, 200) : "commit failed",
        } as const;
      }
    return this.options.git.merge(team.path, task.branch ?? "", message);
  }

  private titleOf(goal: Team, taskId: string): string {
    return goal.team.plan.find((item) => item.taskId === taskId)?.title ?? "a task";
  }

  private needs(goal: Team, text: string): Promise<CommandReceipt> {
    return this.dispatch(
      { type: "goal.needs", goalId: goal.goalId, text: text.slice(0, 300) },
      `team:${goal.goalId}:needs:${goal.resumes}:${text}`,
    );
  }

  private dispatch(command: RuntimeCommand | Record<string, unknown>, key: string): Promise<CommandReceipt> {
    return this.engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse(stableId(key)),
      command: command as RuntimeCommand,
    });
  }
}

/**
 * The team's reviews that handed in their verdict and wait as ready jobs: they have nothing left for the person, so
 * they are closed and do not fill the reviewer's open jobs.
 */
function finishedReviews(state: RuntimeProjection, goal: Team): string[] {
  const ids: string[] = [];
  for (const item of goal.team.plan) {
    const parent = item.taskId ? state.tasks?.find((entry) => entry.taskId === item.taskId) : undefined;
    if (!parent) continue;
    for (let round = 1; round <= parent.reviews.length; round += 1) {
      const review = state.tasks?.find((entry) => entry.taskId === teamReviewId(parent.taskId, round));
      if (review?.status === "ready") ids.push(review.taskId);
    }
  }
  return ids;
}
