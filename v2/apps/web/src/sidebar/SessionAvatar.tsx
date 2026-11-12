import type { AgentSession, SessionStatus } from "../sessions/sessions.js";
import { useAppSettings } from "../settings/appSettings.js";
import { AnimalAvatar, useAvatarMood } from "../teammates/AnimalAvatar.js";
import { useChatAnimal } from "../teammates/chatAnimals.js";
import { teammateNamed } from "../teammates/teammates.js";

/** A session's status in the words the avatar's mood understands. */
const moodStatus: Record<SessionStatus, string> = {
  preparing: "starting",
  starting: "starting",
  working: "working",
  waiting: "waiting",
  ready: "idle",
  // A stopped chat picks up again with the next message, so it keeps its colour.
  ended: "idle",
  failed: "failed",
};

/**
 * The chat's own animal in the sidebar. It belongs to the chat, so switching agent or model leaves it alone;
 * a chat started as a saved teammate wears that teammate's animal. It bobs while the chat works, raises a paw
 * when it needs the person, and nods once when a turn ends.
 */
export function SessionAvatar({
  session,
  size = 22,
  quietStart = false,
}: {
  session: Pick<AgentSession, "sessionId" | "status" | "thread" | "terminal">;
  size?: number;
  /** A chat that is starting already takes messages, so it rests instead of looking busy. */
  quietStart?: boolean;
}) {
  const { teammates } = useAppSettings();
  const name = session.thread?.name ?? session.terminal?.name;
  const own = useChatAnimal(session.sessionId);
  const animal = teammateNamed(teammates, name)?.animal ?? own;
  const status = quietStart && moodStatus[session.status] === "starting" ? "idle" : moodStatus[session.status];
  const mood = useAvatarMood(status, true);
  return <AnimalAvatar animal={animal} mood={mood} size={size} className="session-avatar" />;
}
