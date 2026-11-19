import { execFile } from "node:child_process";

import {
  CommandId,
  type RoutineProjection,
  type RuntimeCommand,
  type RuntimeEventEnvelope,
  type RuntimeProjection,
} from "@zli-v2/contracts";

import type { Engine } from "../orchestration/Engine.js";
import { latestSlot, parseCron } from "./cron.js";
import { lookback } from "./lessons.js";
import { stableId } from "./TaskReactor.js";

export type RunGh = (args: readonly string[], cwd: string) => Promise<string>;

export type RoutineReactorOptions = {
  now?: () => Date;
  gh?: RunGh;
  /** How often schedules are checked. */
  tickMs?: number;
  /** How often GitHub is asked about event routines. */
  githubMs?: number;
  /** The local hour after which the daily look-back runs. */
  lookbackHour?: number;
  onError?: (error: unknown) => void;
};

const defaultGh: RunGh = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile("gh", [...args], { cwd, timeout: 20_000, windowsHide: true, maxBuffer: 2_000_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

type Found = { key: string; at: string | undefined; detail: string };

/**
 * Starts routine jobs. Schedules are checked every 30 seconds; slots missed while ZLI was closed or the
 * computer slept collapse into one run. Event routines ask GitHub through `gh` every two minutes, only
 * for projects that have them. Every slot and event has a key, and a key fires once.
 *
 * Once a day it also runs each buddy's look-back, which proposes up to three lessons from the day's jobs
 * for the person to keep or skip.
 */
export class RoutineReactor {
  private readonly unsubscribe: () => void;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private running: Promise<void> | undefined;
  private readonly now: () => Date;
  private readonly gh: RunGh;

  constructor(
    private readonly engine: Engine,
    private readonly options: RoutineReactorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.gh = options.gh ?? defaultGh;
    this.unsubscribe = engine.subscribe((envelope: RuntimeEventEnvelope) => {
      if (envelope.event.type.startsWith("routine.") || envelope.event.type === "buddies.resumed") void this.tick();
    });
    const tick = setInterval(() => void this.tick(), options.tickMs ?? 30_000);
    const github = setInterval(() => void this.pollGitHub(), options.githubMs ?? 120_000);
    tick.unref?.();
    github.unref?.();
    this.timers.push(tick, github);
  }

  stop(): void {
    this.unsubscribe();
    for (const timer of this.timers) clearInterval(timer);
  }

  async waitForIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Checks schedules and the look-back now. */
  tick(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.engine.projection();
      if (state.buddySettings?.paused) return;
      const now = this.now();
      for (const routine of state.routines ?? []) {
        if (routine.paused || routine.trigger.kind !== "schedule") continue;
        let cron: ReturnType<typeof parseCron>;
        try {
          cron = parseCron(routine.trigger.cron);
        } catch {
          continue;
        }
        const after = new Date(routine.lastRunAt ?? routine.createdAt);
        const slot = latestSlot(cron, after, now);
        if (slot) await this.fire(routine, `slot:${slot.toISOString()}`);
      }
      await this.lookback(state, now);
    });
  }

  /** Asks GitHub about event routines now. */
  pollGitHub(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.engine.projection();
      if (state.buddySettings?.paused) return;
      for (const routine of state.routines ?? []) {
        if (routine.paused || routine.trigger.kind === "schedule") continue;
        const project = state.projects.find((candidate) => candidate.projectId === routine.projectId);
        if (!project) continue;
        let found: Found[];
        try {
          found = await this.events(routine, project.path);
        } catch (error) {
          this.options.onError?.(error);
          continue;
        }
        for (const item of found) {
          // Only what happened after the routine was made, so a new routine does not fire for old events.
          if (routine.seen.includes(item.key) || (item.at && item.at < routine.createdAt)) continue;
          await this.fire(routine, item.key, `${routine.goal}\n\n${item.detail}`);
        }
      }
    });
  }

  private async events(routine: RoutineProjection, cwd: string): Promise<Found[]> {
    const trigger = routine.trigger;
    if (trigger.kind === "ci_failed") {
      const runs = JSON.parse(
        await this.gh(
          [
            "run",
            "list",
            "--branch",
            trigger.branch,
            "--status",
            "failure",
            "--limit",
            "5",
            "--json",
            "databaseId,headSha,workflowName,createdAt,url",
          ],
          cwd,
        ),
      ) as Array<{ databaseId: number; headSha: string; workflowName: string; createdAt?: string; url?: string }>;
      return runs.map((run) => ({
        key: `ci:${run.databaseId}`,
        at: run.createdAt,
        detail: `CI failed: ${run.workflowName} on ${trigger.branch} (${run.headSha.slice(0, 7)}). See the log with: gh run view ${run.databaseId} --log-failed`,
      }));
    }
    if (trigger.kind === "review_requested") {
      const prs = JSON.parse(
        await this.gh(["pr", "list", "--search", "review-requested:@me", "--json", "number,title,url,updatedAt"], cwd),
      ) as Array<{ number: number; title: string; url: string; updatedAt?: string }>;
      return prs.map((pr) => ({
        key: `review:${pr.number}`,
        at: pr.updatedAt,
        detail: `Review requested on PR #${pr.number}: ${pr.title} (${pr.url}). Read it with gh pr diff ${pr.number}.`,
      }));
    }
    if (trigger.kind === "issue_labeled") {
      const issues = JSON.parse(
        await this.gh(
          ["issue", "list", "--label", trigger.label, "--state", "open", "--json", "number,title,url,updatedAt"],
          cwd,
        ),
      ) as Array<{ number: number; title: string; url: string; updatedAt?: string }>;
      return issues.map((issue) => ({
        key: `issue:${issue.number}:${trigger.label}`,
        at: issue.updatedAt,
        detail: `Issue #${issue.number} is labeled ${trigger.label}: ${issue.title} (${issue.url}). Read it with gh issue view ${issue.number}.`,
      }));
    }
    return [];
  }

  private async lookback(state: RuntimeProjection, now: Date): Promise<void> {
    if (now.getHours() < (this.options.lookbackHour ?? 18)) return;
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    for (const buddy of state.buddies ?? []) {
      if (buddy.archived) continue;
      const lessons = lookback(buddy, state.tasks ?? [], since);
      for (const [index, lesson] of lessons.entries())
        await this.dispatch(
          {
            type: "buddy.memory.propose",
            buddyId: buddy.buddyId,
            note: {
              noteId: stableId(`lesson:${buddy.buddyId}:${day}:${index}`),
              text: lesson.text,
              source: "lookback",
              ...(lesson.projectId ? { projectId: lesson.projectId } : {}),
              ...(lesson.taskId ? { taskId: lesson.taskId } : {}),
            },
          },
          `lookback:${buddy.buddyId}:${day}:${index}`,
        );
    }
  }

  private async fire(routine: RoutineProjection, key: string, goal?: string): Promise<void> {
    await this.dispatch(
      {
        type: "routine.fire",
        routineId: routine.routineId,
        key,
        taskId: stableId(`routine-task:${routine.routineId}:${key}`),
        ...(goal ? { goal: goal.slice(0, 4_000) } : {}),
      },
      `routine:${routine.routineId}:${key}`,
    );
  }

  private async dispatch(command: RuntimeCommand, key: string): Promise<void> {
    try {
      await this.engine.dispatchPromise({ protocolVersion: 1, commandId: CommandId.parse(stableId(key)), command });
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private exclusive(work: () => Promise<void>): Promise<void> {
    const previous = this.running ?? Promise.resolve();
    const next = previous
      .then(work)
      .catch((error) => this.options.onError?.(error))
      .finally(() => {
        if (this.running === next) this.running = undefined;
      });
    this.running = next;
    return next;
  }
}
