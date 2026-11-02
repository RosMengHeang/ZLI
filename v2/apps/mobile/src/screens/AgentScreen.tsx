import type { ThreadMessageProjection } from "@zli-v2/contracts";
import { useEffect, useMemo, useState } from "react";
import { Alert, FlatList, KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLink, useLinkSnapshot } from "../LinkContext.js";
import { sendCommand } from "../lib/launch.js";
import {
  agentTitle,
  currentActivity,
  pendingRequests,
  queuedMessages,
  threadMessages,
  threadStatus,
} from "../lib/views.js";
import { useNavigation } from "../navigation.js";
import { mono, radius, space, type, usePalette } from "../theme.js";
import { Button, EmptyState, Header, Notice, ShimmerText, StatusText } from "../ui/components.js";
import { Icon } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { ChangesEntry } from "./ChangesScreen.js";
import { Composer } from "./Composer.js";
import { ConnectionBanner } from "./ConnectionBanner.js";
import { RequestCard } from "./RequestCard.js";

export function AgentScreen({ threadId }: { threadId: string }) {
  const navigation = useNavigation();
  const link = useLink();
  const snapshot = useLinkSnapshot();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const projection = snapshot.projection;
  const thread = projection?.threads.find((candidate) => candidate.threadId === threadId);
  const [busy, setBusy] = useState<"interrupt" | "stop">();
  const [error, setError] = useState<string>();

  const messages = useMemo(
    () => (projection ? [...threadMessages(projection, threadId)].reverse() : []),
    [projection, threadId],
  );
  const requests = useMemo(() => pendingRequests(projection, threadId), [projection, threadId]);

  if (!projection || !thread) {
    return (
      <View style={[local.screen, { backgroundColor: palette.canvas }]}>
        <Header title="Agent" onBack={navigation.back} />
        <EmptyState
          {...(projection ? { icon: "message" as const } : {})}
          title={projection ? "This agent is gone" : "Loading the conversation"}
          busy={!projection}
          message={projection ? "Its session was deleted on the desktop." : undefined}
          action={projection ? { label: "Back to the list", onPress: navigation.back } : undefined}
        />
      </View>
    );
  }

  const name = agentTitle(thread, projection.providers);
  const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === thread.worktreeId);
  const hasGit = projection.projects.some(
    (project) => project.projectId === worktree?.projectId && project.git !== false,
  );
  const status = threadStatus(thread, requests.length);
  const activity = currentActivity(projection, thread);
  const queued = queuedMessages(projection, threadId);
  const online = snapshot.state.kind === "online";
  const ended = thread.status === "stopped" || thread.status === "failed";
  const running = thread.status === "working";

  const interrupt = async () => {
    setBusy("interrupt");
    setError(undefined);
    const outcome = await sendCommand(
      link,
      { type: "thread.interrupt", threadId, ...(thread.activeTurnId ? { turnId: thread.activeTurnId } : {}) },
      "The agent could not be interrupted.",
    );
    setBusy(undefined);
    if (!outcome.ok) setError(outcome.error);
  };

  const stop = () => {
    Alert.alert(`Stop ${name}?`, "The agent's process ends on the desktop. The conversation stays.", [
      { text: "Keep running", style: "cancel" },
      {
        text: "Stop agent",
        style: "destructive",
        onPress: async () => {
          setBusy("stop");
          setError(undefined);
          const outcome = await sendCommand(link, { type: "thread.stop", threadId }, "The agent could not be stopped.");
          setBusy(undefined);
          if (!outcome.ok) setError(outcome.error);
        },
      },
    ]);
  };

  const queuedLine =
    queued.length === 1
      ? "1 message waits for this turn to end"
      : queued.length > 1
        ? `${queued.length} messages wait for this turn to end`
        : undefined;

  const tail = (
    <View style={local.tail}>
      {requests.map(({ request }) => (
        <RequestCard key={request.requestId} request={request} provider={thread.provider} agentName={name} />
      ))}
      {thread.errorMessage ? (
        <Notice tone="error" title="The agent reported an error" message={thread.errorMessage} />
      ) : null}
      {running ? <WorkingStatus key={thread.activeTurnId ?? "turn"} label={activity?.title ?? "Thinking"} /> : null}
      {queuedLine ? (
        <Text style={[local.queued, { color: palette.muted }]} accessibilityLiveRegion="polite">
          {queuedLine}
        </Text>
      ) : null}
    </View>
  );

  return (
    <KeyboardAvoidingView behavior="padding" style={[local.screen, { backgroundColor: palette.canvas }]}>
      <Header
        title={name}
        leading={<ProviderMark provider={thread.provider} size={22} color={palette.text} />}
        subtitle={
          <View style={local.subtitle}>
            <StatusText label={status.label} tone={status.tone} />
            {worktree ? (
              <Text style={[local.branch, { color: palette.muted }]} numberOfLines={1}>
                {worktree.branch}
              </Text>
            ) : null}
          </View>
        }
        onBack={navigation.back}
        actions={
          ended ? undefined : (
            <Button
              label="Stop"
              accessibilityLabel={`Stop ${name}`}
              accessibilityHint="Ends the agent's process on the desktop"
              variant="danger"
              icon="square"
              busy={busy === "stop"}
              disabled={!online}
              onPress={stop}
            />
          )
        }
      />
      <ConnectionBanner />
      {worktree?.status === "ready" && hasGit ? <ChangesEntry worktreeId={worktree.worktreeId} /> : null}
      {messages.length === 0 ? (
        <ScrollView contentContainerStyle={local.transcript} keyboardShouldPersistTaps="handled">
          <EmptyState
            icon="message"
            title={`Give ${name} a task`}
            message={ended ? "This conversation has no messages." : "Write below. The agent works on the desktop."}
          />
          {tail}
        </ScrollView>
      ) : (
        <FlatList
          inverted
          data={messages}
          keyExtractor={(message) => message.messageId}
          renderItem={({ item }) => <Message message={item} />}
          contentContainerStyle={local.transcript}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={tail}
        />
      )}
      <View style={[local.dock, { paddingBottom: insets.bottom + space.sm }]}>
        {error ? <Notice tone="error" message={error} /> : null}
        {ended ? (
          <View style={[local.ended, { backgroundColor: palette.surface }]}>
            <Text style={[local.endedText, { color: palette.muted }]}>
              {thread.status === "failed" ? "This agent failed." : "This agent stopped."} Start a new one to keep
              working.
            </Text>
            <Button
              label="New agent"
              icon="squarePen"
              variant="primary"
              disabled={!online}
              onPress={() =>
                navigation.replace({ name: "start", ...(worktree ? { projectId: worktree.projectId } : {}) })
              }
            />
          </View>
        ) : (
          <Composer
            thread={thread}
            name={name}
            provider={projection.providers?.find((entry) => entry.provider === thread.provider)}
            hasMessages={messages.length > 0}
            online={online}
            running={running}
            interrupting={busy === "interrupt"}
            onInterrupt={() => void interrupt()}
            onError={setError}
          />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

/** Mounted for one turn, so the time counts from when the phone saw the turn start, as on the desktop. */
function WorkingStatus({ label }: { label: string }) {
  const palette = usePalette();
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <View style={local.working} accessibilityLiveRegion="polite">
      <ShimmerText text={label} style={local.workingLabel} />
      <Text style={[local.workingTime, { color: palette.dim }]} accessibilityElementsHidden>
        {`· ${elapsedLabel(now - startedAt)}`}
      </Text>
    </View>
  );
}

function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function Message({ message }: { message: ThreadMessageProjection }) {
  const palette = usePalette();
  const attachments = message.attachments ?? [];
  const note =
    attachments.length === 0 ? undefined : (
      <View style={local.attachments}>
        {attachments.map((attachment, index) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: two attachments can share a name, and the list never reorders.
            key={index}
            style={[local.attachment, { backgroundColor: palette.overlay }]}
          >
            <Icon name={attachment.mimeType.startsWith("image/") ? "image" : "copy"} size={14} color={palette.muted} />
            <Text style={[local.attachmentName, { color: palette.muted }]} numberOfLines={1}>
              {attachment.name}
            </Text>
          </View>
        ))}
      </View>
    );
  const text = message.text.trim() ? message.text : undefined;

  if (message.role === "user") {
    return (
      <View style={[local.bubble, { backgroundColor: palette.raised }]}>
        {text ? (
          <Text selectable style={[local.body, { color: palette.text }]}>
            {text}
          </Text>
        ) : null}
        {note}
      </View>
    );
  }

  if (message.role === "system") {
    return (
      <View style={local.system}>
        <Icon name="alert" size={14} color={palette.muted} />
        <Text selectable style={[local.meta, local.systemText, { color: palette.muted }]}>
          {text ?? "Attached files."}
        </Text>
      </View>
    );
  }

  return (
    <View style={local.reply}>
      {message.role === "agent" ? (
        <Text style={[local.meta, local.from, { color: palette.muted }]}>From another agent</Text>
      ) : null}
      {text ? (
        <Text selectable style={[local.body, { color: palette.text }]}>
          {text}
        </Text>
      ) : null}
      {note}
    </View>
  );
}

const local = StyleSheet.create({
  screen: { flex: 1 },
  subtitle: { flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 0 },
  branch: { flexShrink: 1, fontFamily: mono, ...type.caption },
  transcript: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.lg, flexGrow: 1 },
  tail: { gap: space.md },
  working: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 24 },
  workingLabel: { ...type.footnote },
  workingTime: { ...type.footnote, fontVariant: ["tabular-nums"] },
  queued: { ...type.footnote },
  dock: { paddingHorizontal: space.md, paddingTop: space.xs, gap: space.sm },
  ended: { borderRadius: radius.island, padding: space.lg, gap: space.md },
  endedText: { ...type.footnote },
  bubble: {
    alignSelf: "flex-end",
    maxWidth: "86%",
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingVertical: space.md - 2,
    borderRadius: 20,
    borderBottomRightRadius: 6,
  },
  reply: { alignSelf: "stretch", gap: space.xs },
  from: { fontWeight: "600" },
  system: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingHorizontal: space.xs },
  systemText: { flex: 1 },
  body: { ...type.body },
  meta: { ...type.meta },
  attachments: { flexDirection: "row", flexWrap: "wrap", gap: space.xs + 2 },
  attachment: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs + 2,
    maxWidth: "100%",
    paddingHorizontal: space.sm + 2,
    paddingVertical: space.xs + 2,
    borderRadius: radius.sm,
  },
  attachmentName: { ...type.caption, flexShrink: 1 },
});
