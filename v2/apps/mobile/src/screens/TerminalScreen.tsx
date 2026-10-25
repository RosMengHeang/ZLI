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
import { Banner, Button, EmptyState, Header, StatusLabel } from "../ui/components.js";
import { ConnectionBanner } from "./ConnectionBanner.js";

/** Keys a phone keyboard cannot type, as the bytes a terminal expects. */
const KEYS: { label: string; spoken: string; data: string }[] = [
  { label: "Enter", spoken: "Enter", data: "\r" },
  { label: "Ctrl+C", spoken: "Control C, interrupts the running command", data: "\u0003" },
  { label: "Tab", spoken: "Tab", data: "\t" },
  { label: "Esc", spoken: "Escape", data: "\u001b" },
  { label: "↑", spoken: "Up arrow", data: "\u001b[A" },
  { label: "↓", spoken: "Down arrow", data: "\u001b[B" },
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
  const scroll = useRef<ScrollViewInstance>(null);

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
      <Header title={terminal?.title || "Terminal"} subtitle={worktree?.branch} onBack={navigation.back} />
      <ConnectionBanner />
      <ScrollView
        ref={scroll}
        style={[local.output, { backgroundColor: palette.surface, borderColor: palette.border }]}
        contentContainerStyle={local.outputContent}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
      >
        {!output.loaded ? (
          <Text style={[local.meta, { color: palette.muted }]}>Loading output…</Text>
        ) : (
          <>
            {output.truncated ? (
              <Text style={[local.meta, { color: palette.dim }]}>Earlier output is on the desktop.</Text>
            ) : null}
            <Text
              selectable
              accessibilityLabel={output.text ? "Terminal output" : "No output yet"}
              style={[local.text, { color: palette.text }]}
            >
              {output.text || "No output yet."}
            </Text>
          </>
        )}
      </ScrollView>
      <View
        style={[
          local.footer,
          { borderTopColor: palette.border, backgroundColor: palette.surface, paddingBottom: insets.bottom + space.sm },
        ]}
      >
        {error ? <Banner tone="error" message={error} /> : null}
        {output.error ? <Banner tone="warning" message={output.error} /> : null}
        {exited ? (
          <View style={local.exited}>
            {status ? <StatusLabel label={status.label} tone={status.tone} /> : null}
            <Text style={[local.meta, { color: palette.muted }]}>
              This shell has ended. Open a new one from the list.
            </Text>
          </View>
        ) : (
          <>
            <ScrollView horizontal keyboardShouldPersistTaps="handled" contentContainerStyle={local.keys}>
              {KEYS.map((key) => (
                <View key={key.label}>
                  <Button
                    label={key.label}
                    disabled={!online}
                    accessibilityLabel={key.spoken}
                    onPress={() => void write(key.data)}
                  />
                </View>
              ))}
            </ScrollView>
            <View style={local.composer}>
              <TextInput
                accessibilityLabel="Command"
                value={draft}
                onChangeText={setDraft}
                onSubmitEditing={() => void sendLine()}
                submitBehavior="submit"
                placeholder="Type a command"
                placeholderTextColor={palette.dim}
                selectionColor={palette.accent}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                returnKeyType="send"
                style={[
                  local.input,
                  { color: palette.text, backgroundColor: palette.well, borderColor: palette.borderStrong },
                ]}
              />
              <Button label="Run" variant="primary" disabled={!online} onPress={() => void sendLine()} />
            </View>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const local = StyleSheet.create({
  screen: { flex: 1 },
  output: { flex: 1, margin: space.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  outputContent: { padding: space.md, gap: space.sm },
  text: { fontFamily: mono, fontSize: 12, lineHeight: 17 },
  meta: { fontSize: type.meta, lineHeight: 18 },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    gap: space.sm,
  },
  keys: { gap: space.sm },
  exited: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: TAP },
  composer: { flexDirection: "row", alignItems: "center", gap: space.sm },
  input: {
    flex: 1,
    minHeight: TAP,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    fontFamily: mono,
    fontSize: type.meta,
  },
});
