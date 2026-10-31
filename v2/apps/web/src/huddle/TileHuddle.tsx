import { type HuddleProjection, huddlesOf, type RuntimeProjection } from "@zli-v2/contracts";

import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { MenuButton, type MenuEntry } from "../ui/Menu.js";
import { fitHuddleName, liveHuddles } from "./huddles.js";
import { useHuddleCommands } from "./useHuddleCommands.js";
import "./huddle.css";

/** The huddles a tile's agent is in, as one chip that opens the Huddle panel. */
export function TileHuddleChip({
  huddles,
  onOpen,
}: {
  huddles: readonly HuddleProjection[];
  onOpen(huddleId: string): void;
}) {
  const first = huddles[0];
  if (!first) return null;
  const many = huddles.length > 1;
  const text = many ? `${huddles.length} huddles` : first.name;
  return (
    <button
      type="button"
      className="tile-huddle"
      title={many ? `In ${huddles.map((huddle) => huddle.name).join(", ")}` : `In the huddle ${first.name}`}
      aria-label={many ? `In ${huddles.length} huddles. Open ${first.name}` : `In the huddle ${first.name}. Open it`}
      onClick={() => onOpen(first.huddleId)}
    >
      <Icon name="users" size={11} />
      <span>{text}</span>
    </button>
  );
}

/**
 * The tile's Add to huddle menu: each live huddle, checked while the agent is in it, and a new huddle
 * with just this agent. Picking a checked huddle takes the agent out of it.
 */
export function HuddleMenuButton({
  projection,
  agentId,
  agentLabel,
  onOpen,
  onError,
}: {
  projection: RuntimeProjection;
  agentId: string;
  agentLabel: string;
  onOpen(huddleId: string): void;
  onError(message: string | undefined): void;
}) {
  const commands = useHuddleCommands();
  const live = liveHuddles(projection);
  const memberOf = new Set(huddlesOf(projection, agentId).map((huddle) => huddle.huddleId));
  const run = async (command: Record<string, unknown>) => {
    onError(undefined);
    const error = await commands.run(command);
    if (error) onError(error);
  };
  const items: MenuEntry[] = [
    ...live.map(
      (huddle): MenuEntry => ({
        id: huddle.huddleId,
        label: huddle.name,
        checked: memberOf.has(huddle.huddleId),
        title: memberOf.has(huddle.huddleId) ? `Remove ${agentLabel} from ${huddle.name}` : undefined,
        run: () =>
          void run({
            type: memberOf.has(huddle.huddleId) ? "huddle.leave" : "huddle.join",
            huddleId: huddle.huddleId,
            agentId,
          }),
      }),
    ),
    ...(live.length > 0 ? (["separator"] as const) : []),
    {
      id: "new",
      label: "New huddle with this agent",
      icon: "plus",
      run: () =>
        void (async () => {
          onError(undefined);
          const result = await commands.create(fitHuddleName(`Huddle with ${agentLabel}`), [agentId]);
          if ("error" in result) onError(result.error);
          else onOpen(result.huddleId);
        })(),
    },
  ];
  return (
    <MenuButton
      label="Add to huddle"
      tooltip="Add this agent to a huddle"
      icon="users"
      size="sm"
      iconSize={13}
      items={items}
    />
  );
}

/** Shown on an agent terminal while huddle messages wait for the person's unsent typing there. */
export function HuddleHeldPill({
  count,
  agentId,
  onError,
}: {
  count: number;
  agentId: string;
  onError(message: string | undefined): void;
}) {
  const commands = useHuddleCommands();
  if (count <= 0) return null;
  const release = async () => {
    onError(undefined);
    const error = await commands.run({ type: "huddle.release", agentId });
    if (error) onError(error);
  };
  return (
    <div className="huddle-held-pill" role="status">
      <Icon name="users" size={12} />
      <span className="huddle-held-text">
        {count === 1
          ? "1 huddle message is waiting for you to press Enter"
          : `${count} huddle messages are waiting for you to press Enter`}
      </span>
      <Button
        size="xs"
        variant="secondary"
        tooltip="Type the held messages into the terminal now"
        onClick={() => void release()}
      >
        Type now
      </Button>
    </div>
  );
}
