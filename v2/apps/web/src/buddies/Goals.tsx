import {
  buddiesInOrder,
  type GoalProjection,
  goalTasks,
  isBusyTask,
  primaryBuddy,
  type RuntimeProjection,
  type TaskProjection,
  taskLine,
} from "@zli-v2/contracts";
import { useState } from "react";

import { makeCommandId } from "../runtime/commandId.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { lookOf } from "../teammates/pixelBuddies.js";
import { Button } from "../ui/Button.js";
import { Select } from "../ui/Field.js";
import type { Run } from "./useRun.js";

/** Where a goal is planned from: a project, or the web, from the lead's home. */
const WEB = "web";

/** The project id of the buddies' homes, read from a buddy's home folder. The app lists no such project. */
export function homeProjectId(projection: RuntimeProjection): string | undefined {
  for (const buddy of projection.buddies ?? []) {
    const home = projection.worktrees.find((entry) => entry.worktreeId === buddy.home?.worktreeId);
    if (home) return home.projectId;
  }
  return undefined;
}

/** Whether a job runs on the web, in a buddy's home, rather than in a project. */
export function isWebTask(task: TaskProjection, projection: RuntimeProjection): boolean {
  return task.profile?.kind === "web" || task.projectId === homeProjectId(projection);
}

/** Whether a job is a lead's own planning turn on its goal, which the goal card shows as "Planning". */
export function isPlanTurn(task: TaskProjection, goals: readonly GoalProjection[] | undefined): boolean {
  if (task.origin.kind !== "goal") return false;
  return (goals ?? []).some((goal) => goal.goalId === task.origin.goalId && goal.buddyId === task.buddyId);
}

/**
 * One box for a goal: say the outcome, and a team starts on it. Its lead plans it and hands the tasks to the team.
 * Nobody has to pick who does what; the lead and where it works can be changed before it starts.
 */
export function GoalComposer({
  projection,
  run,
  projectId,
  onCreated,
}: {
  projection: RuntimeProjection;
  run: Run;
  projectId: string | undefined;
  /** Opens the new team's page. */
  onCreated?: ((goalId: string) => void) | undefined;
}) {
  const team = buddiesInOrder(projection);
  const [text, setText] = useState("");
  const [lead, setLead] = useState(primaryBuddy(projection)?.buddyId ?? team[0]?.buddyId ?? "");
  const projects = projection.projects;
  const [where, setWhere] = useState(
    projectId && projects.some((project) => project.projectId === projectId)
      ? projectId
      : (projects[0]?.projectId ?? WEB),
  );
  const [busy, setBusy] = useState(false);
  const leadId = team.some((buddy) => buddy.buddyId === lead) ? lead : (team[0]?.buddyId ?? "");
  const start = async () => {
    const goal = text.trim();
    if (!goal || !leadId || busy) return;
    setBusy(true);
    const goalId = makeCommandId();
    const ok = await run({
      type: "goal.create",
      goal: { goalId, buddyId: leadId, text: goal, ...(where === WEB ? {} : { projectId: where }), team: {} },
    });
    setBusy(false);
    if (ok) {
      setText("");
      onCreated?.(goalId);
    }
  };
  return (
    <form
      className="goal-composer"
      aria-label="New goal"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <textarea
        className="goal-composer-text"
        aria-label="Goal"
        rows={2}
        maxLength={4_000}
        placeholder="Give the team a goal, like “Add a dark mode to Settings, with tests”"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void start();
          }
        }}
      />
      <div className="goal-composer-row">
        <Select
          label="Lead"
          value={leadId}
          className="goal-composer-pick"
          options={team.map((buddy) => ({
            value: buddy.buddyId,
            label: buddy.name,
            description: buddy.role === "primary" ? "Primary: plans and hands out work" : (buddy.title ?? "Buddy"),
          }))}
          onChange={setLead}
        />
        <Select
          label="Where"
          value={where}
          className="goal-composer-pick"
          options={[
            ...projects.map((project) => ({ value: project.projectId, label: project.name, description: "Code" })),
            { value: WEB, label: "Web", description: "In the buddies' own browsers" },
          ]}
          onChange={setWhere}
        />
        <span className="buddy-spacer" />
        <Button type="submit" variant="primary" size="sm" icon="arrowUp" disabled={!text.trim() || busy}>
          Start
        </Button>
      </div>
    </form>
  );
}

const GOAL_STATE: Record<GoalProjection["status"], string> = {
  working: "Working",
  needs_you: "Needs you",
  done: "Done",
  stopped: "Stopped",
};

const FINISHED = new Set<TaskProjection["status"]>(["ready", "shipped", "closed"]);

/** A goal: its lead, how far the team got, each job it gave out, and what it needs from the person. */
export function GoalCard({
  goal,
  projection,
  run,
  onSelect,
}: {
  goal: GoalProjection;
  projection: RuntimeProjection;
  run: Run;
  onSelect(buddyId: string): void;
}) {
  const buddies = projection.buddies ?? [];
  const lead = buddies.find((buddy) => buddy.buddyId === goal.buddyId);
  const all = goalTasks(projection, goal.goalId);
  const jobs = all.filter((task) => !isPlanTurn(task, projection.goals));
  const planning = all.some((task) => isPlanTurn(task, projection.goals) && isBusyTask(task));
  const finished = jobs.filter((task) => FINISHED.has(task.status)).length;
  const state =
    goal.status === "working"
      ? planning
        ? "Planning"
        : jobs.some(isBusyTask)
          ? "Working"
          : "Up next"
      : GOAL_STATE[goal.status];
  return (
    <article className={`goal-card is-${goal.status}`} aria-label={`Goal: ${goal.text}`}>
      <header className="goal-card-head">
        {lead ? (
          <button type="button" className="goal-card-lead" onClick={() => onSelect(lead.buddyId)}>
            <BuddyAvatar
              buddy={lead.color}
              look={lookOf(lead)}
              image={lead.image}
              size={18}
              mood={planning ? "thinking" : "idle"}
            />
            Led by {lead.name}
          </button>
        ) : (
          <span className="goal-card-lead">No lead</span>
        )}
        <span className={`goal-card-state is-${planning ? "planning" : goal.status}`}>{state}</span>
      </header>
      <p className="goal-card-text">{goal.text}</p>
      {jobs.length > 0 ? (
        <div className="goal-card-progress">
          <span className="goal-card-bar" aria-hidden="true">
            <span style={{ width: `${Math.round((finished / jobs.length) * 100)}%` }} />
          </span>
          <span className="goal-card-count">
            {finished} of {jobs.length} done
          </span>
        </div>
      ) : null}
      {jobs.length > 0 ? (
        <ul className="goal-card-jobs">
          {jobs.map((task) => {
            const buddy = buddies.find((entry) => entry.buddyId === task.buddyId);
            return (
              <li key={task.taskId} className={`goal-card-job is-${task.status}`}>
                {buddy ? <BuddyAvatar buddy={buddy.color} look={lookOf(buddy)} image={buddy.image} size={14} /> : null}
                <span className="goal-card-job-line">{taskLine(task)}</span>
              </li>
            );
          })}
        </ul>
      ) : goal.status === "working" ? (
        <p className="goal-card-hint">{lead?.name ?? "The lead"} is breaking it into jobs for the team.</p>
      ) : null}
      {goal.status === "needs_you" && goal.needs ? <p className="goal-card-needs">{goal.needs}.</p> : null}
      {goal.summary ? <p className="goal-card-summary">{goal.summary}</p> : null}
      {goal.team ? (
        <footer className="goal-card-actions">
          <Button size="sm" variant="secondary" icon="users" onClick={() => onSelect(`team:${goal.goalId}`)}>
            Open team
          </Button>
        </footer>
      ) : goal.status === "working" || goal.status === "needs_you" ? (
        <footer className="goal-card-actions">
          {goal.status === "needs_you" ? (
            <Button size="sm" variant="primary" onClick={() => void run({ type: "goal.resume", goalId: goal.goalId })}>
              Keep going
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void run({ type: "goal.stop", goalId: goal.goalId })}>
            Stop
          </Button>
        </footer>
      ) : null}
    </article>
  );
}

/** How many ended goals the board keeps in view. */
const ENDED_SHOWN = 3;

/** The goals on the team board: the ones going first, then the last few that ended. */
export function GoalList({
  projection,
  run,
  onSelect,
}: {
  projection: RuntimeProjection;
  run: Run;
  onSelect(buddyId: string): void;
}) {
  const goals = projection.goals ?? [];
  const live = goals.filter((goal) => goal.status === "working" || goal.status === "needs_you");
  const ended = goals
    .filter((goal) => goal.status === "done" || goal.status === "stopped")
    .sort((left, right) => (right.endedAt ?? right.updatedAt).localeCompare(left.endedAt ?? left.updatedAt))
    .slice(0, ENDED_SHOWN);
  if (live.length === 0 && ended.length === 0) return null;
  return (
    <div className="goal-list">
      {[...live, ...ended].map((goal) => (
        <GoalCard key={goal.goalId} goal={goal} projection={projection} run={run} onSelect={onSelect} />
      ))}
    </div>
  );
}
