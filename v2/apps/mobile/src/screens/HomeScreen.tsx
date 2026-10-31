import { describeApproval } from "@zli-v2/client-runtime";
import type { RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useConnectionLabel, useLink, useLinkSnapshot } from "../LinkContext.js";
import { sendCommand } from "../lib/launch.js";
import type { LinkSnapshot } from "../lib/link.js";
import {
  type AgentRow,
  newShellCommand,
  type ProjectSection,
  pendingRequests,
  projectSections,
  providerName,
  type Tone,
  terminalStatus,
  type WorktreeSection,
} from "../lib/views.js";
import { useNavigation } from "../navigation.js";
import { newId } from "../platform.js";
import { mono, space, TAP, type, usePalette } from "../theme.js";
import {
  EmptyState,
  Header,
  IconButton,
  Notice,
  Row,
  Section,
  StatusText,
  SwipeRow,
  Tappable,
} from "../ui/components.js";
import { Icon } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { ConnectionBanner } from "./ConnectionBanner.js";
import { useListActions } from "./ListActions.js";

function connectionTone(state: LinkSnapshot["state"]): Tone {
  switch (state.kind) {
    case "online":
      return "green";
    case "offline":
      return "amber";
    case "blocked":
      return "red";
    default:
      return "neutral";
  }
}

export function HomeScreen() {
  const navigation = useNavigation();
  const link = useLink();
  const snapshot = useLinkSnapshot();
  const connection = useConnectionLabel();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { projection, state } = snapshot;
  const desktopName = snapshot.pairing.desktopName;
  const sections = useMemo(() => (projection ? projectSections(projection) : []), [projection]);
  const requests = useMemo(() => pendingRequests(projection), [projection]);
  const online = state.kind === "online";
  const [openingShell, setOpeningShell] = useState<string>();
  const [error, setError] = useState<string>();
  const actions = useListActions(setError);

  const openShell = async (worktree: WorktreeProjection) => {
    setOpeningShell(worktree.worktreeId);
    setError(undefined);
    const terminalId = newId();
    const outcome = await sendCommand(link, newShellCommand(worktree, terminalId), "The shell could not start.");
    setOpeningShell(undefined);
    if (outcome.ok) navigation.push({ name: "terminal", terminalId });
    else setError(outcome.error);
  };

  const canStart = online && (projection?.projects.length ?? 0) > 0;

  return (
    <View style={[local.screen, { backgroundColor: palette.canvas }]}>
      <Header
        large
        title={desktopName}
        subtitle={<StatusText label={connection} tone={connectionTone(state)} />}
        actions={
          <>
            <IconButton icon="settings" label="Settings" onPress={() => navigation.push({ name: "settings" })} />
            <IconButton
              icon="squarePen"
              label="New agent"
              variant="primary"
              disabled={!canStart}
              onPress={() => navigation.push({ name: "start" })}
            />
          </>
        }
      />
      <ConnectionBanner />
      {projection === undefined ? (
        state.kind === "offline" ? (
          <EmptyState
            icon="monitor"
            title={`Could not reach ${desktopName}`}
            message={state.message}
            action={{ label: "Try now", onPress: () => link.retryNow() }}
          />
        ) : (
          <EmptyState busy title={`Loading from ${desktopName}`} />
        )
      ) : (
        <ScrollView contentContainerStyle={[local.content, { paddingBottom: insets.bottom + space.xxl }]}>
          {error ? (
            <Notice tone="error" message={error} action={{ label: "Dismiss", onPress: () => setError(undefined) }} />
          ) : null}

          {requests.length > 0 ? (
            <Section title={requests.length === 1 ? "Needs you" : `Needs you (${requests.length})`}>
              {requests.map(({ request, thread, name }) => (
                <Row
                  key={request.requestId}
                  leading={<ProviderMark provider={thread.provider} size={20} color={palette.text} />}
                  title={request.kind === "approval" ? `${name} asks to continue` : `${name} has a question`}
                  subtitle={branchOf(projection, thread.worktreeId)}
                  subtitleMono
                  detail={
                    request.kind === "approval" ? describeApproval(thread.provider, request.payload).title : undefined
                  }
                  trailing={<StatusText label="Answer" tone="amber" />}
                  chevron
                  accessibilityHint="Opens the agent to answer"
                  onPress={() => navigation.push({ name: "agent", threadId: thread.threadId })}
                />
              ))}
            </Section>
          ) : null}

          {sections.length === 0 ? (
            <EmptyState
              icon="folder"
              title="No projects yet"
              message={`Add a project in ZLI on ${desktopName} and it shows up here.`}
            />
          ) : (
            sections.map((section) => (
              <ProjectBlock
                key={section.project.projectId}
                section={section}
                online={online}
                openingShell={openingShell}
                onOpenShell={(worktree) => void openShell(worktree)}
                actions={actions}
              />
            ))
          )}
        </ScrollView>
      )}
      {actions.sheets}
    </View>
  );
}

type ListActions = ReturnType<typeof useListActions>;

function branchOf(projection: RuntimeProjection, worktreeId: string): string | undefined {
  return projection.worktrees.find((worktree) => worktree.worktreeId === worktreeId)?.branch;
}

function ProjectBlock({
  section,
  online,
  openingShell,
  onOpenShell,
  actions,
}: {
  section: ProjectSection;
  online: boolean;
  openingShell: string | undefined;
  onOpenShell: (worktree: WorktreeProjection) => void;
  actions: ListActions;
}) {
  const navigation = useNavigation();
  const palette = usePalette();
  const active = section.worktrees.filter((entry) => entry.agents.length > 0 || entry.shells.length > 0);
  const start = () => navigation.push({ name: "start", projectId: section.project.projectId });
  const stopped =
    section.stoppedAgents === 0
      ? undefined
      : section.stoppedAgents === 1
        ? "1 stopped agent is not shown."
        : `${section.stoppedAgents} stopped agents are not shown.`;
  return (
    <View style={local.project}>
      <View style={local.projectHead}>
        <Icon name="folder" size={16} color={palette.muted} />
        <Text accessibilityRole="header" style={[local.projectName, { color: palette.muted }]} numberOfLines={1}>
          {section.project.name}
        </Text>
        <Tappable
          accessibilityRole="button"
          accessibilityLabel={`New agent in ${section.project.name}`}
          accessibilityState={{ disabled: !online }}
          disabled={!online}
          onPress={start}
          hitSlop={4}
          focusRadius={TAP / 2}
          style={({ pressed }) => [
            local.projectAction,
            { backgroundColor: pressed ? palette.raised : "transparent", opacity: online ? 1 : 0.45 },
          ]}
        >
          <Icon name="plus" size={16} color={palette.text} />
          <Text style={[local.projectActionLabel, { color: palette.text }]}>New agent</Text>
        </Tappable>
      </View>
      {active.length === 0 ? (
        <Section footer={stopped}>
          <Row
            leading={<Icon name="squarePen" size={20} color={palette.muted} />}
            title="Nothing running"
            subtitle="Start an agent to work in this project"
            chevron
            disabled={!online}
            onPress={start}
          />
        </Section>
      ) : (
        <>
          {active.map((entry) => (
            <WorktreeIsland
              key={entry.worktree.worktreeId}
              entry={entry}
              online={online}
              opening={openingShell === entry.worktree.worktreeId}
              onOpenShell={onOpenShell}
              actions={actions}
            />
          ))}
          {stopped ? <Text style={[local.note, { color: palette.muted }]}>{stopped}</Text> : null}
        </>
      )}
    </View>
  );
}

function WorktreeIsland({
  entry,
  online,
  opening,
  onOpenShell,
  actions,
}: {
  entry: WorktreeSection;
  online: boolean;
  opening: boolean;
  onOpenShell: (worktree: WorktreeProjection) => void;
  actions: ListActions;
}) {
  const snapshot = useLinkSnapshot();
  const navigation = useNavigation();
  const palette = usePalette();
  const { worktree, agents, shells } = entry;
  return (
    <Section>
      <View style={local.branchRow}>
        <Icon name="branch" size={16} color={palette.muted} />
        <Text style={[local.branch, { color: palette.muted }]} numberOfLines={1}>
          {worktree.branch}
        </Text>
        <IconButton
          icon="terminal"
          label={`New shell in ${worktree.branch}`}
          variant="plain"
          busy={opening}
          disabled={!online || worktree.status !== "ready"}
          accessibilityHint="Opens a shell on the desktop"
          onPress={() => onOpenShell(worktree)}
        />
      </View>
      {agents.map((agent) => {
        const provider = providerName(agent.thread.provider, snapshot.projection?.providers);
        return (
          <SwipeRow
            key={agent.thread.threadId}
            actions={online ? actions.agentActions(agent.thread, agent.name, provider) : []}
          >
            <AgentItem
              agent={agent}
              {...(online ? { onLongPress: () => actions.openAgentMenu(agent.thread, agent.name, provider) } : {})}
            />
          </SwipeRow>
        );
      })}
      {shells.map((shell) => {
        const status = terminalStatus(shell);
        return (
          <SwipeRow key={shell.terminalId} actions={online ? actions.shellActions(shell) : []}>
            <Row
              leading={<Icon name="terminal" size={20} color={palette.text} />}
              title={shell.title || "Shell"}
              subtitle="Shell"
              trailing={<StatusText label={status.label} tone={status.tone} />}
              accessibilityLabel={`${shell.title || "Shell"}, shell, ${status.label}`}
              accessibilityHint="Opens the terminal. Hold for more."
              onPress={() => navigation.push({ name: "terminal", terminalId: shell.terminalId })}
              {...(online ? { onLongPress: () => actions.openShellMenu(shell) } : {})}
            />
          </SwipeRow>
        );
      })}
    </Section>
  );
}

function AgentItem({ agent, onLongPress }: { agent: AgentRow; onLongPress?: () => void }) {
  const navigation = useNavigation();
  const palette = usePalette();
  const detail = agent.thread.errorMessage ?? agent.preview ?? "No messages yet";
  return (
    <Row
      leading={<ProviderMark provider={agent.thread.provider} size={20} color={palette.text} />}
      title={agent.name}
      detail={detail}
      trailing={<StatusText label={agent.status.label} tone={agent.status.tone} />}
      accessibilityLabel={`${agent.name}, ${agent.status.label}, ${detail}`}
      accessibilityHint="Opens the conversation. Hold for more."
      onPress={() => navigation.push({ name: "agent", threadId: agent.thread.threadId })}
      onLongPress={onLongPress}
    />
  );
}

const local = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.xl },
  project: { gap: space.sm },
  projectHead: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.xs },
  projectName: { flex: 1, ...type.footnote, fontWeight: "600" },
  projectAction: {
    minHeight: TAP,
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.md,
    borderRadius: TAP / 2,
  },
  projectActionLabel: { ...type.footnote, fontWeight: "600" },
  branchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingLeft: space.lg,
    paddingRight: space.xs,
    minHeight: TAP + space.xs,
  },
  branch: { flex: 1, ...type.meta, fontFamily: mono },
  note: { ...type.meta, paddingHorizontal: space.xs },
});
