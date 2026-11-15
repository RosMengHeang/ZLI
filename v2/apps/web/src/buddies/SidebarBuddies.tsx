import { buddiesInOrder, needsYou, type RuntimeProjection } from "@zli-v2/contracts";

import { relativeTime } from "../sessions/sessions.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { IconButton } from "../ui/Button.js";
import { buddyMood, NEW_BUDDY } from "./BuddiesPane.js";

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
          onClick={() => onOpen(NEW_BUDDY)}
        />
      </h2>
      {team.map((buddy) => (
        <button
          key={buddy.buddyId}
          type="button"
          className={`sidebar-buddy${active === buddy.buddyId ? " is-active" : ""}`}
          aria-current={active === buddy.buddyId ? "page" : undefined}
          onClick={() => onOpen(buddy.buddyId)}
          title={buddy.lastLine?.text}
        >
          <BuddyAvatar buddy={buddy.color} size={28} mood={buddyMood(buddy, tasks)} name={buddy.name} />
          <span className="sidebar-buddy-text">
            <span className="sidebar-buddy-name">
              {buddy.name}
              {buddy.lastLine ? <span className="sidebar-buddy-time">{relativeTime(buddy.lastLine.at)}</span> : null}
            </span>
            <span className="sidebar-buddy-line">{buddy.lastLine?.text ?? "Ready for a job"}</span>
          </span>
        </button>
      ))}
    </section>
  );
}
