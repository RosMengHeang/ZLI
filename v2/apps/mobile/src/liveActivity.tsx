import { Button, HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  buttonStyle,
  controlSize,
  font,
  foregroundStyle,
  lineLimit,
  padding,
  tint,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { addUserInteractionListener, createLiveActivity, type LiveActivityEnvironment } from "expo-widgets";

import { agentLink, type LiveAction, type LiveStatus } from "./lib/liveStatus.js";

const NAME = "ZliAgents";
/** iOS suspends the app soon after it leaves the screen, and the activity stops updating with it. */
const STALE_AFTER_MS = 30_000;

type ActivityProps = {
  title: string;
  detail: string;
  badge: string;
  others: string;
  needsYou: boolean;
  url: string;
  actions: LiveAction[];
};

// Runs in the widget extension from a serialized copy: everything it uses has to be inside it.
const AgentsActivity = (props: ActivityProps, environment: LiveActivityEnvironment) => {
  "widget";
  const dark = environment.colorScheme === "dark";
  const amber = dark ? "#e3b45f" : "#875500";
  const blue = dark ? "#8ab0fe" : "#2350c4";
  const accent = props.needsYou ? amber : blue;
  const islandAccent = props.needsYou ? "#e3b45f" : "#8ab0fe";
  const symbol = props.needsYou ? "exclamationmark.bubble.fill" : "ellipsis.bubble.fill";
  const detail = environment.isStale ? "Open ZLI Remote to see the latest." : props.detail;

  const details = (color: string, stop: string) => {
    const lines = [
      <Text key="detail" modifiers={[font({ size: 14 }), lineLimit(2)]}>
        {detail}
      </Text>,
    ];
    if (props.others) {
      lines.push(
        <Text
          key="others"
          modifiers={[font({ size: 13 }), foregroundStyle({ type: "hierarchical", style: "secondary" }), lineLimit(1)]}
        >
          {props.others}
        </Text>,
      );
    }
    if (props.actions.length > 0) {
      lines.push(
        <HStack key="actions" spacing={8}>
          {props.actions.map((action) => (
            <Button
              key={action.target}
              target={action.target}
              label={action.label}
              modifiers={[
                buttonStyle(action.kind === "approve" ? "borderedProminent" : "bordered"),
                controlSize("small"),
                tint(action.kind === "approve" ? color : action.kind === "stop" ? stop : "gray"),
              ]}
            />
          ))}
        </HStack>,
      );
    }
    return lines;
  };

  return {
    banner: (
      <VStack alignment="leading" spacing={6} modifiers={[padding({ all: 14 }), widgetURL(props.url)]}>
        <HStack spacing={8}>
          <Image systemName={symbol} color={accent} />
          <Text modifiers={[font({ size: 15, weight: "semibold" }), lineLimit(1)]}>{props.title}</Text>
          <Spacer />
          <Text modifiers={[font({ size: 13, weight: "medium" }), foregroundStyle(accent), lineLimit(1)]}>
            {props.badge}
          </Text>
        </HStack>
        {details(accent, dark ? "#ef7b7b" : "#b3261e")}
      </VStack>
    ),
    compactLeading: <Image systemName={symbol} color={islandAccent} />,
    compactTrailing: (
      <Text modifiers={[font({ size: 13, weight: "semibold" }), foregroundStyle(islandAccent), lineLimit(1)]}>
        {props.badge}
      </Text>
    ),
    minimal: <Image systemName={symbol} color={islandAccent} />,
    expandedLeading: <Image systemName={symbol} color={islandAccent} size={22} />,
    expandedCenter: <Text modifiers={[font({ size: 15, weight: "semibold" }), lineLimit(1)]}>{props.title}</Text>,
    expandedTrailing: (
      <Text modifiers={[font({ size: 13, weight: "medium" }), foregroundStyle(islandAccent), lineLimit(1)]}>
        {props.badge}
      </Text>
    ),
    expandedBottom: (
      <VStack alignment="leading" spacing={6} modifiers={[widgetURL(props.url)]}>
        {details(islandAccent, "#ef7b7b")}
      </VStack>
    ),
  };
};

const factory = createLiveActivity<ActivityProps>(NAME, AgentsActivity);

let activityId: string | undefined;
/** The person swiped the activity away; it stays away until no agent needs it. */
let dismissed = false;

export async function showActivity(status: LiveStatus, options: { background: boolean }): Promise<void> {
  if (dismissed) return;
  const props: ActivityProps = {
    title: status.title,
    detail: status.detail,
    badge: status.badge,
    others: status.others ?? "",
    needsYou: status.needsYou,
    url: agentLink(status.threadId),
    actions: status.actions,
  };
  const staleDate = options.background ? new Date(Date.now() + STALE_AFTER_MS) : undefined;
  const running = factory.getInstances();
  // After a relaunch the activity from before is still up; adopt it rather than start a second one.
  const mine = activityId === undefined ? running[0] : running.find((instance) => instance.getId() === activityId);
  if (activityId !== undefined && !mine) {
    dismissed = true;
    return;
  }
  for (const extra of running) {
    if (extra.getId() !== mine?.getId()) void extra.end("immediate").catch(() => {});
  }
  if (mine) {
    activityId = mine.getId();
    await mine.update(props, staleDate);
    return;
  }
  // ActivityKit only starts an activity while the app is on screen.
  if (options.background) return;
  activityId = factory.start(props, props.url, staleDate).getId();
}

export async function hideActivity(): Promise<void> {
  activityId = undefined;
  dismissed = false;
  await Promise.all(factory.getInstances().map((instance) => instance.end("immediate")));
}

export function onActivityAction(listener: (target: string) => void): { remove(): void } {
  return addUserInteractionListener((event) => {
    if (event.source === NAME) listener(event.target);
  });
}
