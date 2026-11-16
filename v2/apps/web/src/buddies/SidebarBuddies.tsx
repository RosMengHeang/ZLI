import { type BuddyProjection, buddiesInOrder, needsYou, type RuntimeProjection } from "@zli-v2/contracts";
import { type MouseEvent, useState } from "react";
import { ConfirmDialog } from "../review/ConfirmDialog.js";
import { relativeTime } from "../sessions/sessions.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { IconButton } from "../ui/Button.js";
import { Menu, type MenuRequest } from "../ui/Menu.js";

import { buddyMood } from "./BuddiesPane.js";
import { NewBuddyDialog } from "./NewBuddyDialog.js";
import { useRun } from "./useRun.js";

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
  const run = useRun(setError);
  if (!projection) return null;
  const team = buddiesInOrder(projection);
  if (team.length === 0)
    return projection.projects.length > 0 ? (
      <section className="sidebar-buddies" aria-label="Buddies">
        <button type="button" className="sidebar-buddy" onClick={() => onOpen()}>
          <BuddyAvatar buddy="tangerine" size={20} />
          <span className="sidebar-buddy-text">
            <span className="sidebar-buddy-name">Buddies</span>
            <span className="sidebar-buddy-line">Start a team that takes jobs for you</span>
          </span>
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
      <h2 className="sidebar-buddies-head">
        Buddies
        {waiting > 0 ? (
          <button type="button" className="sidebar-buddies-needs" onClick={() => onOpen()}>
            Needs you · {waiting}
          </button>
        ) : null}
        <IconButton
          className="sidebar-buddies-add"
          label="Add a buddy"
          tooltip="Add a buddy"
          icon="plus"
          size="xs"
          onClick={() => setAdding(true)}
        />
      </h2>
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
      {team.map((buddy) => (
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
