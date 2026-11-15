import {
  type BuddyColor,
  type BuddyProjection,
  type BuddyQuality,
  buddiesInOrder,
  type HandoffAction,
  isActiveTask,
  isOpenTask,
  needsYou,
  openQuestion,
  type PermissionMode,
  type ProviderKind,
  type RoutineProjection,
  type RuntimeProjection,
  type TaskProjection,
  taskLine,
} from "@zli-v2/contracts";
import { type FormEvent, useMemo, useState } from "react";

import { listedDiscoveries, providerDisplayName } from "../agent/providers.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { useAppSettings } from "../settings/appSettings.js";
import { type AvatarMood, BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { BUDDY_COLOR_NAMES, buddyName } from "../teammates/buddies.js";
import { Button, IconButton } from "../ui/Button.js";
import { Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { Segmented } from "../ui/Segmented.js";
import { BuddyChat } from "./BuddyChat.js";
import {
  BUDDY_TEMPLATES,
  buddyFromTemplate,
  buddyStats,
  duration,
  exportBuddy,
  freeName,
  money,
  parseBuddyFile,
  SCHEDULES,
  starterTeam,
  template,
  triggerLabel,
} from "./team.js";
import "./buddies.css";

export type Run = (command: Record<string, unknown>) => Promise<boolean>;

function useRun(setError: (message: string | undefined) => void): Run {
  const { dispatch } = useRuntime();
  return async (command) => {
    setError(undefined);
    try {
      const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
      if (response?.accepted === false) {
        setError(response.error.message);
        return false;
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not go through.");
      return false;
    }
  };
}

/** How a buddy looks right now, from its open jobs. */
export function buddyMood(buddy: BuddyProjection, tasks: readonly TaskProjection[]): AvatarMood {
  const own = tasks.filter((task) => task.buddyId === buddy.buddyId);
  if (own.some((task) => task.status === "needs_you")) return "waiting";
  if (own.some((task) => task.status === "working" || task.status === "preparing")) return "working";
  const latest = own.at(-1);
  if (latest?.status === "failed") return "failed";
  return "idle";
}

export type BuddiesPaneProps = {
  projection: RuntimeProjection;
  /** The buddy whose page is open; none shows the team. */
  selectedId: string | undefined;
  onSelect(buddyId: string | undefined): void;
  /** Opens a job's chat. */
  onOpenThread(threadId: string): void;
  /** Opens the pull request panel for a job's chat. */
  onOpenPullRequest(threadId: string): void;
  /** The project the person is looking at, for new jobs. */
  projectId: string | undefined;
};

export function BuddiesPane(props: BuddiesPaneProps) {
  const { projection, selectedId, onSelect } = props;
  const [error, setError] = useState<string>();
  const run = useRun(setError);
  const team = buddiesInOrder(projection);
  const selected = team.find((buddy) => buddy.buddyId === selectedId);
  const paused = projection.buddySettings?.paused ?? false;

  return (
    <section className="tool-pane buddies-pane" aria-label="Buddies">
      <div className="pane-header buddies-bar">
        {selected ? (
          <IconButton label="All buddies" icon="arrowLeft" size="sm" onClick={() => onSelect(undefined)} />
        ) : (
          <Icon name="bot" size={14} className="buddies-bar-icon" />
        )}
        <h2 className="buddies-bar-title">{selected ? selected.name : "Buddies"}</h2>
        {team.length > 0 ? (
          <Button
            size="sm"
            variant={paused ? "primary" : "ghost"}
            icon={paused ? "play" : "pause"}
            tooltip={
              paused ? "Let buddies start jobs and routines again" : "No new jobs or routines start until you resume"
            }
            onClick={() => void run({ type: paused ? "buddies.resume" : "buddies.pause" })}
          >
            {paused ? "Resume" : "Pause all"}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="inline-error buddies-error" role="alert">
          {error}
        </p>
      ) : null}
      {paused ? <p className="buddies-paused">Paused. Running jobs finish; nothing new starts.</p> : null}
      <div className={`buddies-body${selected && team.length > 0 ? " is-page" : ""}`}>
        {team.length === 0 ? (
          <Welcome run={run} projection={projection} />
        ) : selected ? (
          <BuddyPage {...props} buddy={selected} run={run} />
        ) : (
          <TeamPage {...props} team={team} run={run} />
        )}
      </div>
    </section>
  );
}

/* ---------- First run ---------- */

function Welcome({ run, projection }: { run: Run; projection: RuntimeProjection }) {
  const { teammates } = useAppSettings();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    const { buddies, handoff } = starterTeam(makeCommandId);
    for (const buddy of buddies) if (!(await run({ type: "buddy.create", buddy }))) break;
    await run({
      type: "buddy.handoff.set",
      buddyId: handoff.from,
      rule: { ruleId: handoff.ruleId, when: "finished", to: handoff.to, action: "check", maxRounds: 2, enabled: true },
    });
    const primary = buddies[0];
    const project = projection.projects[0];
    if (primary && project)
      await run({
        type: "routine.create",
        routine: {
          routineId: makeCommandId(),
          buddyId: primary.buddyId,
          projectId: project.projectId,
          goal: "Write the morning brief: what each buddy did since yesterday, what is waiting on the person, and what is next. Use task_status. Keep it to six lines and finish with task_done.",
          trigger: { kind: "schedule", cron: "0 9 * * 1-5" },
          paused: false,
          builtin: "morning_brief",
        },
      });
    setBusy(false);
  };
  const bringTeammates = async () => {
    setBusy(true);
    for (const teammate of teammates)
      await run({
        type: "buddy.create",
        buddy: {
          buddyId: makeCommandId(),
          name: teammate.name.slice(0, 24),
          color: teammate.buddy,
          role: "buddy",
          engine: teammate.model
            ? { mode: "locked", provider: teammate.provider, model: teammate.model }
            : { mode: "prefer", provider: teammate.provider },
          ...(teammate.instructions ? { instructions: teammate.instructions } : {}),
          permissionMode: teammate.permissionMode ?? "full-access",
          maxActiveJobs: 2,
          handoffs: [],
        },
      });
    setBusy(false);
  };
  return (
    <section className="buddies-welcome">
      <div className="buddies-welcome-faces" aria-hidden="true">
        <BuddyAvatar buddy="tangerine" size={40} mood="working" />
        <BuddyAvatar buddy="sky" size={40} />
        <BuddyAvatar buddy="jade" size={40} mood="thinking" />
      </div>
      <h3>A team that works for you</h3>
      <p>
        Buddies take jobs. Each job runs in its own worktree and chat, so you can watch it, step in, or ignore it until
        the result card shows up.
      </p>
      <ul className="buddies-welcome-list">
        <li>
          <strong>Primary</strong> plans bigger asks and hands out the parts.
        </li>
        <li>
          <strong>Builder</strong> builds features and fixes bugs.
        </li>
        <li>
          <strong>Tester</strong> checks every Builder job before it reaches you.
        </li>
      </ul>
      <p className="buddies-hint">
        Give a job by typing <kbd>@Builder</kbd> and what you need in any chat. ZLI picks the agent and model for each
        job, and tells you why.
      </p>
      <div className="buddies-welcome-actions">
        <Button variant="primary" loading={busy} onClick={() => void start()}>
          Start with these three
        </Button>
        {teammates.length > 0 ? (
          <Button loading={busy} onClick={() => void bringTeammates()}>
            Bring in my {teammates.length} teammate{teammates.length === 1 ? "" : "s"}
          </Button>
        ) : null}
      </div>
      <ImportBuddy run={run} projection={projection} />
    </section>
  );
}

/* ---------- The team ---------- */

const QUALITY: readonly { value: BuddyQuality; label: string; tooltip: string }[] = [
  { value: "save", label: "Save money", tooltip: "Lighter models unless a job needs more" },
  { value: "balanced", label: "Balanced", tooltip: "The model each job needs" },
  { value: "best", label: "Best quality", tooltip: "Stronger models, even for small jobs" },
];

function TeamPage({
  projection,
  team,
  run,
  onSelect,
  onOpenThread,
  onOpenPullRequest,
}: BuddiesPaneProps & { team: BuddyProjection[]; run: Run }) {
  const tasks = projection.tasks ?? [];
  const waiting = needsYou(projection);
  const [dragged, setDragged] = useState<string>();
  const [adding, setAdding] = useState(false);
  const drop = (targetId: string) => {
    if (!dragged || dragged === targetId) return;
    const ids = team.map((buddy) => buddy.buddyId).filter((id) => id !== dragged);
    ids.splice(ids.indexOf(targetId), 0, dragged);
    setDragged(undefined);
    void run({ type: "buddy.reorder", buddyIds: ids });
  };
  return (
    <>
      {waiting.length > 0 ? (
        <section className="buddies-section" aria-label="Needs you">
          <h3 className="buddies-heading">
            Needs you <span className="buddies-count">{waiting.length}</span>
          </h3>
          <div className="buddies-cards">
            {waiting.map((task) => (
              <JobCard
                key={task.taskId}
                task={task}
                projection={projection}
                run={run}
                showBuddy
                onOpenThread={onOpenThread}
                onOpenPullRequest={onOpenPullRequest}
              />
            ))}
          </div>
        </section>
      ) : null}
      <section className="buddies-section" aria-label="Team">
        <h3 className="buddies-heading">Team</h3>
        <ul className="buddies-list">
          {team.map((buddy) => {
            const open = tasks.filter((task) => task.buddyId === buddy.buddyId && isOpenTask(task)).length;
            return (
              <li
                key={buddy.buddyId}
                className={`buddies-row${dragged === buddy.buddyId ? " is-dragging" : ""}`}
                draggable={buddy.role !== "primary"}
                onDragStart={() => setDragged(buddy.buddyId)}
                onDragEnd={() => setDragged(undefined)}
                onDragOver={(event) => {
                  if (dragged && buddy.role !== "primary") event.preventDefault();
                }}
                onDrop={() => drop(buddy.buddyId)}
              >
                <button type="button" className="buddies-row-main" onClick={() => onSelect(buddy.buddyId)}>
                  <BuddyAvatar buddy={buddy.color} size={28} mood={buddyMood(buddy, tasks)} name={buddy.name} />
                  <span className="buddies-row-text">
                    <span className="buddies-row-name">
                      {buddy.name}
                      {buddy.title && buddy.title !== buddy.name ? (
                        <span className="buddies-row-title">{buddy.title}</span>
                      ) : null}
                      {buddy.role === "primary" ? <span className="buddies-row-title">Primary</span> : null}
                    </span>
                    <span className="buddies-row-line">{buddy.lastLine?.text ?? "Ready for a job"}</span>
                  </span>
                  {open > 0 ? <span className="buddies-count">{open}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
        {adding ? (
          <AddBuddy run={run} projection={projection} onDone={() => setAdding(false)} />
        ) : (
          <Button size="sm" variant="ghost" icon="plus" onClick={() => setAdding(true)}>
            Add a buddy
          </Button>
        )}
      </section>
      <section className="buddies-section" aria-label="How Auto picks">
        <h3 className="buddies-heading">How Auto picks models</h3>
        <Segmented
          label="How Auto picks models"
          value={projection.buddySettings?.quality ?? "balanced"}
          options={QUALITY}
          onChange={(quality) => void run({ type: "buddies.quality", quality })}
        />
        <p className="buddies-hint">
          Auto reads each job, then picks the agent, model and effort that fit it, steering away from logins near their
          limits. It learns from how each job went.
        </p>
      </section>
      <section className="buddies-section" aria-label="Import">
        <ImportBuddy run={run} projection={projection} />
      </section>
    </>
  );
}

function AddBuddy({ run, projection, onDone }: { run: Run; projection: RuntimeProjection; onDone(): void }) {
  const [title, setTitle] = useState("Builder");
  const [name, setName] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const entry = template(title) ?? (BUDDY_TEMPLATES[1] as (typeof BUDDY_TEMPLATES)[number]);
    const chosen = freeName(name.trim() || entry.title, projection.buddies ?? []);
    const used = new Set((projection.buddies ?? []).filter((buddy) => !buddy.archived).map((buddy) => buddy.color));
    const color = used.has(entry.color)
      ? ((BUDDY_COLOR_NAMES.find((candidate) => !used.has(candidate)) ?? entry.color) as BuddyColor)
      : entry.color;
    const buddy = { ...buddyFromTemplate(makeCommandId(), chosen, entry), color, role: "buddy" as const };
    if (await run({ type: "buddy.create", buddy })) onDone();
  };
  return (
    <form className="buddies-add" onSubmit={(event) => void submit(event)}>
      <Select
        label="What it does"
        value={title}
        options={BUDDY_TEMPLATES.filter((entry) => entry.title !== "Primary").map((entry) => ({
          value: entry.title,
          label: entry.title,
          description: entry.blurb,
        }))}
        onChange={setTitle}
      />
      <input
        className="input input-sm"
        aria-label="Name"
        placeholder={`Name (default ${title})`}
        value={name}
        maxLength={24}
        onChange={(event) => setName(event.target.value)}
      />
      <Button size="sm" variant="primary" type="submit">
        Add
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}

function ImportBuddy({ run, projection }: { run: Run; projection: RuntimeProjection }) {
  const [note, setNote] = useState<string>();
  const load = async (file: File | undefined) => {
    if (!file) return;
    const parsed = parseBuddyFile(await file.text());
    if (typeof parsed === "string") {
      setNote(parsed);
      return;
    }
    const buddyId = makeCommandId();
    const name = freeName(parsed.buddy.name, projection.buddies ?? []);
    const color = (BUDDY_COLOR_NAMES as readonly string[]).includes(parsed.buddy.color) ? parsed.buddy.color : "sky";
    const ok = await run({
      type: "buddy.create",
      buddy: {
        buddyId,
        name,
        color,
        ...(parsed.buddy.title ? { title: parsed.buddy.title } : {}),
        ...(parsed.buddy.instructions ? { instructions: parsed.buddy.instructions } : {}),
        role: "buddy",
        engine: { mode: "auto" },
        permissionMode: parsed.buddy.permissionMode,
        maxActiveJobs: parsed.buddy.maxActiveJobs,
        handoffs: [],
      },
    });
    if (!ok) return;
    for (const text of parsed.buddy.memory)
      await run({ type: "buddy.memory.add", buddyId, note: { noteId: makeCommandId(), text, source: "you" } });
    const project = projection.projects[0];
    if (project)
      for (const routine of parsed.routines)
        await run({
          type: "routine.create",
          routine: {
            routineId: makeCommandId(),
            buddyId,
            projectId: project.projectId,
            goal: routine.goal,
            trigger: routine.trigger,
            paused: true,
          },
        });
    setNote(
      `${name} joined the team.${parsed.routines.length > 0 ? " Its routines start paused; turn them on from its page." : ""}`,
    );
  };
  return (
    <div className="buddies-import">
      <label className="btn btn-ghost btn-sm">
        <Icon name="upload" size={13} />
        Import a buddy
        <input
          type="file"
          accept=".json,.buddy.json,application/json"
          className="buddies-file"
          onChange={(event) => void load(event.target.files?.[0])}
        />
      </label>
      {note ? <span className="buddies-hint">{note}</span> : null}
    </div>
  );
}

/* ---------- One buddy ---------- */

function BuddyPage({
  projection,
  buddy,
  run,
  onSelect,
  onOpenThread,
  onOpenPullRequest,
  projectId,
}: BuddiesPaneProps & { buddy: BuddyProjection; run: Run }) {
  const [tab, setTab] = useState<"chat" | "profile">("chat");
  const active = (projection.tasks ?? []).findLast(
    (task) => task.buddyId === buddy.buddyId && isActiveTask(task) && task.threadId,
  );
  return (
    <div className="buddy-page">
      <header className="buddy-head">
        <BuddyAvatar buddy={buddy.color} size={32} mood={buddyMood(buddy, projection.tasks ?? [])} name={buddy.name} />
        <div className="buddy-head-text">
          <span className="buddy-head-title">
            {buddy.role === "primary" ? "Primary buddy" : (buddy.title ?? "Buddy")}
          </span>
          <span className="buddies-row-line">{buddy.lastLine?.text ?? "Ready for a job"}</span>
        </div>
        <span className="buddy-spacer" />
        {/* Its computer: lit while it works, and opens the job's own chat beside this one. */}
        <IconButton
          label={active ? "See what it's working on" : "Nothing running"}
          icon="monitor"
          size="sm"
          className={`buddy-computer${active ? " is-active" : ""}`}
          disabled={!active}
          onClick={() => active?.threadId && onOpenThread(active.threadId)}
        />
        <Segmented<"chat" | "profile">
          label="Buddy page"
          className="buddy-tabs"
          value={tab}
          options={[
            { value: "chat", label: "Chat" },
            {
              value: "profile",
              label: buddy.pendingMemory.length > 0 ? `Profile · ${buddy.pendingMemory.length} new` : "Profile",
            },
          ]}
          onChange={setTab}
        />
      </header>
      {tab === "chat" ? (
        <BuddyChat
          buddy={buddy}
          projection={projection}
          run={run}
          projectId={projectId}
          onOpenThread={onOpenThread}
          renderReply={(task) => (
            <JobCard
              task={task}
              projection={projection}
              run={run}
              inline
              onOpenThread={onOpenThread}
              onOpenPullRequest={onOpenPullRequest}
            />
          )}
        />
      ) : (
        <div className="buddy-page-scroll">
          <Profile buddy={buddy} projection={projection} run={run} onRemoved={() => onSelect(undefined)} />
        </div>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<TaskProjection["status"], string> = {
  queued: "Up next",
  preparing: "Getting ready",
  working: "Working",
  needs_you: "Needs you",
  ready: "Ready",
  shipped: "Shipped",
  closed: "Done",
  failed: "Stuck",
  stopped: "Stopped",
  cancelled: "Dropped",
};

export function JobCard({
  task,
  projection,
  run,
  showBuddy = false,
  inline = false,
  onOpenThread,
  onOpenPullRequest,
}: {
  task: TaskProjection;
  projection: RuntimeProjection;
  run: Run;
  showBuddy?: boolean;
  /** Inside a buddy's chat, where the transcript already says what the job is and how it is going. */
  inline?: boolean;
  onOpenThread(threadId: string): void;
  onOpenPullRequest(threadId: string): void;
}) {
  const buddy = (projection.buddies ?? []).find((candidate) => candidate.buddyId === task.buddyId);
  const question = openQuestion(task);
  const [answer, setAnswer] = useState("");
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState("");
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [changing, setChanging] = useState(false);
  const project = projection.projects.find((entry) => entry.projectId === task.projectId);
  const parent = task.parentTaskId ? projection.tasks?.find((entry) => entry.taskId === task.parentTaskId) : undefined;
  const parentBuddy = parent ? projection.buddies?.find((entry) => entry.buddyId === parent.buddyId) : undefined;
  const providers = listedDiscoveries(projection.providers ?? []).filter((entry) => entry.status === "found");
  const result = task.result;
  const tone =
    task.status === "needs_you"
      ? "is-waiting"
      : task.status === "ready"
        ? "is-ready"
        : task.status === "failed"
          ? "is-failed"
          : "";
  const rerun = async (provider: ProviderKind) => {
    setChanging(false);
    if (isOpenTask(task)) await run({ type: "task.cancel", taskId: task.taskId });
    await run({
      type: "task.assign",
      task: {
        taskId: makeCommandId(),
        buddyId: task.buddyId,
        projectId: task.projectId,
        kind: task.kind,
        goal: task.goal,
        origin: task.origin,
        override: { provider },
      },
    });
  };
  return (
    <article
      className={`job-card ${tone}${inline ? " is-inline" : ""}`}
      aria-label={`${buddy?.name ?? "Buddy"}: ${task.goal}`}
    >
      {inline ? null : (
        <>
          <header className="job-card-head">
            {showBuddy && buddy ? <BuddyAvatar buddy={buddy.color} size={20} name={buddy.name} /> : null}
            <span className="job-card-status">{STATUS_LABEL[task.status]}</span>
            {task.kind === "review" ? <span className="job-card-tag">Review</span> : null}
            {project && projection.projects.length > 1 ? <span className="job-card-tag">{project.name}</span> : null}
            <span className="buddy-spacer" />
            {task.threadId ? (
              <IconButton
                label="Open its chat"
                icon="message"
                size="sm"
                onClick={() => onOpenThread(task.threadId as string)}
              />
            ) : null}
          </header>
          <p className="job-card-goal">
            {showBuddy && buddy ? <strong>{buddy.name}: </strong> : null}
            {task.goal}
          </p>
          {parentBuddy ? (
            <p className="job-card-meta">
              Handed on by {parentBuddy.name}
              {task.round ? ` · round ${task.round}` : ""}
            </p>
          ) : null}
          {task.status !== "ready" && task.status !== "queued" && !question ? (
            <p className="job-card-meta">{taskLine(task)}</p>
          ) : null}
        </>
      )}
      {task.pick ? (
        <p className="job-card-pick">
          <span>
            {task.pick.model ?? providerDisplayName(task.pick.provider, projection.providers)}
            {task.pick.effort ? ` · ${task.pick.effort}` : ""} — {task.pick.reason}
          </span>
          {providers.length > 1 && task.status !== "closed" && task.status !== "shipped" ? (
            <button type="button" className="job-card-link" onClick={() => setChanging((value) => !value)}>
              Change
            </button>
          ) : null}
        </p>
      ) : null}
      {changing ? (
        <fieldset className="job-card-actions" aria-label="Run again with">
          {providers.map((entry) => (
            <Button key={entry.provider} size="xs" onClick={() => void rerun(entry.provider as ProviderKind)}>
              {entry.displayName}
            </Button>
          ))}
        </fieldset>
      ) : null}
      {question ? (
        <div className="job-card-question">
          <p>{question.text}</p>
          {question.options?.length ? (
            <div className="job-card-actions">
              {question.options.map((option) => (
                <Button
                  key={option}
                  size="sm"
                  onClick={() =>
                    void run({
                      type: "task.question.answer",
                      taskId: task.taskId,
                      questionId: question.questionId,
                      answer: option,
                    })
                  }
                >
                  {option}
                </Button>
              ))}
            </div>
          ) : null}
          <form
            className="job-card-reply"
            onSubmit={(event) => {
              event.preventDefault();
              if (!answer.trim()) return;
              void run({
                type: "task.question.answer",
                taskId: task.taskId,
                questionId: question.questionId,
                answer,
              }).then((ok) => ok && setAnswer(""));
            }}
          >
            <input
              className="input input-sm"
              aria-label="Your answer"
              placeholder="Your answer"
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
            />
            <Button size="sm" variant="primary" type="submit" disabled={!answer.trim()}>
              Answer
            </Button>
          </form>
        </div>
      ) : task.status === "needs_you" && task.needs ? (
        <p className="job-card-needs">{task.needs.text ?? "Waiting for you in its chat."}</p>
      ) : null}
      {task.status === "failed" && task.needs?.text ? <p className="job-card-needs">{task.needs.text}</p> : null}
      {result ? (
        <div className="job-card-result">
          <p>{result.summary}</p>
          <p className="job-card-meta">
            {result.files} file{result.files === 1 ? "" : "s"} · +{result.insertions} −{result.deletions}
            {result.costUsd !== undefined ? ` · ${money(result.costUsd)}` : ""} · {duration(result.durationMs)}
          </p>
          {result.overlaps.length > 0 ? (
            <p className="job-card-needs">
              Touches the same files as {result.overlaps.length} other open job{result.overlaps.length === 1 ? "" : "s"}
              :{" "}
              {result.overlaps
                .flatMap((overlap) => overlap.paths)
                .slice(0, 3)
                .join(", ")}
            </p>
          ) : null}
          {result.screenshots.length > 0 ? (
            <ul className="job-card-shots" aria-label="Screenshots">
              {result.screenshots.map((path) => (
                <li key={path}>
                  <Icon name="image" size={12} /> {path.split(/[\\/]/u).at(-1)}
                </li>
              ))}
            </ul>
          ) : null}
          {result.prUrl ? (
            <a className="job-card-link" href={result.prUrl} target="_blank" rel="noreferrer">
              {result.prUrl}
            </a>
          ) : null}
        </div>
      ) : null}
      {task.reviews.map((review) => {
        const reviewer = projection.buddies?.find((entry) => entry.buddyId === review.buddyId);
        return (
          <div key={review.taskId} className={`job-card-review is-${review.verdict}`}>
            <strong>{reviewer?.name ?? "Reviewer"}</strong>
            {review.verdict === "ok" ? " checked it: looks good." : " has notes:"}
            {review.notes.length > 0 ? (
              <ul>
                {review.notes.map((reviewNote) => (
                  <li key={reviewNote}>{reviewNote}</li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
      {revising ? (
        <form
          className="job-card-reply"
          onSubmit={(event) => {
            event.preventDefault();
            if (!note.trim()) return;
            void run({ type: "task.revise", taskId: task.taskId, note }).then((ok) => {
              if (ok) {
                setNote("");
                setRevising(false);
              }
            });
          }}
        >
          <input
            className="input input-sm"
            aria-label="What to change"
            placeholder="What should change?"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button size="sm" variant="primary" type="submit" disabled={!note.trim()}>
            Send
          </Button>
        </form>
      ) : null}
      {confirmUndo ? (
        <fieldset className="job-card-confirm" aria-label="Undo job">
          <span>Delete its branch and worktree? This can't be undone.</span>
          <Button
            size="sm"
            variant="danger"
            onClick={() => void run({ type: "task.close", taskId: task.taskId, undo: true })}
          >
            Undo job
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmUndo(false)}>
            Keep it
          </Button>
        </fieldset>
      ) : null}
      <div className="job-card-actions">
        {task.status === "ready" ? (
          <>
            {task.kind === "job" && task.threadId ? (
              <Button
                size="sm"
                variant="primary"
                icon="pullRequest"
                onClick={() => onOpenPullRequest(task.threadId as string)}
              >
                Open PR
              </Button>
            ) : null}
            <Button size="sm" icon="pencil" onClick={() => setRevising((value) => !value)}>
              Revise
            </Button>
            <Button size="sm" icon="check" onClick={() => void run({ type: "task.close", taskId: task.taskId })}>
              Done
            </Button>
            {task.kind === "job" && task.branch ? (
              <Button size="sm" variant="ghost" icon="undo" onClick={() => setConfirmUndo(true)}>
                Undo
              </Button>
            ) : null}
          </>
        ) : null}
        {(task.status === "working" || task.status === "needs_you") && task.threadId ? (
          <Button size="sm" variant="ghost" icon="pencil" onClick={() => setRevising((value) => !value)}>
            Steer
          </Button>
        ) : null}
        {task.status === "failed" || task.status === "stopped" || task.status === "cancelled" ? (
          <Button size="sm" icon="reload" onClick={() => void run({ type: "task.retry", taskId: task.taskId })}>
            Try again
          </Button>
        ) : null}
        {isOpenTask(task) && task.status !== "ready" ? (
          <Button size="sm" variant="ghost" onClick={() => void run({ type: "task.cancel", taskId: task.taskId })}>
            Drop
          </Button>
        ) : null}
      </div>
    </article>
  );
}

/* ---------- Profile ---------- */

const ACTIONS: readonly { value: HandoffAction; label: string }[] = [
  { value: "check", label: "checks it" },
  { value: "tests", label: "writes tests for it" },
  { value: "docs", label: "updates the docs" },
  { value: "fix", label: "fixes what's left" },
];

function Profile({
  buddy,
  projection,
  run,
  onRemoved,
}: {
  buddy: BuddyProjection;
  projection: RuntimeProjection;
  run: Run;
  onRemoved(): void;
}) {
  const stats = useMemo(() => buddyStats(buddy.buddyId, projection.tasks ?? []), [buddy.buddyId, projection.tasks]);
  const others = buddiesInOrder(projection).filter((entry) => entry.buddyId !== buddy.buddyId);
  const routines = (projection.routines ?? []).filter((routine) => routine.buddyId === buddy.buddyId);
  const [instructions, setInstructions] = useState(buddy.instructions ?? "");
  const [editing, setEditing] = useState<{ noteId: string; text: string }>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const providers = listedDiscoveries(projection.providers ?? []).filter((entry) => entry.status === "found");
  const engineValue = buddy.engine.mode === "auto" ? "auto" : `${buddy.engine.mode}:${buddy.engine.provider}`;
  const engineOptions = [
    { value: "auto", label: "Auto", description: "ZLI picks the agent and model for each job" },
    ...providers.flatMap((entry) => [
      { value: `prefer:${entry.provider}`, label: `Prefer ${entry.displayName}`, description: "ZLI picks the model" },
      {
        value: `locked:${entry.provider}`,
        label: `Always ${entry.displayName}`,
        description: "Its default model, every job",
      },
    ]),
  ];
  const update = (changes: Record<string, unknown>) => run({ type: "buddy.update", buddyId: buddy.buddyId, changes });
  const download = () => {
    const file = exportBuddy(buddy, projection.routines ?? []);
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${buddy.name.toLowerCase().replace(/\s+/gu, "-")}.buddy.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="buddy-profile">
      <section className="buddies-section" aria-label="Track record">
        <h3 className="buddies-heading">Track record</h3>
        <dl className="buddy-stats">
          <div>
            <dt>Jobs done</dt>
            <dd>{stats.done}</dd>
          </div>
          <div>
            <dt>Went well</dt>
            <dd>{stats.successRate === undefined ? "—" : `${Math.round(stats.successRate * 100)}%`}</dd>
          </div>
          <div>
            <dt>Changes asked</dt>
            <dd>{stats.revisions}</dd>
          </div>
          <div>
            <dt>Spent</dt>
            <dd>{money(stats.costUsd)}</dd>
          </div>
        </dl>
        {stats.models.length > 0 ? (
          <ul className="buddy-models">
            {stats.models.map((entry) => (
              <li key={entry.model}>
                <span>{entry.model}</span>
                <span>
                  {entry.ok} of {entry.jobs} went well
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="buddies-section" aria-label="What it knows">
        <h3 className="buddies-heading">What it knows</h3>
        {buddy.pendingMemory.length > 0 ? (
          <div className="buddy-lessons">
            <p className="buddies-hint">New lessons from its recent jobs. Keep the ones that help.</p>
            {buddy.pendingMemory.map((note) =>
              editing?.noteId === note.noteId ? (
                <form
                  key={note.noteId}
                  className="job-card-reply"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run({
                      type: "buddy.memory.accept",
                      buddyId: buddy.buddyId,
                      noteId: note.noteId,
                      text: editing.text,
                    }).then(() => setEditing(undefined));
                  }}
                >
                  <input
                    className="input input-sm"
                    aria-label="Lesson"
                    value={editing.text}
                    maxLength={400}
                    onChange={(event) => setEditing({ noteId: note.noteId, text: event.target.value })}
                  />
                  <Button size="sm" variant="primary" type="submit">
                    Keep
                  </Button>
                </form>
              ) : (
                <div key={note.noteId} className="buddy-lesson">
                  <span>{note.text}</span>
                  <Button
                    size="xs"
                    variant="primary"
                    onClick={() =>
                      void run({ type: "buddy.memory.accept", buddyId: buddy.buddyId, noteId: note.noteId })
                    }
                  >
                    Keep
                  </Button>
                  <Button size="xs" onClick={() => setEditing({ noteId: note.noteId, text: note.text })}>
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void run({ type: "buddy.memory.remove", buddyId: buddy.buddyId, noteId: note.noteId })
                    }
                  >
                    Skip
                  </Button>
                </div>
              ),
            )}
          </div>
        ) : null}
        {buddy.memory.length === 0 ? (
          <p className="buddies-hint">
            Nothing yet. Each evening it looks back at the day's jobs and suggests lessons.
          </p>
        ) : (
          <ul className="buddy-memory">
            {buddy.memory.map((note) => (
              <li key={note.noteId}>
                <span>{note.text}</span>
                <IconButton
                  label="Forget"
                  icon="x"
                  size="xs"
                  onClick={() => void run({ type: "buddy.memory.remove", buddyId: buddy.buddyId, noteId: note.noteId })}
                />
              </li>
            ))}
          </ul>
        )}
        <AddNote buddy={buddy} run={run} />
      </section>

      <section className="buddies-section" aria-label="Passes work on">
        <h3 className="buddies-heading">Passes work on</h3>
        {buddy.handoffs.map((rule) => {
          const to = others.find((entry) => entry.buddyId === rule.to);
          return (
            <div key={rule.ruleId} className="buddy-rule">
              <span>
                When {buddy.name} finishes, {to?.name ?? "a removed buddy"}{" "}
                {ACTIONS.find((entry) => entry.value === rule.action)?.label ?? rule.action}
                {rule.action === "check" ? `, up to ${rule.maxRounds} rounds` : ""}.
              </span>
              <IconButton
                label="Remove rule"
                icon="x"
                size="xs"
                onClick={() => void run({ type: "buddy.handoff.remove", buddyId: buddy.buddyId, ruleId: rule.ruleId })}
              />
            </div>
          );
        })}
        {others.length > 0 ? <AddRule buddy={buddy} others={others} run={run} /> : null}
      </section>

      <section className="buddies-section" aria-label="Routines">
        <h3 className="buddies-heading">Routines</h3>
        {routines.map((routine) => (
          <RoutineRow key={routine.routineId} routine={routine} run={run} />
        ))}
        {projection.projects.length > 0 ? <AddRoutine buddy={buddy} projection={projection} run={run} /> : null}
      </section>

      <section className="buddies-section" aria-label="Settings">
        <h3 className="buddies-heading">Settings</h3>
        <fieldset className="buddy-colors" aria-label="Color">
          {BUDDY_COLOR_NAMES.map((color) => (
            <button
              key={color}
              type="button"
              className="teammate-color"
              aria-label={buddyName(color)}
              aria-pressed={buddy.color === color}
              onClick={() => void update({ color })}
            >
              <BuddyAvatar buddy={color} size={22} />
            </button>
          ))}
        </fieldset>
        <Select
          label="Agent and model"
          value={engineValue}
          options={engineOptions}
          onChange={(value) => {
            const [mode, provider] = value.split(":");
            void update({ engine: mode === "auto" ? { mode: "auto" } : { mode, provider } });
          }}
        />
        <Select<PermissionMode>
          label="Most it may do"
          value={buddy.permissionMode}
          options={[
            { value: "read-only", label: "Read only", description: "Plans and reviews; changes no files" },
            { value: "supervised", label: "Ask first", description: "Asks before risky commands" },
            { value: "full-access", label: "Full access", description: "Works without asking" },
          ]}
          onChange={(permissionMode) => void update({ permissionMode })}
        />
        <label className="buddy-field">
          <span>Standing instructions</span>
          <textarea
            className="input"
            rows={4}
            maxLength={4_000}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            onBlur={() => {
              if (instructions !== (buddy.instructions ?? "")) void update({ instructions });
            }}
          />
        </label>
        <div className="job-card-actions">
          {buddy.role !== "primary" ? (
            <Button size="sm" onClick={() => void run({ type: "buddy.setPrimary", buddyId: buddy.buddyId })}>
              Make Primary
            </Button>
          ) : null}
          <Button size="sm" icon="download" onClick={download}>
            Export
          </Button>
          {confirmRemove ? (
            <>
              <Button
                size="sm"
                variant="danger"
                onClick={() =>
                  void run({ type: "buddy.archive", buddyId: buddy.buddyId }).then((ok) => ok && onRemoved())
                }
              >
                Remove {buddy.name}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" icon="trash" onClick={() => setConfirmRemove(true)}>
              Remove
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}

function AddNote({ buddy, run }: { buddy: BuddyProjection; run: Run }) {
  const [text, setText] = useState("");
  return (
    <form
      className="job-card-reply"
      onSubmit={(event) => {
        event.preventDefault();
        if (!text.trim()) return;
        void run({
          type: "buddy.memory.add",
          buddyId: buddy.buddyId,
          note: { noteId: makeCommandId(), text: text.trim(), source: "you" },
        }).then((ok) => ok && setText(""));
      }}
    >
      <input
        className="input input-sm"
        aria-label="Teach it something"
        placeholder="Teach it something, such as how to run the tests"
        value={text}
        maxLength={400}
        onChange={(event) => setText(event.target.value)}
      />
      <Button size="sm" type="submit" disabled={!text.trim()}>
        Add
      </Button>
    </form>
  );
}

function AddRule({ buddy, others, run }: { buddy: BuddyProjection; others: BuddyProjection[]; run: Run }) {
  const [to, setTo] = useState(others[0]?.buddyId ?? "");
  const [action, setAction] = useState<HandoffAction>("check");
  return (
    <div className="buddy-rule-form">
      <span>When it finishes,</span>
      <Select
        label="Buddy"
        value={to}
        options={others.map((entry) => ({ value: entry.buddyId, label: entry.name }))}
        onChange={setTo}
      />
      <Select<HandoffAction> label="Does" value={action} options={ACTIONS} onChange={setAction} />
      <Button
        size="sm"
        onClick={() =>
          void run({
            type: "buddy.handoff.set",
            buddyId: buddy.buddyId,
            rule: { ruleId: makeCommandId(), when: "finished", to, action, maxRounds: 2, enabled: true },
          })
        }
      >
        Add rule
      </Button>
    </div>
  );
}

function RoutineRow({ routine, run }: { routine: RoutineProjection; run: Run }) {
  return (
    <div className={`buddy-rule${routine.paused ? " is-paused" : ""}`}>
      <span>
        <strong>{triggerLabel(routine.trigger)}:</strong> {routine.goal.split("\n")[0]}
        {routine.paused ? (routine.failuresInRow >= 3 ? " · paused after 3 failed runs" : " · paused") : ""}
      </span>
      <IconButton
        label={routine.paused ? "Turn on" : "Pause"}
        icon={routine.paused ? "play" : "pause"}
        size="xs"
        onClick={() => void run({ type: "routine.setPaused", routineId: routine.routineId, paused: !routine.paused })}
      />
      <IconButton
        label="Remove routine"
        icon="x"
        size="xs"
        onClick={() => void run({ type: "routine.remove", routineId: routine.routineId })}
      />
    </div>
  );
}

type TriggerChoice = "schedule" | "ci_failed" | "review_requested" | "issue_labeled";

function AddRoutine({ buddy, projection, run }: { buddy: BuddyProjection; projection: RuntimeProjection; run: Run }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<TriggerChoice>("schedule");
  const [cron, setCron] = useState(SCHEDULES[0]?.cron ?? "0 9 * * 1-5");
  const [branch, setBranch] = useState("main");
  const [label, setLabel] = useState("bug");
  const [goal, setGoal] = useState("");
  const [project, setProject] = useState(projection.projects[0]?.projectId ?? "");
  if (!open)
    return (
      <Button size="sm" variant="ghost" icon="plus" onClick={() => setOpen(true)}>
        Add a routine
      </Button>
    );
  const trigger =
    kind === "schedule"
      ? { kind, cron }
      : kind === "ci_failed"
        ? { kind, branch }
        : kind === "issue_labeled"
          ? { kind, label }
          : { kind };
  return (
    <form
      className="buddy-routine-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!goal.trim()) return;
        void run({
          type: "routine.create",
          routine: {
            routineId: makeCommandId(),
            buddyId: buddy.buddyId,
            projectId: project,
            goal: goal.trim(),
            trigger,
            paused: false,
          },
        }).then((ok) => {
          if (ok) {
            setGoal("");
            setOpen(false);
          }
        });
      }}
    >
      <Select<TriggerChoice>
        label="When"
        value={kind}
        options={[
          { value: "schedule", label: "On a schedule" },
          { value: "ci_failed", label: "When CI fails" },
          { value: "review_requested", label: "When you're asked to review" },
          { value: "issue_labeled", label: "When an issue gets a label" },
        ]}
        onChange={setKind}
      />
      {kind === "schedule" ? (
        <Select
          label="Schedule"
          value={cron}
          options={SCHEDULES.map((entry) => ({ value: entry.cron, label: entry.label }))}
          onChange={setCron}
        />
      ) : kind === "ci_failed" ? (
        <input
          className="input input-sm"
          aria-label="Branch"
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
        />
      ) : kind === "issue_labeled" ? (
        <input
          className="input input-sm"
          aria-label="Label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      ) : null}
      {projection.projects.length > 1 ? (
        <Select
          label="Project"
          value={project}
          options={projection.projects.map((entry) => ({ value: entry.projectId, label: entry.name }))}
          onChange={setProject}
        />
      ) : null}
      <textarea
        className="input"
        aria-label="What to do each time"
        placeholder="What to do each time, such as: run the test suite and fix anything that broke"
        rows={2}
        value={goal}
        onChange={(event) => setGoal(event.target.value)}
      />
      <p className="buddies-hint">
        {kind === "schedule"
          ? "Missed runs while ZLI is closed become one run when it opens."
          : "ZLI checks GitHub with gh every two minutes."}{" "}
        Routines never push, open PRs or merge.
      </p>
      <div className="job-card-actions">
        <Button size="sm" variant="primary" type="submit" disabled={!goal.trim()}>
          Add routine
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
