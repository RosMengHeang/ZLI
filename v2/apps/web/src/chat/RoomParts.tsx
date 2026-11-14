import type { ThreadActivityProjection } from "@zli-v2/contracts";
import { useEffect, useState } from "react";

import { BuddyAvatar, useAvatarMood } from "../teammates/BuddyAvatar.js";
import type { Buddy } from "../teammates/buddies.js";
import { Button } from "../ui/Button.js";
import { MenuButton, type MenuItem } from "../ui/Menu.js";
import { elapsedLabel } from "./WorkLog.js";

/** Someone in the chat, as the team bar, the speaker lines, and the live cards show them. */
export type RoomPerson = {
  id: string;
  name: string;
  /** The agent CLI, such as Codex, and the model when one was picked. */
  agent: string;
  provider: string;
  buddy: Buddy;
  status: string | undefined;
  /** The step running now, which reads as "reading src/app.ts". */
  step: ThreadActivityProjection | undefined;
  role: "host" | "guest" | "helper";
  /** A helper in a terminal has no messages to show here, only its own tile. */
  terminal?: boolean | undefined;
};

export function PersonAvatar({ person, size = 22 }: { person: RoomPerson; size?: number }) {
  const mood = useAvatarMood(person.status, person.step !== undefined);
  return <BuddyAvatar buddy={person.buddy} mood={mood} size={size} provider={person.provider} name={person.name} />;
}

/** The line over a reply when more than one agent talks in the chat: who is speaking. */
export function RoomSpeaker({ person }: { person: RoomPerson }) {
  return (
    <div className="room-speaker">
      <PersonAvatar person={person} size={20} />
      <span className="room-speaker-name">{person.name}</span>
      <span className="room-speaker-agent">{person.agent}</span>
    </div>
  );
}

function liveText(person: RoomPerson): string {
  if (person.status === "waiting") return `${person.name} needs you`;
  if (person.status === "starting") return `${person.name} is joining`;
  if (person.terminal) return `${person.name} is working in its terminal`;
  if (person.step) return person.step.title;
  return `${person.name} is thinking`;
}

/**
 * A member at work, at the end of the chat. Guests answer in the chat when they finish; helpers work on their
 * own, so their card offers their chat.
 */
export function RoomLive({ person, onOpen }: { person: RoomPerson; onOpen?: (() => void) | undefined }) {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className={`room-live${person.status === "waiting" ? " is-waiting" : ""}`} role="status">
      <PersonAvatar person={person} size={26} />
      <span className="room-live-copy">
        <span className="room-live-who">
          {person.name}
          <span className="room-live-role">{person.role === "helper" ? "helper" : person.agent}</span>
        </span>
        <span className={`room-live-step${person.step ? "" : " shimmer-text"}`}>{liveText(person)}</span>
      </span>
      <span className="room-live-time">{elapsedLabel(now - startedAt)}</span>
      {onOpen ? (
        <Button variant="ghost" size="xs" onClick={onOpen}>
          Open
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Who is in the chat, above the message box: the chat's agent, the agents brought in, and helpers. Each one's
 * avatar shows what it is doing; a click offers to call it, open its own chat, or let it go.
 */
export function RoomBar({
  people,
  bringInItems,
  bringing,
  personItems,
}: {
  people: readonly RoomPerson[];
  /** Absent where agents cannot start from this chat. */
  bringInItems?: (() => MenuItem[]) | undefined;
  /** The name of the agent on its way in. */
  bringing?: string | undefined;
  personItems(person: RoomPerson): MenuItem[];
}) {
  const others = people.filter((person) => person.role !== "host");
  // Alone, the chat's agent needs no bar: Bring in sits in the message box's + menu.
  if (others.length === 0 && !bringing) return null;
  return (
    <section className="room-bar" aria-label="Who is in this chat">
      {others.length > 0 ? (
        <ul className="room-people">
          {people.map((person) => (
            <li key={person.id} className={`room-person is-${person.role}`}>
              {person.role === "host" ? (
                <span className="room-person-chip" title={`${person.name}, this chat's agent`}>
                  <PersonAvatar person={person} size={20} />
                  <span className="room-person-name">{person.name}</span>
                </span>
              ) : (
                <MenuButton
                  className="room-person-chip"
                  label={`${person.name}, ${person.role === "helper" ? "helper" : person.agent}`}
                  tooltip={person.role === "helper" ? `${person.name}, started by an agent here` : person.agent}
                  icon="chevronDown"
                  size="xs"
                  items={() => personItems(person)}
                >
                  <PersonAvatar person={person} size={20} />
                  <span className="room-person-name">{person.name}</span>
                </MenuButton>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {bringing ? (
        <span className="room-bar-joining shimmer-text" role="status">
          {bringing} is joining
        </span>
      ) : null}
      {bringInItems && others.length > 0 ? (
        <MenuButton
          className="room-bring"
          label="Bring in an agent"
          tooltip="Add an agent or a saved teammate to this chat"
          icon="plus"
          size="xs"
          items={bringInItems}
        >
          <span>Bring in</span>
        </MenuButton>
      ) : null}
    </section>
  );
}
