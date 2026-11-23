import {
  type BuddyProjection,
  buddiesInOrder,
  type GoalProjection,
  isBuddyHome,
  MAX_TEAM_TASKS,
  primaryBuddy,
  type RuntimeProjection,
  type TaskProjection,
  type TeamPlanTask,
  type TeamState,
  type TeamTaskState,
  teamDefaults,
  teamsOf,
  teamTaskState,
} from "@zli-v2/contracts";
import { useEffect, useState } from "react";

import { DiffView } from "../review/DiffView.js";
import { openExternalLink } from "../review/links.js";
import { PullRequestDialog } from "../review/PullRequestDialog.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { lookOf } from "../teammates/pixelBuddies.js";
import { Button, IconButton } from "../ui/Button.js";
import { Select } from "../ui/Field.js";
import { Switch } from "../ui/Switch.js";
import { friendlySteps } from "./stepLabel.js";
import type { Run } from "./useRun.js";
import "./teamView.css";

type Team = GoalProjection & { team: TeamState };

/** The page id of a team, as BuddiesPane and the sidebar pass it around. */
export function teamPageId(goalId: string): string {
  return `team:${goalId}`;
}

/** The team a page id names, or "new" for the New team form. */
export function teamFromPageId(pageId: string | undefined): string | undefined {
  return pageId?.startsWith("team:") ? pageId.slice("team:".length) : undefined;
}

const STATE_LABEL: Record<TeamTaskState, string> = {
  planned: "Planned",
  queued: "Up next",
  working: "Working",
  needs_you: "Waiting for you",
  in_review: "In review",
  done: "Done",
  failed: "Failed",
  dropped: "Dropped",
};

/** What the team as a whole is doing, in a word or two. */
export function teamStatus(team: Team): string {
  if (team.status === "stopped") return "Stopped";
  if (team.status === "done" || team.team.phase === "done") return "Done";
  if (team.team.phase === "plan_ready") return "Plan ready";
  if (team.status === "needs_you") return "Waiting for you";
  switch (team.team.phase) {
    case "planning":
      return "Planning";
    case "combining":
      return "Combining";
    case "summing_up":
      return "Writing summary";
    default:
      return "Working";
  }
}

function Face({ buddy, size = 18, mood }: { buddy: BuddyProjection | undefined; size?: number; mood?: "working" }) {
  if (!buddy) return null;
  return <BuddyAvatar buddy={buddy.color} look={lookOf(buddy)} image={buddy.image} size={size} mood={mood ?? "idle"} />;
}

/**
 * A team's page: the goal, the plan (editable until Go), a live board of its tasks, the lead's notes, and at the
 * end the summary with the combined diff and a way to open a pull request.
 */
export function TeamView({
  projection,
  goalId,
  run,
  onOpenThread,
  onSelect,
}: {
  projection: RuntimeProjection;
  goalId: string;
  run: Run;
  /** Opens a task's chat. */
  onOpenThread(threadId: string): void;
  /** Opens a buddy's page. */
  onSelect(buddyId: string): void;
}) {
  const team = teamsOf(projection).find((entry) => entry.goalId === goalId);
  if (!team)
    return (
      <div className="team-view">
        <p className="team-empty">This team is gone.</p>
      </div>
    );
  const buddies = projection.buddies ?? [];
  const lead = buddies.find((buddy) => buddy.buddyId === team.buddyId);
  const live = team.status === "working" || team.status === "needs_you";
  const phase = team.team.phase;
  const status = teamStatus(team);
  return (
    <div className="team-view">
      <header className="team-head">
        <div className="team-head-text">
          <h2 className="team-goal">{team.text}</h2>
          <p className="team-meta">
            {lead ? (
              <button type="button" className="team-lead" onClick={() => onSelect(lead.buddyId)}>
                <Face buddy={lead} size={16} />
                Led by {lead.name}
              </button>
            ) : null}
            <span className={`team-status is-${team.status === "needs_you" ? "waiting" : team.status}`}>{status}</span>
          </p>
        </div>
        {live ? (
          <Button size="sm" variant="ghost" onClick={() => void run({ type: "goal.stop", goalId })}>
            Stop team
          </Button>
        ) : null}
      </header>

      {team.status === "needs_you" && team.needs && phase !== "plan_ready" ? (
        <section className="team-card team-needs" aria-label="Waiting for you">
          <p>{team.needs}.</p>
          <Button size="sm" variant="primary" onClick={() => void run({ type: "goal.resume", goalId })}>
            Keep going
          </Button>
        </section>
      ) : null}

      {team.team.notes ? (
        <section className="team-card team-notes" aria-label="Notes from the lead">
          <h3 className="team-heading">Notes from {lead?.name ?? "the lead"}</h3>
          <p>{team.team.notes}</p>
        </section>
      ) : null}

      {phase === "planning" ? (
        <p className="team-hint">{lead?.name ?? "The lead"} is writing the plan.</p>
      ) : phase === "plan_ready" ? (
        <PlanEditor
          key={team.team.plan.map((item) => item.planTaskId).join()}
          team={team}
          projection={projection}
          run={run}
        />
      ) : (
        <TaskBoard team={team} projection={projection} run={run} onOpenThread={onOpenThread} />
      )}

      {team.team.combine && phase !== "working" ? (
        <Combine team={team} projection={projection} onOpenThread={onOpenThread} />
      ) : null}

      {phase === "summing_up" || phase === "done" || team.summary ? (
        <Summary team={team} projection={projection} run={run} />
      ) : null}
    </div>
  );
}

/* ---------- Plan ---------- */

type Draft = { planTaskId: string; title: string; buddyId: string; notes: string };

/** The plan before Go: reassign, edit, remove, or add tasks, then Go. */
function PlanEditor({ team, projection, run }: { team: Team; projection: RuntimeProjection; run: Run }) {
  const people = buddiesInOrder(projection);
  const [draft, setDraft] = useState<Draft[]>(() =>
    team.team.plan.map((item) => ({
      planTaskId: item.planTaskId,
      title: item.title,
      buddyId: item.buddyId ?? team.buddyId,
      notes: item.notes ?? "",
    })),
  );
  const [busy, setBusy] = useState(false);
  const change = (index: number, fields: Partial<Draft>) =>
    setDraft((rows) => rows.map((row, at) => (at === index ? { ...row, ...fields } : row)));
  const ready = draft.length > 0 && draft.every((row) => row.title.trim());
  const go = async () => {
    if (!ready || busy) return;
    setBusy(true);
    await run({
      type: "goal.plan.approve",
      goalId: team.goalId,
      plan: draft.map((row) => ({
        planTaskId: row.planTaskId,
        title: row.title.trim(),
        buddyId: row.buddyId,
        ...(row.notes.trim() ? { notes: row.notes.trim() } : {}),
      })),
    });
    setBusy(false);
  };
  return (
    <section className="team-section" aria-label="Plan">
      <h3 className="team-heading">Plan</h3>
      <ol className="team-plan">
        {draft.map((row, index) => (
          <li key={row.planTaskId} className="team-card team-plan-row">
            <div className="team-plan-top">
              <input
                className="input input-sm team-plan-title"
                aria-label={`Task ${index + 1}`}
                maxLength={200}
                value={row.title}
                onChange={(event) => change(index, { title: event.target.value })}
              />
              <Select
                label={`Buddy for task ${index + 1}`}
                value={row.buddyId}
                className="team-plan-buddy"
                options={people.map((buddy) => ({ value: buddy.buddyId, label: buddy.name, description: buddy.title }))}
                onChange={(buddyId) => change(index, { buddyId })}
              />
              <IconButton
                label={`Remove task ${index + 1}`}
                icon="x"
                size="sm"
                onClick={() => setDraft((rows) => rows.filter((_, at) => at !== index))}
              />
            </div>
            <textarea
              className="input team-plan-notes"
              aria-label={`Notes for task ${index + 1}`}
              rows={2}
              maxLength={2_000}
              placeholder="What done looks like"
              value={row.notes}
              onChange={(event) => change(index, { notes: event.target.value })}
            />
          </li>
        ))}
      </ol>
      <footer className="team-plan-actions">
        <Button
          size="sm"
          variant="ghost"
          icon="plus"
          disabled={draft.length >= MAX_TEAM_TASKS}
          onClick={() =>
            setDraft((rows) => [
              ...rows,
              { planTaskId: makeCommandId(), title: "", buddyId: people[0]?.buddyId ?? team.buddyId, notes: "" },
            ])
          }
        >
          Add task
        </Button>
        <span className="team-spacer" />
        <Button size="sm" variant="primary" icon="play" loading={busy} disabled={!ready} onClick={() => void go()}>
          Go
        </Button>
      </footer>
    </section>
  );
}

/* ---------- Board ---------- */

/** The tasks once the plan went: who does each, where it is, what it is doing now, and a way into its chat. */
function TaskBoard({
  team,
  projection,
  run,
  onOpenThread,
}: {
  team: Team;
  projection: RuntimeProjection;
  run: Run;
  onOpenThread(threadId: string): void;
}) {
  const buddies = projection.buddies ?? [];
  const tasks = projection.tasks ?? [];
  const working = team.team.phase === "working" && team.status !== "stopped";
  const done = team.team.plan.filter((item) => teamTaskState(projection, team, item) === "done").length;
  return (
    <section className="team-section" aria-label="Tasks">
      <h3 className="team-heading">
        Tasks{" "}
        <span className="team-count">
          {done} of {team.team.plan.length} done
        </span>
      </h3>
      <ul className="team-card team-board">
        {team.team.plan.map((item) => (
          <TaskRow
            key={item.planTaskId}
            item={item}
            state={teamTaskState(projection, team, item)}
            task={tasks.find((entry) => entry.taskId === item.taskId)}
            buddy={buddies.find((entry) => entry.buddyId === item.buddyId)}
            projection={projection}
            canChange={working}
            onOpenThread={onOpenThread}
            onDrop={() =>
              void run({ type: "goal.task.drop", goalId: team.goalId, taskId: item.taskId ?? item.planTaskId })
            }
            onAccept={() =>
              item.taskId ? void run({ type: "goal.task.accept", goalId: team.goalId, taskId: item.taskId }) : undefined
            }
            onRetry={() => (item.taskId ? void run({ type: "task.retry", taskId: item.taskId }) : undefined)}
          />
        ))}
      </ul>
      {working && team.team.plan.length < MAX_TEAM_TASKS ? (
        <AddTask team={team} projection={projection} run={run} />
      ) : null}
    </section>
  );
}

function TaskRow({
  item,
  state,
  task,
  buddy,
  projection,
  canChange,
  onOpenThread,
  onDrop,
  onAccept,
  onRetry,
}: {
  item: TeamPlanTask;
  state: TeamTaskState;
  task: TaskProjection | undefined;
  buddy: BuddyProjection | undefined;
  projection: RuntimeProjection;
  canChange: boolean;
  onOpenThread(threadId: string): void;
  onDrop(): void;
  onAccept(): void;
  onRetry(): void;
}) {
  const threadId = task?.threadId;
  const reviewer = (projection.tasks ?? []).findLast(
    (entry) => entry.kind === "review" && entry.parentTaskId === task?.taskId,
  );
  const step =
    state === "working" && threadId
      ? friendlySteps((projection.activities ?? []).filter((activity) => activity.threadId === threadId)).at(-1)?.label
      : undefined;
  const reviewerName = reviewer
    ? projection.buddies?.find((entry) => entry.buddyId === reviewer.buddyId)?.name
    : undefined;
  const detail =
    step ??
    (state === "in_review" && reviewerName
      ? `${reviewerName} is reviewing`
      : state === "needs_you"
        ? (task?.needs?.text ?? "Waiting for you")
        : state === "failed"
          ? (task?.needs?.text ?? "It stopped before it finished")
          : state === "done"
            ? task?.result?.summary
            : undefined);
  return (
    <li className={`team-task is-${state}`}>
      <span className="team-task-mark" aria-hidden="true" />
      <Face buddy={buddy} size={18} {...(state === "working" ? { mood: "working" as const } : {})} />
      <span className="team-task-text">
        <span className="team-task-title">{item.title}</span>
        <span className="team-task-meta">
          {buddy?.name ?? "Unassigned"} · {STATE_LABEL[state]}
          {detail ? ` · ${detail}` : ""}
        </span>
      </span>
      <span className="team-task-actions">
        {state === "needs_you" && task?.needs?.kind === "handoff_limit" ? (
          <Button size="xs" variant="secondary" onClick={onAccept}>
            Use as is
          </Button>
        ) : null}
        {state === "failed" && canChange ? (
          <Button size="xs" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        {threadId ? (
          <Button size="xs" variant="ghost" onClick={() => onOpenThread(threadId)}>
            Open chat
          </Button>
        ) : null}
        {canChange && state !== "done" && state !== "dropped" ? (
          <IconButton label={`Stop ${item.title}`} icon="x" size="sm" onClick={onDrop} />
        ) : null}
      </span>
    </li>
  );
}

/** Adds a task while the team works. It starts at once. */
function AddTask({ team, projection, run }: { team: Team; projection: RuntimeProjection; run: Run }) {
  const people = buddiesInOrder(projection);
  const [title, setTitle] = useState("");
  const [buddyId, setBuddyId] = useState(people.find((buddy) => buddy.role !== "primary")?.buddyId ?? team.buddyId);
  const add = async () => {
    if (!title.trim()) return;
    const ok = await run({
      type: "goal.task.add",
      goalId: team.goalId,
      task: { planTaskId: makeCommandId(), title: title.trim(), buddyId },
    });
    if (ok) setTitle("");
  };
  return (
    <form
      className="team-add"
      aria-label="Add a task"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <input
        className="input input-sm"
        aria-label="New task"
        placeholder="Add a task"
        maxLength={200}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Select
        label="Buddy for the new task"
        value={buddyId}
        className="team-plan-buddy"
        options={people.map((buddy) => ({ value: buddy.buddyId, label: buddy.name }))}
        onChange={setBuddyId}
      />
      <Button size="sm" type="submit" disabled={!title.trim()}>
        Add
      </Button>
    </form>
  );
}

/* ---------- Combine and summary ---------- */

function Combine({
  team,
  projection,
  onOpenThread,
}: {
  team: Team;
  projection: RuntimeProjection;
  onOpenThread(threadId: string): void;
}) {
  const combine = team.team.combine;
  if (!combine || combine.branch === "web") return null;
  const approved = team.team.plan.filter((item) => item.taskId && teamTaskState(projection, team, item) === "done");
  const conflict = combine.conflict;
  const fix = conflict ? projection.tasks?.find((task) => task.taskId === conflict.resolveTaskId) : undefined;
  const fixer = fix ? projection.buddies?.find((buddy) => buddy.buddyId === fix.buddyId) : undefined;
  const title = conflict ? team.team.plan.find((item) => item.taskId === conflict.taskId)?.title : undefined;
  return (
    <section className="team-card team-combine" aria-label="Combine">
      <p className="team-combine-line">
        <span className="team-branch">{combine.branch}</span>
        {team.team.phase === "combining"
          ? ` · merged ${combine.merged.length} of ${approved.length}`
          : ` · ${combine.merged.length} task${combine.merged.length === 1 ? "" : "s"} merged`}
      </p>
      {conflict ? (
        <div className="team-conflict">
          <p>
            “{title ?? "A task"}” conflicts in {conflict.files.slice(0, 3).join(", ") || "some files"}.{" "}
            {fixer ? `${fixer.name} is resolving it.` : ""}
          </p>
          {fix?.threadId ? (
            <Button size="xs" variant="ghost" onClick={() => onOpenThread(fix.threadId as string)}>
              Open chat
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Summary({ team, projection, run }: { team: Team; projection: RuntimeProjection; run: Run }) {
  const { bridge } = useRuntime();
  const [creating, setCreating] = useState(false);
  const combine = team.team.combine;
  const worktree = combine ? projection.worktrees.find((entry) => entry.worktreeId === combine.worktreeId) : undefined;
  const project = projection.projects.find((entry) => entry.projectId === team.projectId);
  const code = project !== undefined && !isBuddyHome(project) && combine?.branch !== "web";
  const diff = combine?.diff;
  return (
    <section className="team-card team-summary" aria-label="Summary">
      <h3 className="team-heading">Summary</h3>
      {team.summary ? (
        <p className="team-summary-text">{team.summary}</p>
      ) : (
        <p className="team-hint">The lead is writing the summary.</p>
      )}
      {code && diff ? (
        <p className="team-diffstat">
          {diff.files} file{diff.files === 1 ? "" : "s"} changed <span className="team-plus">+{diff.insertions}</span>{" "}
          <span className="team-minus">−{diff.deletions}</span>
        </p>
      ) : null}
      {code && worktree ? (
        <>
          <div className="team-summary-actions">
            {team.team.prUrl ? (
              <Button
                size="sm"
                icon="pullRequest"
                onClick={() => void openExternalLink(bridge, team.team.prUrl as string)}
              >
                Open pull request
              </Button>
            ) : (
              <Button size="sm" variant="primary" icon="pullRequest" onClick={() => setCreating(true)}>
                Create PR
              </Button>
            )}
          </div>
          <CombinedDiff
            worktreeId={worktree.worktreeId}
            baseRef={team.team.baseRef ?? "HEAD"}
            projection={projection}
          />
          {creating ? (
            <PullRequestDialog
              worktree={worktree}
              base={team.team.baseRef}
              onClose={() => setCreating(false)}
              onCreated={(pullRequest) => void run({ type: "goal.pr", goalId: team.goalId, prUrl: pullRequest.url })}
              onCommitFirst={() => setCreating(false)}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** The team branch against its base, one file list, each file's diff a click away. */
function CombinedDiff({
  worktreeId,
  baseRef,
  projection,
}: {
  worktreeId: string;
  baseRef: string;
  projection: RuntimeProjection;
}) {
  const { dispatch } = useRuntime();
  const [open, setOpen] = useState<string>();
  const review = projection.reviews?.find((entry) => entry.worktreeId === worktreeId);
  const send = (command: Record<string, unknown>) =>
    dispatch({ protocolVersion: 1, commandId: makeCommandId(), command }).catch(() => undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the diff is read once per branch and base.
  useEffect(() => {
    void send({ type: "review.refresh", worktreeId, baseRef });
  }, [worktreeId, baseRef]);
  const files = review?.baseRef === baseRef ? review.files : [];
  if (files.length === 0) return null;
  return (
    <div className="team-diff">
      <ul className="team-diff-files">
        {files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className={`team-diff-file${open === file.path ? " is-open" : ""}`}
              aria-expanded={open === file.path}
              onClick={() => {
                const next = open === file.path ? undefined : file.path;
                setOpen(next);
                if (next) void send({ type: "review.diff", worktreeId, path: next });
              }}
            >
              <span className="team-diff-path">{file.path}</span>
              <span className="team-plus">+{file.additions}</span>
              <span className="team-minus">−{file.deletions}</span>
            </button>
            {open === file.path && review?.diff?.path === file.path ? (
              <DiffView worktreeId={worktreeId} diff={review.diff} />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- New team ---------- */

/**
 * Start a team: the goal, who works on it (or let the lead pick), where, and whether the plan starts at once.
 * Primary leads it.
 */
export function NewTeam({
  projection,
  run,
  projectId,
  onCreated,
}: {
  projection: RuntimeProjection;
  run: Run;
  projectId: string | undefined;
  onCreated(goalId: string): void;
}) {
  const people = buddiesInOrder(projection);
  const lead = primaryBuddy(projection) ?? people[0];
  const projects = projection.projects.filter((project) => !isBuddyHome(project));
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [where, setWhere] = useState(
    projectId && projects.some((project) => project.projectId === projectId)
      ? projectId
      : (projects[0]?.projectId ?? ""),
  );
  const [autoStart, setAutoStart] = useState(teamDefaults(projection.buddySettings).autoStart);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    const goal = text.trim();
    if (!goal || !lead || !where || busy) return;
    setBusy(true);
    const goalId = makeCommandId();
    const ok = await run({
      type: "goal.create",
      goal: {
        goalId,
        buddyId: lead.buddyId,
        text: goal,
        projectId: where,
        team: { autoStart, ...(picked.size > 0 ? { buddyIds: [...picked] } : {}) },
      },
    });
    setBusy(false);
    if (ok) onCreated(goalId);
  };
  const toggle = (buddyId: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(buddyId)) next.delete(buddyId);
      else next.add(buddyId);
      return next;
    });
  return (
    <form
      className="team-view team-new"
      aria-label="New team"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <header className="team-head">
        <h2 className="team-goal">New team</h2>
      </header>
      <p className="team-hint">
        {lead?.name ?? "Primary"} plans the goal into tasks, each buddy works in its own branch, and the work comes back
        merged on one branch.
      </p>
      <textarea
        className="input team-new-goal"
        aria-label="Goal"
        rows={3}
        maxLength={4_000}
        placeholder="What should the team do? Like: add dark mode to Settings, with tests"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <section className="team-section" aria-label="Who works on it">
        <h3 className="team-heading">Who works on it</h3>
        <div className="team-picks">
          <button
            type="button"
            className={`team-pick${picked.size === 0 ? " is-on" : ""}`}
            aria-pressed={picked.size === 0}
            onClick={() => setPicked(new Set())}
          >
            Let {lead?.name ?? "Primary"} pick
          </button>
          {people
            .filter((buddy) => buddy.buddyId !== lead?.buddyId)
            .map((buddy) => (
              <button
                key={buddy.buddyId}
                type="button"
                className={`team-pick${picked.has(buddy.buddyId) ? " is-on" : ""}`}
                aria-pressed={picked.has(buddy.buddyId)}
                onClick={() => toggle(buddy.buddyId)}
              >
                <Face buddy={buddy} size={16} />
                {buddy.name}
              </button>
            ))}
        </div>
      </section>
      <div className="team-new-row">
        {projects.length > 1 ? (
          <Select
            label="Project"
            value={where}
            className="team-plan-buddy"
            options={projects.map((project) => ({ value: project.projectId, label: project.name }))}
            onChange={setWhere}
          />
        ) : null}
        <Switch checked={autoStart} onChange={setAutoStart} label="Start the plan without checking it first" />
        <span className="team-spacer" />
        <Button type="submit" variant="primary" loading={busy} disabled={!text.trim() || !where || !lead}>
          Start team
        </Button>
      </div>
      {projects.length === 0 ? <p className="team-hint">Add a project first. Teams work on code.</p> : null}
    </form>
  );
}

/** The teams going now, newest first, for the sidebar and the buddy list. */
export function liveTeams(projection: RuntimeProjection): Team[] {
  return teamsOf(projection).filter((team) => team.status === "working" || team.status === "needs_you");
}
