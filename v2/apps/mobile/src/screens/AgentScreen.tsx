import type { ThreadMessageProjection } from "@zli-v2/contracts";
import { useMemo, useState } from "react";
import { Alert, FlatList, KeyboardAvoidingView, StyleSheet, Text, TextInput, View } from "react-native";
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
import { radius, space, TAP, type, usePalette } from "../theme.js";
import { Banner, Button, EmptyState, Header, StatusLabel } from "../ui/components.js";
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
          title={projection ? "This agent is gone" : "Loading"}
          busy={!projection}
          message={projection ? "Its session was deleted on the desktop." : undefined}
          action={projection ? { label: "Back to the list", onPress: navigation.back } : undefined}
        />
      </View>
    );
  }

  const name = providerName(thread.provider, projection.providers);
  const branch = projection.worktrees.find((worktree) => worktree.worktreeId === thread.worktreeId)?.branch;
  const status = threadStatus(thread, requests.length);
  const activity = currentActivity(projection, thread);
  const queued = queuedMessages(projection, threadId);
  const online = snapshot.state.kind === "online";
  const ended = thread.status === "stopped" || thread.status === "failed";
  const running = thread.status === "working";

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

  return (
    <KeyboardAvoidingView behavior="padding" style={[local.screen, { backgroundColor: palette.canvas }]}>
      <Header
        title={name}
        subtitle={branch}
        onBack={navigation.back}
        action={
          ended ? undefined : (
            <Button
              label="Stop"
              accessibilityLabel={`Stop ${name}`}
              variant="quiet"
              busy={busy === "stop"}
              disabled={!online}
              onPress={stop}
            />
          )
        }
      />
      <ConnectionBanner />
      <FlatList
        inverted
        data={messages}
        keyExtractor={(message) => message.messageId}
        renderItem={({ item }) => <Message message={item} agentName={name} />}
        contentContainerStyle={local.transcript}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={local.tail}>
            {requests.map(({ request }) => (
              <RequestCard key={request.requestId} request={request} provider={thread.provider} agentName={name} />
            ))}
            {thread.errorMessage ? (
              <Banner tone="error" title="The agent reported an error" message={thread.errorMessage} />
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <Text style={[local.empty, { color: palette.muted }]}>
            No messages yet. Write to {name} below to give it a task.
          </Text>
        }
      />
      <View
        style={[
          local.footer,
          { borderTopColor: palette.border, backgroundColor: palette.surface, paddingBottom: insets.bottom + space.sm },
        ]}
      >
        <View style={local.statusLine}>
          <StatusLabel label={status.label} tone={status.tone} />
          <Text style={[local.meta, local.activity, { color: palette.muted }]} numberOfLines={1}>
            {activity
              ? activity.title
              : queued.length > 0
                ? queued.length === 1
                  ? "1 message waits for this turn to end"
                  : `${queued.length} messages wait for this turn to end`
                : ""}
          </Text>
          {running ? (
            <Button
              label="Interrupt"
              busy={busy === "interrupt"}
              disabled={!online}
              accessibilityHint="Ends the current turn. The agent keeps running."
              onPress={() => void interrupt()}
            />
          ) : null}
        </View>
        {error ? <Banner tone="error" message={error} /> : null}
        {ended ? (
          <Text style={[local.meta, { color: palette.muted }]}>
            {thread.status === "failed"
              ? "This agent failed. Start a new one from the home screen."
              : "This agent stopped. Start a new one from the home screen."}
          </Text>
        ) : (
          <View style={local.composer}>
            <TextInput
              accessibilityLabel={`Message to ${name}`}
              value={draft}
              onChangeText={setDraft}
              placeholder={running ? "Sends when this turn ends" : `Message ${name}`}
              placeholderTextColor={palette.dim}
              selectionColor={palette.accent}
              multiline
              style={[
                local.input,
                { color: palette.text, backgroundColor: palette.well, borderColor: palette.borderStrong },
              ]}
            />
            <Button
              label="Send"
              variant="primary"
              busy={sending}
              disabled={!online || !draft.trim()}
              onPress={() => void send()}
            />
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

function Message({ message, agentName }: { message: ThreadMessageProjection; agentName: string }) {
  const palette = usePalette();
  const mine = message.role === "user";
  const attachments = message.attachments?.length ?? 0;
  const label =
    message.role === "user"
      ? "You"
      : message.role === "assistant"
        ? agentName
        : message.role === "agent"
          ? "Another agent"
          : "System";
  return (
    <View
      style={[
        local.message,
        mine
          ? { alignSelf: "flex-end", backgroundColor: palette.raised, borderColor: palette.border }
          : { alignSelf: "stretch", borderColor: "transparent" },
      ]}
    >
      <Text style={[local.messageLabel, { color: palette.muted }]}>{label}</Text>
      {message.text.trim() ? (
        <Text selectable style={[local.body, { color: message.role === "system" ? palette.muted : palette.text }]}>
          {message.text}
        </Text>
      ) : null}
      {attachments > 0 ? (
        <Text style={[local.meta, { color: palette.dim }]}>
          {attachments === 1
            ? "Includes 1 attachment. See it on the desktop."
            : `Includes ${attachments} attachments. See them on the desktop.`}
        </Text>
      ) : null}
    </View>
  );
}

const local = StyleSheet.create({
  screen: { flex: 1 },
  transcript: { padding: space.lg, gap: space.md, flexGrow: 1 },
  tail: { gap: space.md },
  empty: { fontSize: type.body, lineHeight: 22, textAlign: "center", paddingVertical: space.xl },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    gap: space.sm,
  },
  statusLine: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: TAP },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: space.sm },
  input: {
    flex: 1,
    minHeight: TAP,
    maxHeight: 140,
    paddingHorizontal: space.md,
    paddingTop: 11,
    paddingBottom: 11,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: type.body,
  },
  message: {
    maxWidth: "100%",
    gap: 4,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  messageLabel: { fontSize: type.meta, fontWeight: "600" },
  body: { fontSize: type.body, lineHeight: 22 },
  meta: { fontSize: type.meta, lineHeight: 18 },
  activity: { flex: 1 },
});
