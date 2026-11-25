import { needsYou, type RuntimeProjection } from "@zli-v2/contracts";

import { BuddyGlyph } from "../ui/BuddyGlyph.js";
import { liveTeams, teamPageId } from "./TeamView.js";
import "./teamView.css";

/**
 * Buddies in the sidebar menu: one line like the others, lit while a buddy page is open, with an amber count
 * when someone on the team needs the person, and a Beta tag while buddies are new. Teams going now list under
 * it, each opening its team page like a chat. The buddies themselves are listed on the Buddies page.
 */
export function SidebarBuddies({
  projection,
  onOpen,
  active,
}: {
  projection: RuntimeProjection | undefined;
  /** The buddy whose chat is open, "team" for the team board, or a team's page id. */
  active?: string | undefined;
  /** Opens the Buddies page, on one buddy or team when given. */
  onOpen(buddyId?: string): void;
}) {
  // Buddies are listed before any project is added: Primary can be talked to from the first launch.
  if (!projection) return null;
  const waiting = needsYou(projection).length;
  const teams = liveTeams(projection);
  const onTeam = teams.some((team) => active === teamPageId(team.goalId));
  return (
    <>
      <button
        type="button"
        className={`sidebar-nav-item sidebar-team${active && !onTeam ? " is-active" : ""}`}
        aria-current={active && !onTeam ? "page" : undefined}
        onClick={() => onOpen()}
      >
        <BuddyGlyph size={16} />
        <span className="sidebar-nav-label">Buddies</span>
        <span className="sidebar-beta" title="Buddies are new and still changing">
          Beta
        </span>
        {waiting > 0 ? (
          <span className="sidebar-nav-badge is-needs" title={`${waiting} need${waiting === 1 ? "s" : ""} you`}>
            {waiting}
          </span>
        ) : null}
      </button>
      {teams.length > 0 ? (
        <ul className="sidebar-teams" aria-label="Teams">
          {teams.map((team) => {
            const page = teamPageId(team.goalId);
            const waitingOnYou = team.status === "needs_you";
            return (
              <li key={team.goalId}>
                <button
                  type="button"
                  className={`sidebar-nav-item sidebar-team-row${active === page ? " is-active" : ""}`}
                  aria-current={active === page ? "page" : undefined}
                  title={team.text}
                  onClick={() => onOpen(page)}
                >
                  <span
                    className={`sidebar-team-dot${waitingOnYou ? " is-waiting" : ""}`}
                    role="img"
                    aria-label={waitingOnYou ? "Waiting for you" : "Working"}
                  />
                  <span className="sidebar-nav-label">{team.text}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}
