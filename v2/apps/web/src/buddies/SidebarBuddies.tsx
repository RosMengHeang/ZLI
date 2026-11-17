import { needsYou, type RuntimeProjection } from "@zli-v2/contracts";

import { BuddyGlyph } from "../ui/BuddyGlyph.js";

/**
 * Buddies in the sidebar menu: one line like the others, lit while a buddy page is open, with an amber count
 * when someone on the team needs the person. The team itself is listed on the Buddies page.
 */
export function SidebarBuddies({
  projection,
  onOpen,
  active,
}: {
  projection: RuntimeProjection | undefined;
  /** The buddy whose chat is open, or "team" for the team board. */
  active?: string | undefined;
  /** Opens the Buddies page, on one buddy when given. */
  onOpen(buddyId?: string): void;
}) {
  if (!projection || projection.projects.length === 0) return null;
  const waiting = needsYou(projection).length;
  return (
    <button
      type="button"
      className={`sidebar-nav-item sidebar-team${active ? " is-active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={() => onOpen()}
    >
      <BuddyGlyph size={16} />
      <span className="sidebar-nav-label">Buddies</span>
      {waiting > 0 ? (
        <span className="sidebar-nav-badge is-needs" title={`${waiting} need${waiting === 1 ? "s" : ""} you`}>
          {waiting}
        </span>
      ) : null}
    </button>
  );
}
