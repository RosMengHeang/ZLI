import {
  type BuddyProjection,
  type BuddyQuality,
  buddiesInOrder,
  isOpenTask,
  needsYou,
  openQuestion,
  type ProviderKind,
  type RoutineProjection,
  type RuntimeProjection,
  type TaskProjection,
  taskLine,
} from "@zli-v2/contracts";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { listedDiscoveries, providerDisplayName } from "../agent/providers.js";
import { makeCommandId } from "../runtime/commandId.js";
import { relativeTime } from "../sessions/sessions.js";
import { updateAppSettings, useAppSettings } from "../settings/appSettings.js";
import { type AvatarMood, BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { BUDDY_COLOR_NAMES } from "../teammates/buddies.js";
import { lookOf } from "../teammates/pixelBuddies.js";
import { Button, IconButton } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { Segmented } from "../ui/Segmented.js";
import { BuddyScreen } from "./BuddyAutonomy.js";
import { BuddyChat } from "./BuddyChat.js";
import { BuddyList } from "./BuddyList.js";
import { BuddyLookEditor } from "./BuddyLookEditor.js";
import { QUALITY_LEVELS } from "./BuddyModelPicker.js";
import { LibraryTab, SettingsTab } from "./BuddyTabs.js";
import { GoalComposer, GoalList, isPlanTurn, isWebTask } from "./Goals.js";
import { TEAM_CHAT_ID, TeamChat } from "./TeamChat.js";
import { NewTeam, TeamView, teamFromPageId, teamPageId } from "./TeamView.js";
import { buddyStats, duration, freeName, money, parseBuddyFile, SCHEDULES, starterTeam, triggerLabel } from "./team.js";
import { type Run, useRun } from "./useRun.js";
import "./buddies.css";

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
  const { projection, selectedId } = props;
  const [error, setError] = useState<string>();
  const run = useRun(setError);
  const team = buddiesInOrder(projection);
  const selected = team.find((buddy) => buddy.buddyId === selectedId);
  const teamId = teamFromPageId(selectedId);
  const paused = projection.buddySettings?.paused ?? false;

  const errorLine = error ? (
    <p className="inline-error buddies-error" role="alert">
      {error}
    </p>
  ) : null;
  // No team yet: the welcome takes the whole page.
  if (team.length === 0)
    return (
      <section className="buddies-main" aria-label="Buddies">
        <div className="buddies-home">
          {errorLine}
          <div className="buddies-body">
            <Welcome run={run} projection={projection} />
          </div>
        </div>
      </section>
    );
  // Like a messenger: the team on the left, the chosen buddy's chat (or the team board) on the right.
  return (
    <section className="buddies-main is-split" aria-label="Buddies">
      <BuddyList
        projection={projection}
        team={team}
        selectedId={selected?.buddyId ?? (selectedId === TEAM_CHAT_ID ? TEAM_CHAT_ID : undefined)}
        run={run}
        onSelect={props.onSelect}
      />
      <div className="buddies-detail">
        {selectedId === TEAM_CHAT_ID ? (
          <div className="buddies-home">
            <header className="buddies-home-head">
              <h2>Team chat</h2>
            </header>
            {errorLine}
            <TeamChat projection={projection} run={run} />
          </div>
        ) : teamId === "new" ? (
          <div className="buddies-home">
            {errorLine}
            <NewTeam
              projection={projection}
              run={run}
              projectId={props.projectId}
              onCreated={(goalId) => props.onSelect(teamPageId(goalId))}
            />
          </div>
        ) : teamId ? (
          <div className="buddies-home">
            {errorLine}
            <TeamView
              key={teamId}
              projection={projection}
              goalId={teamId}
              run={run}
              onOpenThread={props.onOpenThread}
              onSelect={props.onSelect}
            />
          </div>
        ) : selected ? (
          // Keyed by buddy: what one buddy's Settings were editing never carries over to the next.
          <BuddyPage key={selected.buddyId} {...props} buddy={selected} run={run} error={errorLine} />
        ) : (
          <div className="buddies-home">
            <header className="buddies-home-head">
              <h2>Team board</h2>
            </header>
            {errorLine}
            {paused ? <p className="buddies-paused">Paused. Running jobs finish; nothing new starts.</p> : null}
            <div className="buddies-body">
              <TeamPage {...props} run={run} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------- First run ---------- */

/**
 * Primary, Builder and Tester, Builder's work checked by Tester. Nothing is scheduled: routines start when the
 * person asks a buddy for one or adds one on its page. A name already taken (a buddy moved over from Settings, or
 * one the person made) is left as it is, so only the missing ones are made.
 */
async function startTeam(run: Run, taken: ReadonlySet<string> = new Set()): Promise<void> {
  const { buddies, handoff } = starterTeam(makeCommandId);
  const made = new Set<string>();
  for (const buddy of buddies) {
    if (taken.has(buddy.name.toLowerCase())) continue;
    if (await run({ type: "buddy.create", buddy })) made.add(buddy.buddyId);
  }
  if (!made.has(handoff.from) || !made.has(handoff.to)) return;
  await run({
    type: "buddy.handoff.set",
    buddyId: handoff.from,
    rule: { ruleId: handoff.ruleId, when: "finished", to: handoff.to, action: "check", maxRounds: 2, enabled: true },
  });
}

/**
 * The team is there from the first run, for a new install and for someone updating from a version before buddies:
 * while there has never been a Primary, this makes the starter three (any not already there by name). A Primary
 * someone removed stays removed, since removed buddies stay in the projection as archived.
 */
export function useStarterTeam(projection: RuntimeProjection | undefined): void {
  const run = useRun(() => undefined);
  const started = useRef(false);
  const missing = projection !== undefined && !(projection.buddies ?? []).some((buddy) => buddy.role === "primary");
  useEffect(() => {
    if (!missing || !projection || started.current) return;
    started.current = true;
    void startTeam(run, new Set((projection.buddies ?? []).map((buddy) => buddy.name.toLowerCase())));
  }, [missing, projection, run]);
}

/**
 * Teammates saved in Settings before buddies replaced them become buddies once, with their name, color, agent,
 * model and instructions. A buddy that already has the name, even a removed one, is left as it is.
 */
export function useTeammatesToBuddies(projection: RuntimeProjection | undefined): void {
  const { teammates } = useAppSettings();
  const run = useRun(() => undefined);
  const moving = useRef(false);
  const ready = projection !== undefined;
  useEffect(() => {
    if (!ready || !projection || teammates.length === 0 || moving.current) return;
    moving.current = true;
    void (async () => {
      const known = new Set((projection.buddies ?? []).map((buddy) => buddy.name.toLowerCase()));
      let moved = true;
      for (const teammate of teammates) {
        const name = teammate.name.slice(0, 24).trim();
        if (!name || known.has(name.toLowerCase())) continue;
        known.add(name.toLowerCase());
        const created = await run({
          type: "buddy.create",
          buddy: {
            buddyId: makeCommandId(),
            name,
            color: teammate.buddy,
            role: "buddy",
            engine: teammate.model
              ? { mode: "locked", provider: teammate.provider, model: teammate.model }
              : { mode: "prefer", provider: teammate.provider },
            ...(teammate.instructions ? { instructions: teammate.instructions } : {}),
            permissionMode: teammate.permissionMode ?? "supervised",
            maxActiveJobs: 2,
            handoffs: [],
          },
        });
        moved = moved && created;
      }
      if (moved) updateAppSettings((current) => ({ ...current, teammates: [] }));
      else moving.current = false;
    })();
  }, [ready, projection, teammates, run]);
}

function Welcome({ run, projection }: { run: Run; projection: RuntimeProjection }) {
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    await startTeam(run);
    setBusy(false);
  };
  return (
    <section className="buddies-welcome">
      <div className="buddies-welcome-faces" aria-hidden="true">
        <BuddyAvatar buddy="tangerine" look="bot" size={40} mood="working" />
        <BuddyAvatar buddy="sky" look="blob" size={40} />
        <BuddyAvatar buddy="jade" look="critter" size={40} mood="thinking" />
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
      </div>
      <ImportBuddy run={run} projection={projection} />
    </section>
  );
}

/* ---------- The team ---------- */

const QUALITY: readonly { value: BuddyQuality; label: string; tooltip: string }[] = QUALITY_LEVELS.map((level) => ({
  value: level.value,
  label: level.label,
  tooltip: level.description,
}));

/** Finished jobs, as the board's last lane names them. */
const DONE_STATUSES = new Set<TaskProjection["status"]>([
  "ready",
  "shipped",
  "closed",
  "failed",
  "stopped",
  "cancelled",
]);
/** How many finished jobs the board keeps in view. */
const DONE_SHOWN = 8;

/**
 * The team board: what needs the person, what each buddy is doing right now, and every job in three lanes
 * (up next, doing, done), each card with the buddy's face. A card opens that buddy's chat.
 */
function TeamPage({
  projection,
  run,
  onSelect,
  onOpenThread,
  onOpenPullRequest,
  projectId,
}: BuddiesPaneProps & { run: Run }) {
  const tasks = projection.tasks ?? [];
  const team = buddiesInOrder(projection);
  const byId = new Map(team.map((buddy) => [buddy.buddyId, buddy]));
  // A lead's planning turns show on its goal's card, not as jobs of their own.
  const ours = tasks.filter((task) => byId.has(task.buddyId) && !task.undone && !isPlanTurn(task, projection.goals));
  const waiting = needsYou(projection);
  const latest = (task: TaskProjection) => task.endedAt ?? task.updatedAt;
  const lanes: { key: string; label: string; tasks: TaskProjection[] }[] = [
    { key: "queued", label: "Up next", tasks: ours.filter((task) => task.status === "queued") },
    {
      key: "doing",
      label: "Doing",
      tasks: ours.filter((task) => task.status === "preparing" || task.status === "working"),
    },
    {
      key: "done",
      label: "Done",
      tasks: ours
        .filter((task) => DONE_STATUSES.has(task.status))
        .sort((left, right) => latest(right).localeCompare(latest(left)))
        .slice(0, DONE_SHOWN),
    },
  ];
  const anyJobs = lanes.some((lane) => lane.tasks.length > 0);
  return (
    <>
      <section className="buddies-section" aria-label="Goals">
        <GoalComposer
          projection={projection}
          run={run}
          projectId={projectId}
          onCreated={(goalId) => onSelect(teamPageId(goalId))}
        />
        <GoalList projection={projection} run={run} onSelect={onSelect} />
      </section>

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

      <section className="buddies-section" aria-label="Right now">
        <h3 className="buddies-heading">Right now</h3>
        <ul className="board-crew">
          {team.map((buddy) => {
            const working = tasks.find(
              (task) => task.buddyId === buddy.buddyId && (task.status === "working" || task.status === "preparing"),
            );
            const planning = working ? isPlanTurn(working, projection.goals) : false;
            const mood = buddyMood(buddy, tasks);
            return (
              <li key={buddy.buddyId}>
                <button type="button" className={`board-crew-item is-${mood}`} onClick={() => onSelect(buddy.buddyId)}>
                  <BuddyAvatar buddy={buddy.color} look={lookOf(buddy)} image={buddy.image} size={28} mood={mood} />
                  <span className="board-crew-text">
                    <span className="board-crew-name">{buddy.name}</span>
                    <span className="board-crew-line">
                      {working
                        ? `${planning ? "Planning: " : ""}${working.goal}`
                        : mood === "waiting"
                          ? "Needs you"
                          : "Free"}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="buddies-section" aria-label="Jobs">
        <h3 className="buddies-heading">Jobs</h3>
        {anyJobs ? (
          <div className="board-lanes">
            {lanes.map((lane) => (
              <section key={lane.key} className={`board-lane is-${lane.key}`} aria-label={lane.label}>
                <h4 className="board-lane-head">
                  {lane.label}
                  <span>{lane.tasks.length}</span>
                </h4>
                {lane.tasks.length === 0 ? <p className="board-lane-empty">Nothing here</p> : null}
                {lane.tasks.map((task) => {
                  const buddy = byId.get(task.buddyId);
                  if (!buddy) return null;
                  const project = isWebTask(task, projection)
                    ? { name: "Web" }
                    : projection.projects.find((entry) => entry.projectId === task.projectId);
                  return (
                    <button
                      key={task.taskId}
                      type="button"
                      className={`board-card is-${task.status}`}
                      title={task.goal}
                      onClick={() => onSelect(buddy.buddyId)}
                    >
                      <span className="board-card-goal">{task.goal}</span>
                      <span className="board-card-meta">
                        <BuddyAvatar
                          buddy={buddy.color}
                          look={lookOf(buddy)}
                          image={buddy.image}
                          size={16}
                          mood={buddyMood(buddy, tasks)}
                        />
                        <span className="board-card-who">{buddy.name}</span>
                        {project ? <span className="board-card-project">{project.name}</span> : null}
                        <span className="board-card-state">
                          {lane.key === "done" ? STATUS_LABEL[task.status] : relativeTime(latest(task))}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </section>
            ))}
          </div>
        ) : (
          <p className="board-empty">
            No jobs yet. Give the team a goal above, or ask any buddy in its chat, and the jobs show up here.
          </p>
        )}
      </section>
    </>
  );
}

/** Below this width a buddy's details slide over its chat; matches buddyChat.css. */
const NARROW_VIEW = 700;

/** The team's settings, behind the gear on the Buddies list: pausing, how Auto picks models, and importing. */
export function TeamSettingsDialog({
  projection,
  run,
  onClose,
}: {
  projection: RuntimeProjection;
  run: Run;
  onClose(): void;
}) {
  const paused = projection.buddySettings?.paused ?? false;
  return (
    <Dialog label="Team settings" title="Team settings" size="sm" onClose={onClose}>
      <div className="dialog-body team-settings">
        <section className="buddies-section" aria-label="Pause">
          <h3 className="buddies-heading">Work</h3>
          <div className="team-settings-row">
            <p className="buddies-hint">
              {paused
                ? "Paused: no new jobs or routines start. Queued jobs wait until you resume."
                : "Pausing stops new jobs and routines from starting. Running jobs finish; nothing is cancelled."}
            </p>
            <Button
              size="sm"
              variant={paused ? "primary" : "danger"}
              icon={paused ? "play" : "pause"}
              onClick={() => void run({ type: paused ? "buddies.resume" : "buddies.pause" })}
            >
              {paused ? "Resume" : "Pause all"}
            </Button>
          </div>
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
            Auto reads each job, then picks the agent, model and effort that fit it, steering away from logins near
            their limits. It learns from how each job went. New buddies start at this level; each buddy can pick its own
            in its settings.
          </p>
        </section>
        <section className="buddies-section" aria-label="About you">
          <h3 className="buddies-heading">About you</h3>
          <AboutYou projection={projection} run={run} />
        </section>
        <section className="buddies-section" aria-label="Import">
          <h3 className="buddies-heading">Import</h3>
          <ImportBuddy run={run} projection={projection} />
        </section>
      </div>
    </Dialog>
  );
}

/**
 * What every buddy knows about the person. Buddies add to it when the person tells them something lasting; the
 * person can add their own lines and remove any.
 */
export function AboutYou({ projection, run }: { projection: RuntimeProjection; run: Run }) {
  const notes = projection.buddySettings?.aboutMe ?? [];
  const [draft, setDraft] = useState("");
  const nameOf = (buddyId: string | undefined) => projection.buddies?.find((buddy) => buddy.buddyId === buddyId)?.name;
  return (
    <>
      <p className="buddies-hint">
        Every buddy reads this. They add what you tell them about yourself; add or remove anything here.
      </p>
      {notes.length > 0 ? (
        <ul className="about-you-list">
          {notes.map((note) => (
            <li key={note.noteId} className="about-you-note">
              <span className="about-you-text">
                {note.text}
                {nameOf(note.by) ? <span className="about-you-by">learned by {nameOf(note.by)}</span> : null}
              </span>
              <IconButton
                icon="x"
                label={`Remove: ${note.text}`}
                onClick={() => void run({ type: "buddies.about.remove", noteId: note.noteId })}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="about-you-add"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (!text) return;
          void run({ type: "buddies.about.add", note: { noteId: crypto.randomUUID(), text } }).then(() => setDraft(""));
        }}
      >
        <input
          className="input input-sm"
          maxLength={300}
          placeholder="Such as: I'm in Phnom Penh, reply short"
          aria-label="Add something about you"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button size="sm" type="submit" disabled={!draft.trim()}>
          Add
        </Button>
      </form>
    </>
  );
}

/** The buddy's name under its face. A click turns it into a box; Enter or leaving it saves, Escape keeps the old. */
function BuddyNameEdit({ buddy, run }: { buddy: BuddyProjection; run: Run }) {
  const [draft, setDraft] = useState<string>();
  const done = useRef(false);
  const save = async () => {
    if (done.current || draft === undefined) return;
    done.current = true;
    const next = draft.trim();
    if (next && next !== buddy.name)
      await run({ type: "buddy.update", buddyId: buddy.buddyId, changes: { name: next } });
    setDraft(undefined);
  };
  if (draft === undefined)
    return (
      <h2 className="buddy-info-name">
        <button
          type="button"
          className="buddy-info-rename"
          title="Rename"
          aria-label={`Rename ${buddy.name}`}
          onClick={() => {
            done.current = false;
            setDraft(buddy.name);
          }}
        >
          {buddy.name}
          <Icon name="pencil" size={12} />
        </button>
      </h2>
    );
  return (
    <input
      className="input buddy-info-name-input"
      aria-label="Name"
      value={draft}
      maxLength={24}
      // biome-ignore lint/a11y/noAutofocus: the box replaces the name the person just clicked.
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.key === "Enter") void save();
        if (event.key === "Escape") {
          done.current = true;
          setDraft(undefined);
        }
      }}
    />
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
        ...(parsed.buddy.look ? { look: parsed.buddy.look } : {}),
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
      <label className="btn btn-secondary btn-sm">
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

type InfoTab = "activity" | "library" | "settings";

const INFO_TABS: readonly { value: InfoTab; label: string }[] = [
  { value: "activity", label: "Activity" },
  { value: "library", label: "Library" },
  { value: "settings", label: "Settings" },
];

function BuddyPage({
  projection,
  buddy,
  run,
  error,
  onSelect,
  onOpenThread,
  onOpenPullRequest,
}: BuddiesPaneProps & { buddy: BuddyProjection; run: Run; error: ReactNode }) {
  // The details sit beside the chat from the start when there is room; the name tag folds them away and back.
  // Narrow, they would cover the chat, so they start folded and fold away when the space shrinks.
  const [info, setInfo] = useState(true);
  const viewRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return undefined;
    // A width of 0 means it has not been laid out (or cannot be measured): not narrow.
    const isNarrow = () => view.clientWidth > 0 && view.clientWidth < NARROW_VIEW;
    let narrow = isNarrow();
    if (narrow) setInfo(false);
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(() => {
      const now = isNarrow();
      if (now && !narrow) setInfo(false);
      narrow = now;
    });
    observer.observe(view);
    return () => observer.disconnect();
  }, []);
  const [tab, setTab] = useState<InfoTab>("activity");
  const mood = buddyMood(buddy, projection.tasks ?? []);
  const title =
    buddy.role === "primary" ? "Primary buddy" : buddy.title && buddy.title !== buddy.name ? buddy.title : "";
  return (
    <div className="buddy-view" ref={viewRef}>
      <div className="buddy-view-main">
        {/* The chat runs under a floating name tag, like a message thread. */}
        <header className="buddy-view-top">
          <button
            type="button"
            className="buddy-view-tag"
            aria-expanded={info}
            aria-label={`${buddy.name}, ${info ? "hide" : "show"} details`}
            title={info ? "Hide details" : "Show details"}
            onClick={() => setInfo((open) => !open)}
          >
            <BuddyAvatar buddy={buddy.color} look={lookOf(buddy)} image={buddy.image} size={52} mood={mood} />
            <h2 className="buddy-view-name">{buddy.name}</h2>
          </button>
        </header>
        {error}
        <BuddyChat
          buddy={buddy}
          projection={projection}
          run={run}
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
      </div>
      {/* Always there, so it can slide: folded, it is out of reach of the mouse, keyboard and screen readers. */}
      <aside
        className={`buddy-view-info${info ? " is-open" : ""}`}
        aria-label={`About ${buddy.name}`}
        aria-hidden={!info}
        inert={!info}
      >
        <div className="buddy-view-info-inner">
          <div className="buddy-info-close">
            <IconButton label="Hide details" icon="x" onClick={() => setInfo(false)} />
          </div>
          <div className="buddy-info-hero">
            <BuddyLookEditor buddy={buddy} mood={mood} run={run} />
            <BuddyNameEdit buddy={buddy} run={run} />
            {title ? <span>{title}</span> : null}
          </div>
          <Segmented<InfoTab>
            className="buddy-tabs"
            label="Details"
            value={tab}
            options={INFO_TABS}
            onChange={setTab}
          />
          {tab === "activity" ? (
            <ActivityTab buddy={buddy} projection={projection} run={run} />
          ) : tab === "library" ? (
            <LibraryTab buddy={buddy} projection={projection} run={run} />
          ) : (
            <SettingsTab buddy={buddy} projection={projection} run={run} onRemoved={() => onSelect(undefined)} />
          )}
        </div>
      </aside>
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
  const web = isWebTask(task, projection);
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
            {showBuddy && buddy ? (
              <BuddyAvatar buddy={buddy.color} look={lookOf(buddy)} image={buddy.image} size={20} name={buddy.name} />
            ) : null}
            <span className="job-card-status">{STATUS_LABEL[task.status]}</span>
            {task.kind === "review" ? <span className="job-card-tag">Review</span> : null}
            {web ? <span className="job-card-tag">Web</span> : null}
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
      {task.pick && !inline ? (
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
      ) : !inline && task.status === "needs_you" && task.needs ? (
        <p className="job-card-needs">{task.needs.text ?? "Waiting for you in its chat."}</p>
      ) : null}
      {!inline && task.status === "failed" && task.needs?.text ? (
        <p className="job-card-needs">{task.needs.text}</p>
      ) : null}
      {result ? (
        <div className="job-card-result">
          {inline ? null : <p>{result.summary}</p>}
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
            {task.kind === "job" && task.threadId && !web ? (
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
            {task.kind === "job" && task.branch && !web ? (
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

/** What is coming up and how its jobs went. */
function ActivityTab({ buddy, projection, run }: { buddy: BuddyProjection; projection: RuntimeProjection; run: Run }) {
  const stats = useMemo(() => buddyStats(buddy.buddyId, projection.tasks ?? []), [buddy.buddyId, projection.tasks]);
  const routines = (projection.routines ?? []).filter((routine) => routine.buddyId === buddy.buddyId);
  return (
    <div className="buddy-profile">
      <section className="buddies-section" aria-label="Upcoming">
        <h3 className="buddies-heading">Upcoming</h3>
        {routines.map((routine) => (
          <RoutineRow key={routine.routineId} routine={routine} run={run} />
        ))}
        {projection.projects.length > 0 ? <AddRoutine buddy={buddy} projection={projection} run={run} /> : null}
      </section>

      <section className="buddies-section" aria-label="Browser">
        <h3 className="buddies-heading">Browser</h3>
        <BuddyScreen buddy={buddy} projection={projection} run={run} />
      </section>

      <section className="buddies-section" aria-label="Track record">
        <h3 className="buddies-heading">Track record</h3>
        {stats.done === 0 && stats.successRate === undefined ? (
          <p className="buddies-hint">No jobs yet. How its jobs go shows up here.</p>
        ) : (
          <dl className="buddy-card buddy-stats">
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
        )}
        {stats.models.length > 0 ? (
          <ul className="buddy-card buddy-models">
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
    </div>
  );
}

function RoutineRow({ routine, run }: { routine: RoutineProjection; run: Run }) {
  const goal = routine.goal.split("\n")[0] ?? "";
  return (
    <div className={`buddy-card buddy-routine${routine.paused ? " is-paused" : ""}`}>
      <Icon name="history" size={15} />
      <span className="buddy-card-text">
        <span className="buddy-card-title" title={goal}>
          {goal}
        </span>
        <span className="buddy-card-sub">
          {triggerLabel(routine.trigger)}
          {routine.paused && routine.failuresInRow >= 3 ? " · paused after 3 failed runs" : ""}
        </span>
      </span>
      <IconButton
        className="buddy-routine-remove"
        label="Remove routine"
        icon="x"
        size="xs"
        onClick={() => void run({ type: "routine.remove", routineId: routine.routineId })}
      />
      <input
        className="switch"
        type="checkbox"
        role="switch"
        aria-label={routine.paused ? `Turn on: ${goal}` : `Pause: ${goal}`}
        checked={!routine.paused}
        aria-checked={!routine.paused}
        onChange={(event) =>
          void run({ type: "routine.setPaused", routineId: routine.routineId, paused: !event.target.checked })
        }
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
