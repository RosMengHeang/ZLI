import type { ThreadMessageProjection } from "@zli-v2/contracts";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLink, useLinkSnapshot } from "../LinkContext.js";
import { sendCommand } from "../lib/launch.js";
import {
  currentActivity,
  pendingRequests,
  providerName,
  queuedMessages,
  threadMessages,
  threadStatus,
} from "../lib/views.js";
import { useNavigation } from "../navigation.js";
import { newId } from "../platform.js";
import { mono, radius, space, TAP, type, usePalette } from "../theme.js";
import { Button, EmptyState, Header, IconButton, Notice, StatusText, StopButton } from "../ui/components.js";
import { Icon } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";
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
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState<"interrupt" | "stop">();
  const [error, setError] = useState<string>();
  const [focused, setFocused] = useState(false);

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

  const name = providerName(thread.provider, projection.providers);
  const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === thread.worktreeId);
  const status = threadStatus(thread, requests.length);
  const activity = currentActivity(projection, thread);
  const queued = queuedMessages(projection, threadId);
  const online = snapshot.state.kind === "online";
  const ended = thread.status === "stopped" || thread.status === "failed";
  const running = thread.status === "working";
  const canSend = online && draft.trim().length > 0 && !sending;

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    setError(undefined);
    const outcome = await sendCommand(
      link,
      { type: "thread.queue", threadId, queueId: newId(), text },
      "The message did not reach the desktop.",
    );
    setSending(false);
    if (outcome.ok) setDraft("");
    else setError(outcome.error);
  };

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

  const waitingLine = activity
    ? activity.title
    : running
      ? `${name} is working`
      : queued.length === 1
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
      {waitingLine ? (
        <View style={local.activity} accessibilityLiveRegion="polite">
          {running ? <ActivityIndicator size="small" color={palette.tones.blue.ink} /> : null}
          <Text style={[local.activityText, { color: palette.muted }]} numberOfLines={2}>
            {waitingLine}
          </Text>
        </View>
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
              variant="quiet"
              busy={busy === "stop"}
              disabled={!online}
              onPress={stop}
            />
          )
        }
      />
      <ConnectionBanner />
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
          <View
            style={[
              local.composer,
              {
                backgroundColor: focused ? palette.overlay : palette.raised,
                borderColor: focused ? palette.accent : palette.border,
              },
            ]}
          >
            <TextInput
              accessibilityLabel={`Message to ${name}`}
              value={draft}
              onChangeText={setDraft}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={running ? "Sends when this turn ends" : `Message ${name}`}
              placeholderTextColor={palette.dim}
              selectionColor={palette.accent}
              cursorColor={palette.accent}
              multiline
              style={[local.input, { color: palette.text }]}
            />
            <View style={local.composerActions}>
              {running ? (
                <StopButton
                  label="Interrupt this turn"
                  running={running}
                  stopping={busy === "interrupt"}
                  disabled={!online}
                  onPress={() => void interrupt()}
                />
              ) : null}
              <IconButton
                icon="arrowUp"
                label={running ? "Queue message" : "Send"}
                variant="primary"
                busy={sending}
                disabled={!canSend}
                onPress={() => void send()}
              />
            </View>
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

function Message({ message }: { message: ThreadMessageProjection }) {
  const palette = usePalette();
  const attachments = message.attachments?.length ?? 0;
  const note =
    attachments === 0
      ? undefined
      : attachments === 1
        ? "Includes 1 attachment. See it on the desktop."
        : `Includes ${attachments} attachments. See them on the desktop.`;
  const text = message.text.trim() ? message.text : undefined;

  if (message.role === "user") {
    return (
      <View style={[local.bubble, { backgroundColor: palette.raised }]}>
        {text ? (
          <Text selectable style={[local.body, { color: palette.text }]}>
            {text}
          </Text>
        ) : null}
        {note ? <Text style={[local.meta, { color: palette.muted }]}>{note}</Text> : null}
      </View>
    );
  }

  if (message.role === "system") {
    return (
      <View style={local.system}>
        <Icon name="alert" size={14} color={palette.muted} />
        <Text selectable style={[local.meta, local.systemText, { color: palette.muted }]}>
          {text ?? note}
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
      {note ? <Text style={[local.meta, { color: palette.muted }]}>{note}</Text> : null}
    </View>
  );
}

const local = StyleSheet.create({
  screen: { flex: 1 },
  subtitle: { flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 0 },
  branch: { flexShrink: 1, fontFamily: mono, ...type.caption },
  transcript: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.lg, flexGrow: 1 },
  tail: { gap: space.md },
  activity: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 24 },
  activityText: { ...type.footnote, flex: 1 },
  dock: { paddingHorizontal: space.md, paddingTop: space.xs, gap: space.sm },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.xs,
    paddingLeft: space.lg,
    paddingRight: space.xs + 2,
    paddingVertical: space.xs + 2,
    borderRadius: radius.composer + 4,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  input: {
    flex: 1,
    minHeight: TAP,
    maxHeight: 160,
    paddingTop: 11,
    paddingBottom: 11,
    ...type.body,
  },
  composerActions: { flexDirection: "row", alignItems: "center", gap: space.xs },
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
});
