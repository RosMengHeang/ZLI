import { type BuddyProjection, buddiesInOrder, needsYou, type RuntimeProjection } from "@zli-v2/contracts";
import { type MouseEvent, useState } from "react";
import { ConfirmDialog } from "../review/ConfirmDialog.js";
import { relativeTime } from "../sessions/sessions.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { BuddyGlyph } from "../ui/BuddyGlyph.js";
import { IconButton } from "../ui/Button.js";
import { Menu, type MenuRequest } from "../ui/Menu.js";

import { buddyMood } from "./BuddiesPane.js";
import { NewBuddyDialog } from "./NewBuddyDialog.js";
import { useRun } from "./useRun.js";

/** Whether the roster under Buddies is open; closed, their faces sit on the line. Remembered in this browser. */
const ROSTER_KEY = "zli.sidebar.roster";

function readRosterOpen(): boolean {
  try {
    return window.localStorage.getItem(ROSTER_KEY) === "open";
  } catch {
    return false;
  }
}

/**
 * The team at the top of the sidebar, in the order the person set: the Primary first, then the rest
 * where they were dragged. A row's place never changes with its status; its sentence does.
 */
export function SidebarBuddies({
  projection,
  onOpen,
  active,
}: {
  projection: RuntimeProjection | undefined;
  /** The buddy whose chat is open, or "team" for the buddies' home. */
  active?: string | undefined;
  /** Opens the Buddies panel, on one buddy when given. */
  onOpen(buddyId?: string): void;
}) {
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<MenuRequest>();
  const [removing, setRemoving] = useState<BuddyProjection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [rosterOpen, setRosterOpen] = useState(readRosterOpen);
  const run = useRun(setError);
  const toggleRoster = () =>
    setRosterOpen((open) => {
      try {
        window.localStorage.setItem(ROSTER_KEY, open ? "closed" : "open");
      } catch {
        // Blocked storage: the choice lasts until the window closes.
      }
      return !open;
    });
  if (!projection) return null;
  const team = buddiesInOrder(projection);
  if (team.length === 0)
    return projection.projects.length > 0 ? (
      <section className="sidebar-buddies" aria-label="Buddies">
        <button
          type="button"
          className="sidebar-nav-item"
          title="Start a team that takes jobs for you"
          onClick={() => onOpen()}
        >
          <BuddyGlyph size={16} />
          <span className="sidebar-nav-label">Buddies</span>
          <BuddyAvatar buddy="tangerine" size={18} />
        </button>
      </section>
    ) : null;
  const waiting = needsYou(projection).length;
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
        { label: "Open chat", icon: "message", run: () => onOpen(buddy.buddyId) },
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
    if (active === buddy.buddyId) onOpen();
  };
  const tasks = projection.tasks ?? [];
  return (
    <section className="sidebar-buddies" aria-label="Buddies">
      {/* One menu line for the whole team: their faces show who is busy; the roster opens under it. */}
      <div className={`sidebar-nav-row${active ? " is-active" : ""}`}>
        <button
          type="button"
          className="sidebar-nav-item sidebar-team"
          aria-current={active ? "page" : undefined}
          onClick={() => onOpen()}
        >
          <BuddyGlyph size={16} />
          <span className="sidebar-nav-label">Buddies</span>
          {waiting > 0 ? (
            <span className="sidebar-nav-badge is-needs" title={`${waiting} need${waiting === 1 ? "s" : ""} you`}>
              {waiting}
            </span>
          ) : rosterOpen ? null : (
            <span className="sidebar-team-faces" aria-hidden="true">
              {team.slice(0, 4).map((buddy) => (
                <BuddyAvatar key={buddy.buddyId} buddy={buddy.color} size={18} mood={buddyMood(buddy, tasks)} />
              ))}
            </span>
          )}
        </button>
        <IconButton
          className="sidebar-buddies-add"
          label="Add a buddy"
          tooltip="Add a buddy"
          icon="plus"
          size="xs"
          onClick={() => setAdding(true)}
        />
        <IconButton
          className="sidebar-team-toggle"
          label={rosterOpen ? "Hide the team" : "Show the team"}
          tooltip={rosterOpen ? "Hide the team" : "Show the team"}
          icon={rosterOpen ? "chevronUp" : "chevronDown"}
          size="xs"
          aria-expanded={rosterOpen}
          onClick={toggleRoster}
        />
      </div>
      {adding ? (
        <NewBuddyDialog
          projection={projection}
          onClose={() => setAdding(false)}
          onCreated={(buddyId) => {
            setAdding(false);
            onOpen(buddyId);
          }}
        />
      ) : null}
      {(rosterOpen ? team : []).map((buddy) => (
        <button
          key={buddy.buddyId}
          type="button"
          className={`sidebar-buddy${active === buddy.buddyId ? " is-active" : ""}`}
          aria-current={active === buddy.buddyId ? "page" : undefined}
          onClick={() => onOpen(buddy.buddyId)}
          onContextMenu={(event) => openMenu(event, buddy)}
          title={buddy.lastLine?.text}
        >
          <BuddyAvatar buddy={buddy.color} size={24} mood={buddyMood(buddy, tasks)} name={buddy.name} />
          <span className="sidebar-buddy-text">
            <span className="sidebar-buddy-name">
              {buddy.name}
              {buddy.lastLine ? <span className="sidebar-buddy-time">{relativeTime(buddy.lastLine.at)}</span> : null}
            </span>
            <span className="sidebar-buddy-line">{buddy.lastLine?.text ?? "Ready for a job"}</span>
          </span>
        </button>
      ))}
      {menu ? <Menu request={menu} onClose={() => setMenu(undefined)} /> : null}
      {removing ? (
        <ConfirmDialog
          label={`Remove ${removing.name}`}
          title={`Remove ${removing.name}?`}
          detail={
            <>
              {removing.name} leaves the team for good, with its chat and what it remembers. Jobs waiting in its queue
              are cancelled. This can't be undone.
              {error ? (
                <span className="inline-error" role="alert">
                  {" "}
                  {error}
                </span>
              ) : null}
            </>
          }
          confirmLabel="Remove"
          busy={busy}
          onConfirm={() => void remove(removing)}
          onCancel={() => {
            setError(undefined);
            setRemoving(undefined);
          }}
        />
      ) : null}
    </section>
  );
}
