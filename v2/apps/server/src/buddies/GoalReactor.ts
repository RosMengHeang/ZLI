import {
  CommandId,
  findBuddy,
  type GoalProjection,
  goalTasks,
  isBusyTask,
  isTeam,
  MAX_GOAL_ROUNDS,
  type RuntimeCommand,
  type RuntimeEventEnvelope,
  type RuntimeProjection,
} from "@zli-v2/contracts";

import type { CommandReceipt, Engine } from "../orchestration/Engine.js";
import { stableId } from "./stableId.js";

export type GoalReactorOptions = {
  onError?: (error: unknown) => void;
};

/**
 * Keeps goals moving. A goal's lead gets a planning turn, as a job, whenever none of the goal's jobs are
 * running or waiting to run: first when the goal is made, then each time the jobs it handed out have all
 * ended. It never polls the agents and never runs a turn while work is going, so a goal costs its jobs and
 * a short planning turn between them. After MAX_GOAL_ROUNDS turns without the lead calling goal_done, it
 * stops and asks the person.
 */
export class GoalReactor {
  private readonly unsubscribe: () => void;
  private running: Promise<void> | undefined;
  private dirty = false;

  constructor(
    private readonly engine: Engine,
    private readonly options: GoalReactorOptions = {},
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
    if (type.startsWith("goal.") || type.startsWith("task.") || type === "buddies.resumed" || type === "runtime.ready")
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
        await this.closePlans(state);
        if (state.buddySettings?.paused) continue;
        for (const goal of state.goals ?? []) if (goal.status === "working") await this.tend(state, goal);
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }

  private async tend(state: RuntimeProjection, goal: GoalProjection): Promise<void> {
    const lead = findBuddy(state, goal.buddyId);
    if (!lead || lead.archived) {
      await this.dispatch(
        { type: "goal.needs", goalId: goal.goalId, text: "Its lead left the team. Pick a new lead or stop it." },
        `goal:${goal.goalId}:no-lead`,
      );
      return;
    }
    const tasks = goalTasks(state, goal.goalId);
    // Running, waiting to run, or waiting on the person: the lead never plans around work in flight.
    if (tasks.some(isBusyTask)) return;
    // A team plans once; after the plan goes, its jobs, reviews and the merge move it on, not the lead.
    if (isTeam(goal) && goal.team.phase !== "planning") {
      if (goal.team.phase === "summing_up") await this.sumUp(state, goal);
      return;
    }
    // Only planning turns since the person last said keep going count toward giving up.
    const current = new Set(
      Array.from({ length: goal.rounds }, (_, index) => roundTaskId(goal.goalId, index + 1, goal.resumes)),
    );
    const plans = tasks.filter((task) => current.has(task.taskId));
    const lastPlan = plans.at(-1);
    // A planning turn that failed twice in a row means the lead cannot plan this; the person decides.
    const failedPlans = plans.slice(-2).filter((task) => task.status === "failed" || task.status === "stopped");
    if (failedPlans.length >= 2) {
      await this.dispatch(
        { type: "goal.needs", goalId: goal.goalId, text: "The lead could not plan its next step twice in a row" },
        `goal:${goal.goalId}:plan-failed:${lastPlan?.taskId ?? ""}`,
      );
      return;
    }
    if (goal.rounds >= MAX_GOAL_ROUNDS * (goal.resumes + 1)) {
      await this.dispatch(
        {
          type: "goal.needs",
          goalId: goal.goalId,
          text: `Planned ${goal.rounds} times without finishing. Keep going, or stop it`,
        },
        `goal:${goal.goalId}:rounds:${goal.rounds}`,
      );
      return;
    }
    // A planning turn that handed nothing out and did not finish the goal would only plan the same again.
    // A team's lead hands in a plan instead, which moves the team out of planning.
    if (lastPlan && (isTeam(goal) || !handedOut(state, goal, lastPlan.taskId))) {
      const ended = lastPlan.status === "ready" || lastPlan.status === "closed" || lastPlan.status === "shipped";
      if (ended) {
        await this.dispatch(
          {
            type: "goal.needs",
            goalId: goal.goalId,
            text: isTeam(goal)
              ? "The lead did not hand in a plan. Tell it what to do next"
              : "The lead handed nothing out and did not call the goal done. Tell it what to do next",
          },
          `goal:${goal.goalId}:idle:${lastPlan.taskId}`,
        );
        return;
      }
    }
    await this.dispatch(
      { type: "goal.round", goalId: goal.goalId, taskId: roundTaskId(goal.goalId, goal.rounds + 1, goal.resumes) },
      `goal:${goal.goalId}:round:${goal.rounds + 1}:${goal.resumes}`,
    );
  }

  /**
   * Once a team's work is on one branch, its lead gets one more turn to write the summary. If that turn ends
   * without goal_done, what the lead said last stands in for it, so the team never hangs on a missing call.
   */
  private async sumUp(state: RuntimeProjection, goal: GoalProjection): Promise<void> {
    const taskId = summaryTaskId(goal.goalId, goal.resumes);
    const turn = (state.tasks ?? []).find((task) => task.taskId === taskId);
    if (!turn) {
      await this.dispatch(
        { type: "goal.round", goalId: goal.goalId, taskId },
        `team:${goal.goalId}:summary:${goal.resumes}`,
      );
      return;
    }
    if (isBusyTask(turn)) return;
    const said = turn.finished?.summary ?? turn.result?.summary;
    await this.dispatch(
      {
        type: "goal.finish",
        goalId: goal.goalId,
        summary: (said ?? "The team finished. The combined diff is on the team branch.").slice(0, 2_000),
      },
      `team:${goal.goalId}:summary-done:${goal.resumes}`,
    );
  }

  /**
   * A finished planning turn has nothing for the person to ship, so it is closed rather than left open, where it
   * would count toward the lead's open jobs.
   */
  private async closePlans(state: RuntimeProjection): Promise<void> {
    for (const task of state.tasks ?? []) {
      if (task.origin.kind !== "goal" || task.status !== "ready") continue;
      const goal = (state.goals ?? []).find((entry) => entry.goalId === task.origin.goalId);
      if (goal?.buddyId === task.buddyId)
        await this.dispatch({ type: "task.close", taskId: task.taskId }, `goal-plan-close:${task.taskId}`);
    }
  }

  private dispatch(command: RuntimeCommand, key: string): Promise<CommandReceipt> {
    return this.engine.dispatchPromise({ protocolVersion: 1, commandId: CommandId.parse(stableId(key)), command });
  }
}

/** The job id of a goal's planning turn, the same after a restart. */
export function roundTaskId(goalId: string, round: number, resumes: number): string {
  return stableId(`goal-round:${goalId}:${round}:${resumes}`);
}

/** The job id of a team lead's summary turn, the same after a restart. */
export function summaryTaskId(goalId: string, resumes: number): string {
  return stableId(`team-summary:${goalId}:${resumes}`);
}

/** Whether a planning turn gave out any job. */
function handedOut(state: RuntimeProjection, goal: GoalProjection, planTaskId: string): boolean {
  return goalTasks(state, goal.goalId).some((task) => task.parentTaskId === planTaskId);
}
