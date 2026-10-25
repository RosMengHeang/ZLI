import { describeApproval } from "@zli-v2/client-runtime";
import type { RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useConnectionLabel, useLink, useLinkSnapshot } from "../LinkContext.js";
import { sendCommand } from "../lib/launch.js";
import {
  newShellCommand,
  pendingRequests,
  type ProjectSection,
  projectSections,
  terminalStatus,
} from "../lib/views.js";
import { useNavigation } from "../navigation.js";
import { newId } from "../platform.js";
import { mono, space, type, usePalette } from "../theme.js";
import { Banner, Button, EmptyState, Header, Row, SectionTitle } from "../ui/components.js";
import { ConnectionBanner } from "./ConnectionBanner.js";

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

  const openShell = async (worktree: WorktreeProjection) => {
    setOpeningShell(worktree.worktreeId);
    setError(undefined);
    const terminalId = newId();
    const outcome = await sendCommand(link, newShellCommand(worktree, terminalId), "The shell could not start.");
    setOpeningShell(undefined);
    if (outcome.ok) navigation.push({ name: "terminal", terminalId });
    else setError(outcome.error);
  };

  return (
    <View style={[local.screen, { backgroundColor: palette.canvas }]}>
      <Header
        title={desktopName}
        subtitle={connection}
        action={<Button label="Settings" variant="quiet" onPress={() => navigation.push({ name: "settings" })} />}
      />
      <ConnectionBanner />
      {projection === undefined ? (
        state.kind === "offline" ? (
          <EmptyState
            title={`Could not reach ${desktopName}`}
            message={state.message}
            action={{ label: "Try now", onPress: () => link.retryNow() }}
          />
        ) : (
          <EmptyState busy title={`Loading from ${desktopName}`} />
        )
      ) : (
        <ScrollView contentContainerStyle={[local.content, { paddingBottom: insets.bottom + space.xl }]}>
          {error ? (
            <Banner tone="error" message={error} action={{ label: "Dismiss", onPress: () => setError(undefined) }} />
          ) : null}
          <Button
            label="Start an agent"
            variant="primary"
            disabled={!online || projection.projects.length === 0}
            onPress={() => navigation.push({ name: "start" })}
          />

          {requests.length > 0 ? (
            <View style={local.group}>
              <SectionTitle>Needs you</SectionTitle>
              {requests.map(({ request, thread, name }) => (
                <Row
                  key={request.requestId}
                  title={request.kind === "approval" ? `${name} asks to continue` : `${name} has a question`}
                  subtitle={branchOf(projection, thread.worktreeId)}
                  detail={
                    request.kind === "approval" ? describeApproval(thread.provider, request.payload).title : undefined
                  }
                  status={{ label: "Needs you", tone: "amber" }}
                  accessibilityHint="Opens the agent to answer"
                  onPress={() => navigation.push({ name: "agent", threadId: thread.threadId })}
                />
              ))}
            </View>
          ) : null}

          {sections.length === 0 ? (
            <EmptyState title="No projects yet" message="Add a project in ZLI on the desktop and it shows up here." />
          ) : (
            sections.map((section) => (
              <ProjectBlock
                key={section.project.projectId}
                section={section}
                online={online}
                openingShell={openingShell}
                onOpenShell={(worktree) => void openShell(worktree)}
              />
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
}

function branchOf(projection: RuntimeProjection, worktreeId: string): string | undefined {
  return projection.worktrees.find((worktree) => worktree.worktreeId === worktreeId)?.branch;
}

function ProjectBlock({
  section,
  online,
  openingShell,
  onOpenShell,
}: {
  section: ProjectSection;
  online: boolean;
  openingShell: string | undefined;
  onOpenShell: (worktree: WorktreeProjection) => void;
}) {
  const navigation = useNavigation();
  const palette = usePalette();
  const active = section.worktrees.filter((entry) => entry.agents.length > 0 || entry.shells.length > 0);
  return (
    <View style={local.group}>
      <SectionTitle
        aside={
          <Button
            label="Start agent"
            variant="quiet"
            disabled={!online}
            accessibilityHint={`Starts an agent in ${section.project.name}`}
            onPress={() => navigation.push({ name: "start", projectId: section.project.projectId })}
          />
        }
      >
        {section.project.name}
      </SectionTitle>
      {active.length === 0 ? (
        <Text style={[local.note, { color: palette.muted }]}>No agents or shells running.</Text>
      ) : null}
      {active.map(({ worktree, agents, shells }) => (
        <View key={worktree.worktreeId} style={local.worktree}>
          <View style={local.worktreeHead}>
            <Text style={[local.branch, { color: palette.muted }]} numberOfLines={1}>
              {worktree.branch}
            </Text>
            <Button
              label="New shell"
              variant="quiet"
              disabled={!online || worktree.status !== "ready"}
              busy={openingShell === worktree.worktreeId}
              accessibilityHint={`Opens a shell on the desktop in ${worktree.branch}`}
              onPress={() => onOpenShell(worktree)}
            />
          </View>
          {agents.map((agent) => (
            <Row
              key={agent.thread.threadId}
              title={agent.name}
              status={agent.status}
              detail={agent.thread.errorMessage ?? agent.preview}
              accessibilityHint="Opens the conversation"
              onPress={() => navigation.push({ name: "agent", threadId: agent.thread.threadId })}
            />
          ))}
          {shells.map((shell) => (
            <Row
              key={shell.terminalId}
              title={shell.title || "Shell"}
              subtitle="Shell"
              status={terminalStatus(shell)}
              accessibilityHint="Opens the terminal"
              onPress={() => navigation.push({ name: "terminal", terminalId: shell.terminalId })}
            />
          ))}
        </View>
      ))}
      {section.stoppedAgents > 0 ? (
        <Text style={[local.note, { color: palette.dim }]}>
          {section.stoppedAgents === 1
            ? "1 stopped agent is not shown."
            : `${section.stoppedAgents} stopped agents are not shown.`}
        </Text>
      ) : null}
    </View>
  );
}

const local = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: space.lg, gap: space.md },
  group: { gap: space.sm },
  worktree: { gap: space.sm },
  worktreeHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  branch: { flex: 1, fontFamily: mono, fontSize: type.meta },
  note: { fontSize: type.meta, lineHeight: 18 },
});
