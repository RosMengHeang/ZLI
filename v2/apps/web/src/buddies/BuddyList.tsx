import {
  type BuddyProjection,
  isOpenTask,
  needsYou,
  openQuestion,
  type RuntimeProjection,
  type TaskProjection,
  teamsOf,
} from "@zli-v2/contracts";
import { type MouseEvent, useState } from "react";

import { ConfirmDialog } from "../review/ConfirmDialog.js";

import { relativeTime } from "../sessions/sessions.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { lookOf } from "../teammates/pixelBuddies.js";
import { IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { Menu, type MenuRequest } from "../ui/Menu.js";
import { buddyMood, TeamSettingsDialog } from "./BuddiesPane.js";
import { ConnectedAppsDialog } from "./ConnectedAppsDialog.js";
import { NewBuddyDialog } from "./NewBuddyDialog.js";
import { teamPageId, teamStatus } from "./TeamView.js";
import type { Run } from "./useRun.js";

/** What a buddy that needs the person is asking, in one line. */
function askLine(task: TaskProjection): string {
  return openQuestion(task)?.text ?? task.needs?.text ?? "Needs you";
}

/**
 * The team as a list beside the open chat, like contacts in a messenger: the team board first, then whoever
 * needs the person, then every buddy in the order the person set, with its face, role, last line and time.
 */
export function BuddyList({
  projection,
  team,
  selectedId,
  run,
  onSelect,
}: {
  projection: RuntimeProjection;
  team: readonly BuddyProjection[];
  selectedId: string | undefined;
  run: Run;
  onSelect(buddyId: string | undefined): void;
}) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const [dragged, setDragged] = useState<string>();
  const [menu, setMenu] = useState<MenuRequest>();
  const [removing, setRemoving] = useState<BuddyProjection>();
  const [busy, setBusy] = useState(false);
  /** Right-click, Shift+F10 or the Menu key on a row. With no pointer position, the menu opens under the row. */
  const openMenu = (event: MouseEvent<HTMLElement>, buddy: BuddyProjection) => {
    event.preventDefault();
    const row = event.currentTarget.getBoundingClientRect();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    setMenu({
      x: fromKeyboard ? row.left : event.clientX,
      y: fromKeyboard ? row.bottom : event.clientY,
      label: `${buddy.name} actions`,
      items: [
        { label: "Open chat", icon: "message", run: () => onSelect(buddy.buddyId) },
        { separator: true },
        { label: `Remove ${buddy.name}`, icon: "trash", tone: "danger", run: () => setRemoving(buddy) },
      ],
    });
  };
  const remove = async (buddy: BuddyProjection) => {
    setBusy(true);
    const ok = await run({ type: "buddy.archive", buddyId: buddy.buddyId });
    setBusy(false);
    if (!ok) return;
    setRemoving(undefined);
    if (selectedId === buddy.buddyId) onSelect(undefined);
  };
  const tasks = projection.tasks ?? [];
  const waiting = needsYou(projection);
  const paused = projection.buddySettings?.paused ?? false;
  const openJobs = tasks.filter(isOpenTask).length;
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? team.filter((buddy) => `${buddy.name} ${buddy.title ?? ""}`.toLowerCase().includes(needle))
    : team;
  const byId = new Map(team.map((buddy) => [buddy.buddyId, buddy]));
  // Teams going now, then the last few that ended.
  const allTeams = teamsOf(projection);
  const isLive = (entry: (typeof allTeams)[number]) => entry.status === "working" || entry.status === "needs_you";
  const teams = [...allTeams.filter(isLive), ...allTeams.filter((entry) => !isLive(entry)).slice(0, 3)];
  const drop = (targetId: string) => {
    if (!dragged || dragged === targetId) return;
    const ids = team.map((buddy) => buddy.buddyId).filter((id) => id !== dragged);
    ids.splice(ids.indexOf(targetId), 0, dragged);
    setDragged(undefined);
    void run({ type: "buddy.reorder", buddyIds: ids });
  };
  return (
    <nav className="buddy-list" aria-label="Team">
      <header className="buddy-list-head">
        <h2>Buddies</h2>
        <IconButton
          label="Team settings"
          tooltip="Team settings: pause, how Auto picks models, import"
          icon="settings"
          size="sm"
          onClick={() => setSettingsOpen(true)}
        />
        <IconButton label="Add a buddy" tooltip="Add a buddy" icon="plus" size="sm" onClick={() => setAdding(true)} />
      </header>
      {/* Paused says so where the team is listed, with the way back one click away. */}
      {paused ? (
        <div className="buddy-list-paused" role="status">
          <Icon name="pause" size={13} />
          <span>Paused. Nothing new starts.</span>
          <button type="button" onClick={() => void run({ type: "buddies.resume" })}>
            Resume
          </button>
        </div>
      ) : null}
      {team.length > 4 ? (
        <label className="buddy-list-find">
          <Icon name="search" size={14} />
          <input
            type="search"
            placeholder="Find a buddy"
            aria-label="Find a buddy"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      ) : null}
      <div className="buddy-list-scroll">
        <button
          type="button"
          className={`buddy-list-row is-board${selectedId === undefined ? " is-active" : ""}`}
          aria-current={selectedId === undefined ? "page" : undefined}
          onClick={() => onSelect(undefined)}
        >
          <span className="buddy-list-board" aria-hidden="true">
            <Icon name="board" size={18} />
          </span>
          <span className="buddy-list-text">
            <span className="buddy-list-name">Team board</span>
            <span className="buddy-list-line">
              {paused
                ? "Paused"
                : `${openJobs} job${openJobs === 1 ? "" : "s"} open${waiting.length > 0 ? ` · ${waiting.length} need${waiting.length === 1 ? "s" : ""} you` : ""}`}
            </span>
          </span>
        </button>

        {waiting.length > 0 && !needle ? (
          <section className="buddy-list-section" aria-label="Needs you">
            <h3 className="buddy-list-heading">Needs you</h3>
            {waiting.map((task) => {
              const buddy = byId.get(task.buddyId);
              if (!buddy) return null;
              return (
                <button
                  key={task.taskId}
                  type="button"
                  className="buddy-list-row is-needs"
                  onClick={() => onSelect(buddy.buddyId)}
                >
                  <BuddyAvatar buddy={buddy.color} look={lookOf(buddy)} image={buddy.image} size={36} mood="waiting" />
                  <span className="buddy-list-text">
                    <span className="buddy-list-name">
                      {buddy.name}
                      <span className="buddy-list-time">{relativeTime(task.updatedAt)}</span>
                    </span>
                    <span className="buddy-list-line">{askLine(task)}</span>
                  </span>
                </button>
              );
            })}
          </section>
        ) : null}

        {!needle ? (
          <section className="buddy-list-section" aria-label="Teams">
            <h3 className="buddy-list-heading">Teams {teams.length > 0 ? <span>{teams.length}</span> : null}</h3>
            {teams.map((entry) => {
              const page = teamPageId(entry.goalId);
              return (
                <button
                  key={entry.goalId}
                  type="button"
                  className={`buddy-list-row is-team${selectedId === page ? " is-active" : ""}`}
                  aria-current={selectedId === page ? "page" : undefined}
                  onClick={() => onSelect(page)}
                >
                  <span className="buddy-list-board" aria-hidden="true">
                    <Icon name="users" size={18} />
                  </span>
                  <span className="buddy-list-text">
                    <span className="buddy-list-name">{entry.text}</span>
                    <span className="buddy-list-line">{teamStatus(entry)}</span>
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              className={`buddy-list-row is-team${selectedId === teamPageId("new") ? " is-active" : ""}`}
              onClick={() => onSelect(teamPageId("new"))}
            >
              <span className="buddy-list-board" aria-hidden="true">
                <Icon name="plus" size={18} />
              </span>
              <span className="buddy-list-text">
                <span className="buddy-list-name">New team</span>
              </span>
            </button>
          </section>
        ) : null}

        <section className="buddy-list-section" aria-label="Everyone">
          <h3 className="buddy-list-heading">
            Team <span>{team.length}</span>
          </h3>
          <ul className="buddy-list-items">
            {shown.map((buddy) => {
              const mood = buddyMood(buddy, tasks);
              const role = buddy.role === "primary" ? "Primary" : buddy.title;
              const roleShown = role && role !== buddy.name ? role : undefined;
              const active = selectedId === buddy.buddyId;
              return (
                <li
                  key={buddy.buddyId}
                  className={`buddies-row${dragged === buddy.buddyId ? " is-dragging" : ""}`}
                  draggable={buddy.role !== "primary" && !needle}
                  onDragStart={() => setDragged(buddy.buddyId)}
                  onDragEnd={() => setDragged(undefined)}
                  onDragOver={(event) => {
                    if (dragged && buddy.role !== "primary") event.preventDefault();
                  }}
                  onDrop={() => drop(buddy.buddyId)}
                >
                  <button
                    type="button"
                    className={`buddy-list-row buddies-row-main is-${mood}${active ? " is-active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    onClick={() => onSelect(buddy.buddyId)}
                    onContextMenu={(event) => openMenu(event, buddy)}
                  >
                    <BuddyAvatar
                      buddy={buddy.color}
                      look={lookOf(buddy)}
                      image={buddy.image}
                      size={36}
                      mood={mood}
                      name={buddy.name}
                    />
                    <span className="buddy-list-text">
                      <span className="buddy-list-name buddies-row-name">
                        <span className="buddy-list-person">{buddy.name}</span>
                        {roleShown ? <span className="buddy-list-role">{roleShown}</span> : null}
                        {buddy.lastLine ? (
                          <span className="buddy-list-time">{relativeTime(buddy.lastLine.at)}</span>
                        ) : null}
                      </span>
                      <span className="buddy-list-line">{buddy.lastLine?.text ?? "Ready for a job"}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {shown.length === 0 ? <p className="buddy-list-empty">No buddy by that name.</p> : null}
        </section>
      </div>
      {/* Apps every buddy can use, at the foot of the list like a sidebar's settings. */}
      <footer className="buddy-list-foot">
        <button
          type="button"
          className="buddy-list-foot-btn"
          title="Connected apps: Gmail, Slack, GitHub and more"
          onClick={() => setAppsOpen(true)}
        >
          <span className="buddy-list-foot-icon" aria-hidden="true">
            <Icon name="extensions" size={15} />
          </span>
          <span>Extensions</span>
        </button>
      </footer>
      {settingsOpen ? (
        <TeamSettingsDialog projection={projection} run={run} onClose={() => setSettingsOpen(false)} />
      ) : null}
      {appsOpen ? <ConnectedAppsDialog onClose={() => setAppsOpen(false)} /> : null}
      {menu ? <Menu request={menu} onClose={() => setMenu(undefined)} /> : null}
      {removing ? (
        <ConfirmDialog
          label={`Remove ${removing.name}`}
          title={`Remove ${removing.name}?`}
          detail={`${removing.name} leaves the team for good, with its chat and what it remembers. Jobs waiting in its queue are cancelled. This can't be undone.`}
          confirmLabel="Remove"
          busy={busy}
          onConfirm={() => void remove(removing)}
          onCancel={() => setRemoving(undefined)}
        />
      ) : null}
      {adding ? (
        <NewBuddyDialog
          projection={projection}
          onClose={() => setAdding(false)}
          onCreated={(buddyId) => {
            setAdding(false);
            onSelect(buddyId);
          }}
        />
      ) : null}
    </nav>
  );
}
