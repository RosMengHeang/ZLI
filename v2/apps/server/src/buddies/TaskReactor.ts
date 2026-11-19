import {
  agentNameTaken,
  type BuddyProjection,
  CommandId,
  findBuddy,
  firstSentence,
  isActiveTask,
  isBuddyHome,
  isOpenTask,
  MAX_ACTIVE_JOBS,
  MAX_GOAL_ROUNDS,
  overBudget,
  type ProjectProjection,
  type ProviderDiscovery,
  type RuntimeCommand,
  type RuntimeEventEnvelope,
  type RuntimeProjection,
  type TaskProjection,
  type TaskResult,
  type WorktreeProjection,
} from "@zli-v2/contracts";

import type { CommandReceipt, Engine } from "../orchestration/Engine.js";
import { candidatesFor, modelTier, pickEngine, profileJob, trackRecords } from "./autopick.js";
import {
  answerText,
  handbackText,
  handoffGoal,
  jobBrief,
  leadBrief,
  nudgeText,
  reviewNotesText,
  reviseText,
  stepUpText,
} from "./brief.js";
import type { BuddyHomes } from "./homes.js";
import { lessonFromAnswer, lessonFromRevision } from "./lessons.js";
import { stableId } from "./stableId.js";

export type TaskReactorOptions = {
  /** The agents ZLI found. The engine's projection does not carry them. */
  providers: () => Promise<readonly ProviderDiscovery[]>;
  /** Highest share of a plan-limit window used, 0–100, by provider. Missing readings count as 0. */
  usage?: () => Promise<ReadonlyMap<string, number>>;
  now?: () => Date;
  onError?: (error: unknown) => void;
  /** How long one turn of a job's agent may run before ZLI stops it, so a stuck agent cannot run up the plan. */
  turnLimitMs?: number;
  /** How often running jobs are looked at again, so a turn over the limit is noticed without new events. */
  checkEveryMs?: number;
  /** Where web jobs run: each buddy's home. Without it, web jobs fail. */
  homes?: BuddyHomes;
};

/** How long a finished job waits for its last turn's snapshot before recording its result without it. */
const SNAPSHOT_GRACE_MS = 15_000;
/** One turn of a job's agent past this is stuck or looping, not working. */
const TURN_LIMIT_MS = 90 * 60_000;

export { stableId };

function slug(text: string, max = 32): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, max)
      .replace(/-+$/u, "") || "job"
  );
}

/** Events that need a one-time reaction, beyond keeping jobs in step with their chats. */
const REACTIONS = new Set([
  "task.question.answered",
  "task.revised",
  "task.result.recorded",
  "task.review.attached",
  "task.cancelled",
  "task.closed",
  "task.takeover.started",
  "task.takeover.ended",
]);

/**
 * Runs buddy jobs. It starts queued jobs within the limits (each in its own worktree and chat, with a
 * brief), keeps each job's status in step with its chat, records the result when the buddy calls
 * task_done, and passes work on by the buddies' handoff rules. When an Auto job gets stuck it steps up
 * to a stronger model once; when an agent hits its usage limit the job moves to the next best one.
 *
 * Every command it sends has an id made from the job and the step, so after a restart the same step is
 * never taken twice.
 */
export class TaskReactor {
  private readonly unsubscribe: () => void;
  private running: Promise<void> | undefined;
  private dirty = false;
  private reactions: RuntimeEventEnvelope[] = [];
  private readonly now: () => Date;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly engine: Engine,
    private readonly options: TaskReactorOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.unsubscribe = engine.subscribe((envelope) => this.observe(envelope));
    this.timer = setInterval(() => this.schedule(), options.checkEveryMs ?? 15_000);
    this.timer.unref?.();
    this.schedule();
  }

  stop(): void {
    this.unsubscribe();
    clearInterval(this.timer);
  }

  async waitForIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  private observe(envelope: RuntimeEventEnvelope): void {
    const type = envelope.event.type;
    if (REACTIONS.has(type)) this.reactions.push(envelope);
    if (
      type.startsWith("task.") ||
      type.startsWith("thread.") ||
      type.startsWith("worktree.") ||
      type.startsWith("buddies.") ||
      type.startsWith("buddy.") ||
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
        await this.runOnce();
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }

  /** Job attempts that already asked for their failed worktree to be made again. */
  private readonly worktreeRetries = new Set<string>();

  private async runOnce(): Promise<void> {
    const reactions = this.reactions.splice(0);
    for (const envelope of reactions) await this.react(envelope);
    const state = await this.engine.projection();
    const tasks = state.tasks ?? [];
    // Forget retries for attempts that are over, so the set does not grow for the life of the server.
    const attempts = new Set(tasks.filter((task) => task.status === "preparing").map(attemptKey));
    for (const attempt of this.worktreeRetries) if (!attempts.has(attempt)) this.worktreeRetries.delete(attempt);
    for (const task of tasks) {
      if (task.status === "preparing") await this.prepare(state, task);
      else if (task.status === "working" || task.status === "needs_you") await this.sync(state, task);
    }
    if (!state.buddySettings?.paused) await this.startQueued(await this.engine.projection());
  }

  /** Starts the oldest queued jobs that fit within each buddy's limit and the overall limit. */
  private async startQueued(state: RuntimeProjection): Promise<void> {
    const tasks = state.tasks ?? [];
    let total = tasks.filter(isActiveTask).length;
    const perBuddy = new Map<string, number>();
    for (const task of tasks) if (isActiveTask(task)) perBuddy.set(task.buddyId, (perBuddy.get(task.buddyId) ?? 0) + 1);
    const queued = tasks
      .filter((task) => task.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // A folder two jobs would share (a buddy's home for web jobs, a project's checkout for the Primary) takes one
    // job at a time: its tools find the calling job by its folder, so a second one there could report as the first.
    const places = new Set<string>();
    for (const task of tasks) {
      const place = isActiveTask(task) ? sharedPlace(state, task) : undefined;
      if (place) places.add(place);
    }
    for (const task of queued) {
      if (total >= MAX_ACTIVE_JOBS) return;
      const buddy = findBuddy(state, task.buddyId);
      if (!buddy || buddy.archived) {
        await this.dispatch({ type: "task.cancel", taskId: task.taskId }, `task:${task.taskId}:orphan`);
        continue;
      }
      const active = perBuddy.get(task.buddyId) ?? 0;
      if (active >= buddy.maxActiveJobs) continue;
      // Past its weekly budget, a buddy's new jobs wait until the person raises it or the week moves on.
      if (overBudget(state, buddy, this.now())) continue;
      // Spending lands only when a job ends, so count each running job at this week's average cost too; otherwise
      // jobs started side by side could all slip under the budget and overshoot it together.
      if (budgetReserved(state, buddy, active, this.now())) continue;
      const place = sharedPlace(state, task);
      if (place && places.has(place)) continue;
      if (place) places.add(place);
      perBuddy.set(task.buddyId, active + 1);
      total += 1;
      await this.dispatch(
        { type: "task.prepare", taskId: task.taskId },
        `task:${task.taskId}:prepare:${task.picks.length}:${task.updatedAt}`,
      );
    }
  }

  /** Where a job works: a review reads its parent's worktree, the Primary uses the project checkout. */
  private placement(state: RuntimeProjection, task: TaskProjection, buddy: BuddyProjection) {
    const parent = task.parentTaskId
      ? state.tasks?.find((candidate) => candidate.taskId === task.parentTaskId)
      : undefined;
    if (task.kind === "review" && parent?.worktreeId)
      return { worktreeId: parent.worktreeId, shared: true, create: false };
    if (buddy.role === "primary") {
      const checkout = state.worktrees.find(
        (worktree) =>
          worktree.projectId === task.projectId && worktree.kind === "checkout" && worktree.status === "ready",
      );
      if (checkout) return { worktreeId: checkout.worktreeId, shared: true, create: false };
    }
    return { worktreeId: stableId(`buddy-worktree:${task.taskId}`), shared: false, create: true };
  }

  private async prepare(state: RuntimeProjection, task: TaskProjection): Promise<void> {
    const buddy = findBuddy(state, task.buddyId);
    const project = state.projects.find((candidate) => candidate.projectId === task.projectId);
    if (!buddy || !project) {
      await this.fail(task, "Its buddy or project is gone.");
      return;
    }
    // A web job runs in the buddy's own home, with its own browser.
    if (isBuddyHome(project)) {
      const home = this.options.homes ? await this.options.homes.home(state, buddy) : undefined;
      if (!home) {
        await this.fail(task, "Its home folder could not be made.");
        return;
      }
      await this.begin(await this.engine.projection(), task, buddy, project, home, true);
      return;
    }
    const place = this.placement(state, task, buddy);
    const worktree = state.worktrees.find((candidate) => candidate.worktreeId === place.worktreeId);
    const branch = worktree?.branch ?? `${slug(buddy.name, 16)}/${slug(task.goal)}-${task.taskId.slice(0, 4)}`;
    if (!worktree) {
      if (!place.create) {
        await this.fail(task, "The worktree it should work in is gone.");
        return;
      }
      const workspaceRoot = `${project.path.replace(/[\\/]+$/u, "")}-worktrees`;
      const parent = task.parentTaskId
        ? state.tasks?.find((candidate) => candidate.taskId === task.parentTaskId)
        : undefined;
      const baseRef = task.baseRef ?? parent?.branch;
      const receipt = await this.dispatch(
        {
          type: "worktree.create",
          worktreeId: place.worktreeId,
          projectId: project.projectId,
          path: `${workspaceRoot}/${branch.replace(/[\\/]/gu, "-")}`,
          workspaceRoot,
          branch,
          ...(baseRef ? { baseRef } : {}),
        } as RuntimeCommand,
        `task:${task.taskId}:worktree`,
      );
      if (receipt.status === "rejected")
        await this.fail(task, receipt.error?.message ?? "Its worktree could not be made.");
      return;
    }
    // A failed worktree is made again once per attempt, so Try again (or a passing hiccup) can recover; failing
    // again in the same attempt ends the job.
    if (worktree.status === "failed" && place.create) {
      const attempt = attemptKey(task);
      if (!this.worktreeRetries.has(attempt)) {
        this.worktreeRetries.add(attempt);
        await this.dispatch(
          { type: "worktree.retry", worktreeId: worktree.worktreeId } as RuntimeCommand,
          `task:${task.taskId}:worktree-retry:${task.updatedAt}`,
        );
        return;
      }
    }
    if (worktree.status === "failed" || worktree.status === "cancelled" || worktree.status === "cancelling") {
      await this.fail(task, "Its worktree could not be made.");
      return;
    }
    if (worktree.status !== "ready") return;
    await this.begin(state, task, buddy, project, worktree, place.shared);
  }

  /** What kind of job this is: a lead's planning turn, a web job, or read from its goal. */
  private profileOf(state: RuntimeProjection, task: TaskProjection, project: ProjectProjection) {
    if (task.profile) return task.profile;
    if (this.goalOf(state, task)) return { kind: "plan", size: "m", risk: "low", needsBrowser: false } as const;
    const read = profileJob({ goal: task.goal, skill: task.skill, kind: task.kind, origin: task.origin.kind });
    return isBuddyHome(project) ? { ...read, kind: "web" as const, needsBrowser: true } : read;
  }

  /** The goal a job plans, when it is the lead's planning turn on it. */
  private goalOf(state: RuntimeProjection, task: TaskProjection) {
    if (task.origin.kind !== "goal" || !task.origin.goalId) return undefined;
    return (state.goals ?? []).find((goal) => goal.goalId === task.origin.goalId && goal.buddyId === task.buddyId);
  }

  /** The job's first message: a lead's plan brief, or the usual job brief. */
  private briefFor(
    state: RuntimeProjection,
    task: TaskProjection,
    buddy: BuddyProjection,
    project: ProjectProjection,
    worktree: WorktreeProjection,
  ): string {
    const goal = this.goalOf(state, task);
    if (goal) return leadBrief({ buddy, goal, state, maxRounds: MAX_GOAL_ROUNDS * (goal.resumes + 1) });
    const parent = task.parentTaskId
      ? state.tasks?.find((candidate) => candidate.taskId === task.parentTaskId)
      : undefined;
    return jobBrief({
      buddy,
      task,
      project,
      branch: worktree.branch,
      parent,
      primary: buddy.role === "primary" && !isBuddyHome(project),
      homePath: isBuddyHome(project) ? worktree.path : undefined,
      about: state.buddySettings?.aboutMe,
    });
  }

  /** Picks the agent, starts the job's chat with its brief, and marks the job started. */
  private async begin(
    state: RuntimeProjection,
    task: TaskProjection,
    buddy: BuddyProjection,
    project: ProjectProjection,
    worktree: WorktreeProjection,
    shared: boolean,
  ): Promise<void> {
    const profile = this.profileOf(state, task, project);
    const pick = await this.pick(state, task, buddy, profile);
    if (!pick) {
      await this.fail(task, "No agent can run this job. Install or sign in to one in Settings.");
      return;
    }
    const threadId = stableId(`buddy-thread:${task.taskId}:0:${task.updatedAt}`);
    const started = await this.startThread(state, task, buddy, project, worktree, threadId, pick, shared);
    if (!started) return;
    // The chat shows the job; the brief goes with it as context, so the chat is named after the job.
    await this.queue(
      threadId,
      task.goal,
      `buddy:${task.taskId}:brief`,
      this.briefFor(state, task, buddy, project, worktree),
    );
    await this.dispatch(
      {
        type: "task.start",
        taskId: task.taskId,
        threadId,
        worktreeId: worktree.worktreeId,
        branch: worktree.branch,
        profile,
        pick,
      },
      `task:${task.taskId}:start:${threadId}`,
    );
  }

  private async pick(
    state: RuntimeProjection,
    task: TaskProjection,
    buddy: BuddyProjection,
    profile: NonNullable<TaskProjection["profile"]>,
    extra: { exclude?: (provider: string) => boolean; minTier?: number } = {},
  ) {
    const tasks = state.tasks ?? [];
    const used = this.options.usage
      ? await this.options.usage().catch(() => new Map<string, number>())
      : new Map<string, number>();
    const last = [...tasks].reverse().find((candidate) => candidate.buddyId === buddy.buddyId && candidate.pick)
      ?.pick?.provider;
    const preferred = new Set(
      tasks
        .filter((candidate) => candidate.override && candidate.profile?.kind === profile.kind)
        .map((candidate) => candidate.override?.provider as string),
    );
    return pickEngine({
      buddy,
      profile,
      candidates: candidatesFor(await this.options.providers().catch(() => []), buddy, task.override),
      records: trackRecords(tasks),
      quality: state.buddySettings?.quality ?? "balanced",
      used,
      lastProvider: last,
      preferred,
      override: task.override !== undefined,
      ...(extra.exclude ? { exclude: (candidate) => extra.exclude?.(candidate.provider) ?? false } : {}),
      ...(extra.minTier !== undefined ? { minTier: extra.minTier } : {}),
      now: this.now().toISOString(),
    });
  }

  private async startThread(
    state: RuntimeProjection,
    task: TaskProjection,
    buddy: BuddyProjection,
    project: ProjectProjection,
    worktree: WorktreeProjection,
    threadId: string,
    pick: NonNullable<TaskProjection["pick"]>,
    shared: boolean,
  ): Promise<boolean> {
    let name: string | undefined;
    for (const candidate of [
      buddy.name,
      `${buddy.name} 2`,
      `${buddy.name} 3`,
      `${buddy.name} ${task.taskId.slice(0, 4)}`,
    ])
      if (!agentNameTaken(state, { projectId: project.projectId, name: candidate })) {
        name = candidate;
        break;
      }
    const receipt = await this.dispatch(
      {
        type: "thread.start",
        threadId,
        worktreeId: worktree.worktreeId,
        provider: pick.provider,
        cwd: worktree.path,
        permissionMode: pick.permissionMode,
        unattended: true,
        ...(pick.model ? { model: pick.model } : {}),
        ...(pick.accountId ? { accountId: pick.accountId } : {}),
        ...(name ? { name } : {}),
        ...(shared || state.threads.some((thread) => thread.worktreeId === worktree.worktreeId)
          ? { shareWorktree: true }
          : {}),
      } as RuntimeCommand,
      `task:${task.taskId}:thread:${threadId}`,
    );
    if (receipt.status === "rejected") {
      await this.fail(task, receipt.error?.message ?? "Its chat could not start.");
      return false;
    }
    return true;
  }

  /** Keeps a running job's status in step with its chat. */
  private async sync(state: RuntimeProjection, task: TaskProjection): Promise<void> {
    const thread = state.threads.find((candidate) => candidate.threadId === task.threadId);
    if (!thread) return;
    const request = (state.requests ?? []).find((candidate) => candidate.threadId === thread.threadId);
    if (request) {
      if (task.status !== "needs_you")
        await this.setStatus(task, "needs_you", { kind: "approval", text: "Waiting for your OK in its chat" });
      return;
    }
    if (task.status === "needs_you" && task.needs?.kind === "approval") {
      await this.setStatus(task, "working");
      return;
    }
    if (task.status === "needs_you") return;
    if (thread.status === "working") {
      const turn = (state.turns ?? []).findLast((entry) => entry.threadId === thread.threadId && !entry.completedAt);
      const limit = this.options.turnLimitMs ?? TURN_LIMIT_MS;
      if (turn && this.now().getTime() - Date.parse(turn.startedAt) > limit) {
        await this.dispatch(
          { type: "thread.stop", threadId: thread.threadId } as RuntimeCommand,
          `task:${task.taskId}:overtime:${turn.turnId}`,
        );
        await this.fail(
          task,
          `It worked for over ${Math.round(limit / 60_000)} minutes without finishing, so I stopped it. Try again, or split it into smaller jobs.`,
        );
        return;
      }
    }
    if (thread.usageLimit) {
      await this.switchAway(state, task, `${task.pick?.model ?? thread.provider} hit its usage limit`);
      return;
    }
    if (thread.status === "failed") {
      await this.stepUp(state, task, thread.errorMessage);
      return;
    }
    if (thread.status === "stopped") {
      await this.setStatus(task, "stopped");
      return;
    }
    if (thread.status !== "idle") return;
    // Idle before its first answer means the brief has not gone in yet.
    const answered = (state.messages ?? []).some(
      (message) => message.threadId === thread.threadId && message.role === "assistant",
    );
    const waiting = (state.queuedMessages ?? []).some((message) => message.threadId === thread.threadId);
    if (!answered || waiting) return;
    // The last turn's changes are snapshotted just after it ends; the result counts its files from that snapshot.
    if (this.snapshotPending(state, thread.threadId)) return;
    if (task.finished) {
      await this.recordResult(state, task, task.finished.summary, task.finished.screenshots);
      return;
    }
    if (!task.nudged) {
      await this.queue(thread.threadId, nudgeText(), `buddy:${task.taskId}:nudge:${task.revisions.length}`);
      await this.dispatch(
        { type: "task.status", taskId: task.taskId, status: "working", nudged: true },
        `task:${task.taskId}:nudged:${task.revisions.length}`,
      );
      return;
    }
    const last = [...(state.messages ?? [])]
      .reverse()
      .find((message) => message.threadId === thread.threadId && message.role === "assistant");
    await this.recordResult(
      state,
      task,
      last?.text.trim() ? firstSentence(last.text, 400) : "Finished without a summary.",
      [],
    );
  }

  /**
   * Whether the thread's last finished turn is still being snapshotted. The result waits for it, up to a short
   * grace in case no snapshot comes, as when the worktree could not be read.
   */
  private snapshotPending(state: RuntimeProjection, threadId: string): boolean {
    const turn = (state.turns ?? []).findLast((entry) => entry.threadId === threadId && entry.completedAt);
    if (!turn?.completedAt) return false;
    const ended = Date.parse(turn.completedAt);
    if (this.now().getTime() - ended > SNAPSHOT_GRACE_MS) return false;
    return !(state.checkpoints ?? []).some(
      (checkpoint) =>
        checkpoint.threadId === threadId &&
        checkpoint.recordedAt !== undefined &&
        Date.parse(checkpoint.recordedAt) >= ended,
    );
  }

  private async recordResult(
    state: RuntimeProjection,
    task: TaskProjection,
    summary: string,
    screenshots: readonly string[],
  ): Promise<void> {
    const checkpoints = (state.checkpoints ?? []).filter((checkpoint) => checkpoint.threadId === task.threadId);
    const paths = new Set<string>();
    let insertions = 0;
    let deletions = 0;
    for (const checkpoint of checkpoints) {
      for (const file of checkpoint.files) paths.add(file.path);
      insertions += checkpoint.additions;
      deletions += checkpoint.deletions;
    }
    const cost = (state.usage ?? [])
      .filter((record) => record.threadId === task.threadId)
      .reduce((sum, record) => sum + (record.usage.costUsd ?? 0), 0);
    const overlaps: TaskResult["overlaps"] = [];
    for (const other of state.tasks ?? []) {
      if (other.taskId === task.taskId || other.projectId !== task.projectId || !isOpenTask(other) || !other.threadId)
        continue;
      const shared = new Set<string>();
      for (const checkpoint of state.checkpoints ?? [])
        if (checkpoint.threadId === other.threadId)
          for (const file of checkpoint.files) if (paths.has(file.path)) shared.add(file.path);
      if (shared.size > 0) overlaps.push({ taskId: other.taskId, paths: [...shared].slice(0, 20) });
    }
    const startedAt = task.startedAt ? Date.parse(task.startedAt) : this.now().getTime();
    await this.dispatch(
      {
        type: "task.result",
        taskId: task.taskId,
        result: {
          summary: summary.slice(0, 2_000) || "Finished.",
          files: paths.size,
          insertions,
          deletions,
          screenshots: screenshots.slice(0, 8),
          ...(cost > 0 ? { costUsd: Math.round(cost * 10_000) / 10_000 } : {}),
          durationMs: Math.max(0, this.now().getTime() - startedAt),
          overlaps: overlaps.slice(0, 10),
        },
      },
      `task:${task.taskId}:result:${task.revisions.length}`,
    );
  }

  /** An Auto job that failed starts once more on a stronger model, on the same branch. */
  private async stepUp(state: RuntimeProjection, task: TaskProjection, error: string | undefined): Promise<void> {
    const buddy = findBuddy(state, task.buddyId);
    if (buddy && task.pick?.source === "auto" && task.picks.length === 0 && task.profile) {
      const pick = await this.pick(state, task, buddy, task.profile, { minTier: modelTier(task.pick.model) });
      if (
        pick &&
        (await this.moveTo(state, task, buddy, {
          ...pick,
          reason: `Stepped up to ${pick.model ?? pick.provider}: stuck on ${task.pick.model ?? task.pick.provider}`,
        }))
      )
        return;
    }
    await this.fail(task, error ? firstSentence(error, 200) : "Its agent stopped with an error.");
  }

  private async switchAway(state: RuntimeProjection, task: TaskProjection, why: string): Promise<void> {
    const buddy = findBuddy(state, task.buddyId);
    const from = task.pick?.provider;
    if (
      buddy &&
      task.profile &&
      from &&
      task.pick?.source !== "locked" &&
      task.pick?.source !== "you" &&
      task.picks.length < 3
    ) {
      const tried = new Set<string>([from, ...task.picks.map((pick) => pick.provider)]);
      const pick = await this.pick(state, task, buddy, task.profile, { exclude: (provider) => tried.has(provider) });
      if (
        pick &&
        (await this.moveTo(state, task, buddy, {
          ...pick,
          reason: `Switched to ${pick.model ?? pick.provider}: ${why}`,
        }))
      )
        return;
    }
    await this.setStatus(task, "needs_you", { kind: "stuck", text: `${why}; no other agent can take over` });
  }

  private async moveTo(
    state: RuntimeProjection,
    task: TaskProjection,
    buddy: BuddyProjection,
    pick: NonNullable<TaskProjection["pick"]>,
  ): Promise<boolean> {
    const worktree = state.worktrees.find((candidate) => candidate.worktreeId === task.worktreeId);
    const project = state.projects.find((candidate) => candidate.projectId === task.projectId);
    if (!worktree || !project || worktree.status !== "ready") return false;
    if (task.threadId)
      await this.dispatch(
        { type: "thread.stop", threadId: task.threadId } as RuntimeCommand,
        `task:${task.taskId}:stop:${task.threadId}`,
      );
    const threadId = stableId(`buddy-thread:${task.taskId}:${task.picks.length + 1}`);
    if (!(await this.startThread(state, task, buddy, project, worktree, threadId, pick, true))) return false;
    await this.queue(
      threadId,
      task.goal,
      `buddy:${task.taskId}:brief:${threadId}`,
      `${this.briefFor(state, task, buddy, project, worktree)}\n\n${stepUpText(task)}`,
    );
    await this.dispatch(
      { type: "task.engine", taskId: task.taskId, pick, threadId },
      `task:${task.taskId}:engine:${threadId}`,
    );
    return true;
  }

  /** One-time reactions: answers, change requests, handoffs, and clean-up. */
  private async react(envelope: RuntimeEventEnvelope): Promise<void> {
    const event = envelope.event;
    const state = await this.engine.projection();
    const taskId = "taskId" in event ? (event.taskId as string) : undefined;
    const task = state.tasks?.find((candidate) => candidate.taskId === taskId);
    if (!task) return;
    switch (event.type) {
      case "task.question.answered": {
        const question = task.questions.find((candidate) => candidate.questionId === event.questionId);
        if (task.threadId && question)
          await this.queue(
            task.threadId,
            answerText(question.text, event.answer),
            `buddy:${task.taskId}:answer:${event.questionId}`,
          );
        // The person's own answer is kept, so the buddy does not ask the same thing on its next job.
        if (question) await this.learn(task, lessonFromAnswer(task, question.text, event.answer), event.questionId);
        return;
      }
      case "task.revised":
        if (task.threadId)
          await this.queue(task.threadId, reviseText(event.note), `buddy:${task.taskId}:revise:${envelope.sequence}`);
        // A change the person asked for is kept at once. A reviewer's notes wait for the daily look-back.
        if (!isReviewNote(event.note))
          await this.learn(task, lessonFromRevision(task, event.note), `revise:${envelope.sequence}`);
        return;
      case "task.result.recorded":
        await this.afterResult(state, task, envelope.sequence);
        return;
      case "task.review.attached":
        await this.afterReview(state, task, event.review);
        return;
      // The person drives the buddy's browser: its turn stops so the two never click at once.
      case "task.takeover.started":
        if (task.threadId)
          await this.dispatch(
            { type: "thread.interrupt", threadId: task.threadId } as RuntimeCommand,
            `task:${task.taskId}:takeover:${envelope.sequence}`,
          );
        return;
      case "task.takeover.ended":
        if (task.threadId)
          await this.queue(
            task.threadId,
            handbackText(event.note),
            `buddy:${task.taskId}:handback:${envelope.sequence}`,
          );
        return;
      case "task.cancelled":
        if (task.threadId)
          await this.dispatch(
            { type: "thread.stop", threadId: task.threadId } as RuntimeCommand,
            `task:${task.taskId}:cancel-stop`,
          );
        return;
      case "task.closed": {
        if (!event.undone || !task.worktreeId || task.worktreeId !== stableId(`buddy-worktree:${task.taskId}`)) return;
        if (task.threadId)
          await this.dispatch(
            { type: "thread.stop", threadId: task.threadId } as RuntimeCommand,
            `task:${task.taskId}:undo-stop`,
          );
        await this.dispatch(
          { type: "worktree.remove", worktreeId: task.worktreeId, force: true, deleteBranch: true } as RuntimeCommand,
          `task:${task.taskId}:undo`,
        );
        return;
      }
    }
  }

  /** Keeps a lesson that came from the person's own words: it needs no review, they said it. */
  private async learn(
    task: TaskProjection,
    lesson: { text: string; projectId?: string | undefined; taskId?: string | undefined },
    key: string,
  ): Promise<void> {
    await this.dispatch(
      {
        type: "buddy.memory.add",
        buddyId: task.buddyId,
        note: {
          noteId: stableId(`buddy-lesson:${task.taskId}:${key}`),
          text: lesson.text,
          source: "you",
          ...(lesson.projectId ? { projectId: lesson.projectId } : {}),
          ...(lesson.taskId ? { taskId: lesson.taskId } : {}),
        },
      } as RuntimeCommand,
      `task:${task.taskId}:learn:${key}`,
    );
  }

  private async afterResult(state: RuntimeProjection, task: TaskProjection, sequence: number): Promise<void> {
    const buddy = findBuddy(state, task.buddyId);
    const parent = task.parentTaskId
      ? state.tasks?.find((candidate) => candidate.taskId === task.parentTaskId)
      : undefined;
    // A job handed on by another buddy reports back into that buddy's job. A goal's jobs report to its lead's
    // next planning turn instead, all together, once they have all ended.
    if (parent?.threadId && isOpenTask(parent) && task.kind === "job" && task.result && !task.origin.goalId)
      await this.queue(
        parent.threadId,
        `${buddy?.name ?? "A buddy"} finished the job you handed on (${firstSentence(task.goal, 80)}): ${task.result.summary}`,
        `buddy:${parent.taskId}:report:${task.taskId}:${sequence}`,
      );
    if (!buddy || task.kind === "review") return;
    // Handoff rules are for code: a planning turn or a web job is not handed on.
    if (task.profile?.kind === "plan" || task.profile?.kind === "web") return;
    for (const rule of buddy.handoffs) {
      if (!rule.enabled || rule.when !== "finished") continue;
      const to = findBuddy(state, rule.to);
      if (!to || to.archived) continue;
      const round = task.reviews.length + 1;
      if (round > rule.maxRounds) continue;
      const review = rule.action === "check";
      await this.dispatch(
        {
          type: "task.assign",
          task: {
            taskId: stableId(`handoff:${task.taskId}:${rule.ruleId}:${round}`),
            buddyId: to.buddyId,
            projectId: task.projectId,
            kind: review ? "review" : "job",
            goal: handoffGoal(rule.action, task, buddy.name),
            origin: { kind: "handoff", ruleId: rule.ruleId },
            parentTaskId: task.taskId,
            round,
            ...(task.branch && !review ? { baseRef: task.branch } : {}),
          },
        },
        `task:${task.taskId}:handoff:${rule.ruleId}:${round}`,
      );
    }
  }

  /** A review with notes goes back to the job's buddy, until the round limit; then the person decides. */
  private async afterReview(
    state: RuntimeProjection,
    task: TaskProjection,
    review: TaskProjection["reviews"][number],
  ): Promise<void> {
    if (review.verdict !== "notes" || review.notes.length === 0) return;
    const reviewer = findBuddy(state, review.buddyId);
    const owner = findBuddy(state, task.buddyId);
    const rule = owner?.handoffs.find((candidate) => candidate.to === review.buddyId && candidate.enabled);
    const maxRounds = rule?.maxRounds ?? 2;
    if (task.reviews.length >= maxRounds || task.status !== "ready") {
      if (task.status === "ready")
        await this.setStatus(task, "needs_you", {
          kind: "handoff_limit",
          text: `${reviewer?.name ?? "The reviewer"} still has notes after ${task.reviews.length} rounds`,
        });
      return;
    }
    await this.dispatch(
      { type: "task.revise", taskId: task.taskId, note: reviewNotesText(reviewer?.name ?? "A reviewer", review.notes) },
      `task:${task.taskId}:review-revise:${review.taskId}`,
    );
  }

  private async setStatus(
    task: TaskProjection,
    status: TaskProjection["status"],
    needs?: TaskProjection["needs"],
  ): Promise<void> {
    await this.dispatch(
      { type: "task.status", taskId: task.taskId, status, ...(needs ? { needs } : {}) },
      `task:${task.taskId}:status:${status}:${needs?.kind ?? ""}:${task.updatedAt}`,
    );
  }

  private async fail(task: TaskProjection, why: string): Promise<void> {
    await this.setStatus(task, "failed", { kind: "stuck", text: why.slice(0, 300) });
  }

  private queue(threadId: string, text: string, queueKey: string, context?: string): Promise<CommandReceipt> {
    return this.dispatch(
      {
        type: "thread.queue",
        threadId,
        queueId: queueKey.slice(0, 200),
        text,
        ...(context ? { context } : {}),
      } as RuntimeCommand,
      `queue:${queueKey}:${threadId}`,
    );
  }

  private dispatch(command: RuntimeCommand, key: string): Promise<CommandReceipt> {
    return this.engine.dispatchPromise({ protocolVersion: 1, commandId: CommandId.parse(stableId(key)), command });
  }
}

/** Whether a change request came from a reviewer buddy, not the person. */
function isReviewNote(note: string): boolean {
  return note.includes(" checked your work and has notes:\n");
}

/**
 * The folder a job shares with others of its kind, or undefined for a job with its own worktree: a buddy's home
 * for its web jobs, a project's checkout for the Primary's jobs there. A review reads its parent's worktree, so
 * when that is a shared folder the review holds it too: otherwise the buddy's next job could start there, change
 * the files under review, and pick up the reviewer's questions as its own.
 */
function sharedPlace(state: RuntimeProjection, task: TaskProjection): string | undefined {
  if (task.kind === "review") {
    const parent = task.parentTaskId
      ? state.tasks?.find((candidate) => candidate.taskId === task.parentTaskId)
      : undefined;
    return parent && parent.kind !== "review" ? sharedPlace(state, parent) : undefined;
  }
  const project = state.projects.find((candidate) => candidate.projectId === task.projectId);
  if (!project) return undefined;
  if (isBuddyHome(project)) return `home:${task.buddyId}`;
  if (findBuddy(state, task.buddyId)?.role !== "primary") return undefined;
  // As in placement: the Primary works in the project's checkout only when there is a ready one.
  const checkout = state.worktrees.some(
    (worktree) => worktree.projectId === task.projectId && worktree.kind === "checkout" && worktree.status === "ready",
  );
  return checkout ? `checkout:${task.projectId}` : undefined;
}

/** One preparing attempt of a job: a new attempt (Try again) changes its updatedAt. */
function attemptKey(task: TaskProjection): string {
  return `${task.taskId}:${task.updatedAt}`;
}

/**
 * What a job cost: the cost on its result, or for a failed job without one, what its chat reported spending.
 * Undefined when it reported nothing.
 */
function jobCost(state: RuntimeProjection, task: TaskProjection): number | undefined {
  if (task.result?.costUsd !== undefined) return task.result.costUsd;
  if (task.status !== "failed" || !task.threadId) return undefined;
  const cost = (state.usage ?? [])
    .filter((record) => record.threadId === task.threadId)
    .reduce((sum, record) => sum + (record.usage.costUsd ?? 0), 0);
  return cost > 0 ? cost : undefined;
}

/**
 * Whether the buddy's running jobs, each counted at this week's average job cost, would use up what is left of its
 * budget. Failed jobs that reported a cost count too. A buddy with no costs of its own this week is counted at the
 * team's average; with no costs anywhere yet, it runs one job at a time until the first one reports.
 */
export function budgetReserved(state: RuntimeProjection, buddy: BuddyProjection, active: number, now: Date): boolean {
  if (buddy.budgetUsd === undefined) return false;
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recent = (state.tasks ?? []).filter((task) => (task.endedAt ?? task.updatedAt) >= since);
  const costsOf = (tasks: readonly TaskProjection[]) =>
    tasks.map((task) => jobCost(state, task)).filter((cost): cost is number => cost !== undefined);
  const own = costsOf(recent.filter((task) => task.buddyId === buddy.buddyId));
  const spent = own.reduce((sum, cost) => sum + cost, 0);
  if (spent >= buddy.budgetUsd) return true;
  if (active === 0) return false;
  const costs = own.length > 0 ? own : costsOf(recent);
  if (costs.length === 0) return true;
  const average = costs.reduce((sum, cost) => sum + cost, 0) / costs.length;
  return spent + average * active >= buddy.budgetUsd;
}
