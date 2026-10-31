import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  KeyboardAvoidingView,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLink, useLinkSnapshot } from "../LinkContext.js";
import { TerminalFeed } from "../lib/terminalFeed.js";
import { terminalStatus } from "../lib/views.js";
import { useNavigation } from "../navigation.js";
import { mono, radius, space, TAP, type, usePalette } from "../theme.js";
import { Button, EmptyState, Header, IconButton, Notice, StatusText, Tappable } from "../ui/components.js";
import { Icon } from "../ui/Icon.js";
import { ConnectionBanner } from "./ConnectionBanner.js";
import { useListActions } from "./ListActions.js";

/** Keys a phone keyboard cannot type, as the bytes a terminal expects. */
const KEYS: { label: string; spoken: string; data: string }[] = [
  { label: "Ctrl+C", spoken: "Control C, interrupts the running command", data: "\u0003" },
  { label: "Tab", spoken: "Tab", data: "\t" },
  { label: "Esc", spoken: "Escape", data: "\u001b" },
  { label: "↑", spoken: "Up arrow", data: "\u001b[A" },
  { label: "↓", spoken: "Down arrow", data: "\u001b[B" },
  { label: "Enter", spoken: "Enter", data: "\r" },
];

export function TerminalScreen({ terminalId }: { terminalId: string }) {
  const navigation = useNavigation();
  const link = useLink();
  const snapshot = useLinkSnapshot();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const [feed] = useState(() => new TerminalFeed(link, terminalId));
  const output = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [focused, setFocused] = useState(false);
  const scroll = useRef<ScrollViewInstance>(null);
  const { stopShell } = useListActions(setError);

  useEffect(() => {
    feed.start();
    return () => feed.stop();
  }, [feed]);

  const terminal = snapshot.projection?.terminals.find((candidate) => candidate.terminalId === terminalId);
  const worktree = snapshot.projection?.worktrees.find((candidate) => candidate.worktreeId === terminal?.worktreeId);
  const online = snapshot.state.kind === "online";
  const exited = output.exited || terminal?.status === "exited" || terminal?.status === "failed";

  const write = async (data: string) => {
    setError(undefined);
    const failure = await feed.write(data);
    if (failure) setError(failure);
    return failure === undefined;
  };

  const sendLine = async () => {
    if (await write(`${draft}\r`)) setDraft("");
  };

  if (snapshot.projection && !terminal) {
    return (
      <View style={[local.screen, { backgroundColor: palette.canvas }]}>
        <Header title="Terminal" onBack={navigation.back} />
        <EmptyState
          icon="terminal"
          title="This terminal is gone"
          message="It was closed on the desktop."
          action={{ label: "Back to the list", onPress: navigation.back }}
        />
      </View>
    );
  }

  const status = terminal ? terminalStatus(terminal) : undefined;

  return (
    <KeyboardAvoidingView behavior="padding" style={[local.screen, { backgroundColor: palette.canvas }]}>
      <Header
        title={terminal?.title || "Terminal"}
        leading={<Icon name="terminal" size={20} color={palette.text} />}
        subtitle={
          <View style={local.subtitle}>
            {status ? <StatusText label={status.label} tone={status.tone} /> : null}
            {worktree ? (
              <Text style={[local.branch, { color: palette.muted }]} numberOfLines={1}>
                {worktree.branch}
              </Text>
            ) : null}
          </View>
        }
        onBack={navigation.back}
        actions={
          terminal && !exited ? (
            <Button
              label="Stop"
              accessibilityLabel={`Stop ${terminal.title || "this shell"}`}
              accessibilityHint="Ends the shell on the desktop"
              variant="quiet"
              disabled={!online}
              onPress={() => stopShell(terminal)}
            />
          ) : undefined
        }
      />
      <ConnectionBanner />
      <ScrollView
        ref={scroll}
        style={[local.output, { backgroundColor: palette.surface }]}
        contentContainerStyle={local.outputContent}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
      >
        {!output.loaded ? (
          <Text style={[local.meta, { color: palette.muted }]}>Loading output…</Text>
        ) : (
          <>
            {output.truncated ? (
              <Text style={[local.meta, { color: palette.muted }]}>Earlier output is on the desktop.</Text>
            ) : null}
            <Text
              selectable
              accessibilityLabel={output.text ? "Terminal output" : "No output yet"}
              style={[local.text, { color: output.text ? palette.text : palette.muted }]}
            >
              {output.text || "No output yet."}
            </Text>
          </>
        )}
      </ScrollView>
      <View style={[local.dock, { paddingBottom: insets.bottom + space.sm }]}>
        {error ? <Notice tone="error" message={error} /> : null}
        {output.error ? <Notice tone="warning" message={output.error} /> : null}
        {exited ? (
          <View style={[local.exited, { backgroundColor: palette.surface }]}>
            <Text style={[local.meta, { color: palette.muted }]}>
              This shell has ended. Open a new one from the list.
            </Text>
          </View>
        ) : (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={local.keys}
            >
              {KEYS.map((key) => (
                <Tappable
                  key={key.label}
                  accessibilityRole="button"
                  accessibilityLabel={key.spoken}
                  accessibilityState={{ disabled: !online }}
                  disabled={!online}
                  onPress={() => void write(key.data)}
                  focusRadius={radius.sm}
                  style={({ pressed }) => [
                    local.key,
                    { backgroundColor: pressed ? palette.overlay : palette.raised, opacity: online ? 1 : 0.45 },
                  ]}
                >
                  <Text style={[local.keyLabel, { color: palette.text }]}>{key.label}</Text>
                </Tappable>
              ))}
            </ScrollView>
            <View
              style={[
                local.composer,
                {
                  backgroundColor: focused ? palette.overlay : palette.raised,
                  borderColor: focused ? palette.accent : palette.border,
                },
              ]}
            >
              <Text style={[local.prompt, { color: palette.muted }]} accessibilityElementsHidden>
                $
              </Text>
              <TextInput
                accessibilityLabel="Command"
                value={draft}
                onChangeText={setDraft}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onSubmitEditing={() => void sendLine()}
                submitBehavior="submit"
                placeholder="Type a command"
                placeholderTextColor={palette.dim}
                selectionColor={palette.accent}
                cursorColor={palette.accent}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                returnKeyType="send"
                style={[local.input, { color: palette.text }]}
              />
              <IconButton
                icon="arrowUp"
                label="Run"
                variant="primary"
                disabled={!online}
                accessibilityHint="Sends the command and Enter"
                onPress={() => void sendLine()}
              />
            </View>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const local = StyleSheet.create({
  screen: { flex: 1 },
  subtitle: { flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 0 },
  branch: { flexShrink: 1, fontFamily: mono, ...type.caption },
  output: { flex: 1, marginHorizontal: space.md, borderRadius: radius.island },
  outputContent: { padding: space.md, gap: space.sm },
  text: { fontFamily: mono, fontSize: 12, lineHeight: 17 },
  meta: { ...type.meta },
  dock: { paddingHorizontal: space.md, paddingTop: space.sm, gap: space.sm },
  keys: { gap: space.sm },
  key: {
    minHeight: TAP,
    minWidth: TAP + 4,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  keyLabel: { fontFamily: mono, ...type.meta, fontWeight: "600" },
  exited: { borderRadius: radius.island, padding: space.lg },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingLeft: space.lg,
    paddingRight: space.xs + 2,
    paddingVertical: space.xs,
    borderRadius: radius.composer + 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  prompt: { fontFamily: mono, ...type.meta, fontWeight: "700" },
  input: { flex: 1, minHeight: TAP, fontFamily: mono, ...type.meta },
});
