import { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useConnectionLabel, useLink, useLinkSnapshot } from "../LinkContext.js";
import { unpairFromDesktop } from "../lib/pairing.js";
import { useNavigation } from "../navigation.js";
import { createSocket, random } from "../platform.js";
import { mono, space, type, usePalette } from "../theme.js";
import { Header, Row, Section, StatusText } from "../ui/components.js";
import { Icon } from "../ui/Icon.js";

export function SettingsScreen({ onForget }: { onForget: () => Promise<void> }) {
  const navigation = useNavigation();
  const link = useLink();
  const snapshot = useLinkSnapshot();
  const connection = useConnectionLabel();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const [forgetting, setForgetting] = useState(false);
  const { pairing } = snapshot;
  const address = `${pairing.lastHost ?? pairing.hosts[0] ?? ""}:${pairing.port}`;
  const online = snapshot.state.kind === "online";

  const forget = async () => {
    setForgetting(true);
    link.pause();
    const reached = await unpairFromDesktop(pairing, { random, createSocket });
    if (reached) {
      await onForget();
      return;
    }
    Alert.alert(
      `${pairing.desktopName} could not be reached`,
      "Forget it on this phone anyway? The desktop keeps listing this phone until you revoke it in Phone access.",
      [
        {
          text: "Keep pairing",
          style: "cancel",
          onPress: () => {
            setForgetting(false);
            link.start();
          },
        },
        { text: "Forget anyway", style: "destructive", onPress: () => void onForget() },
      ],
    );
  };

  const confirmForget = () => {
    Alert.alert(
      `Forget ${pairing.desktopName}?`,
      "This phone stops connecting, and the desktop removes it from its paired phones. Pairing again needs a new code.",
      [
        { text: "Keep pairing", style: "cancel" },
        { text: "Forget", style: "destructive", onPress: () => void forget() },
      ],
    );
  };

  return (
    <View style={[local.screen, { backgroundColor: palette.canvas }]}>
      <Header title="Settings" onBack={navigation.back} />
      <ScrollView contentContainerStyle={[local.content, { paddingBottom: insets.bottom + space.xxl }]}>
        <Section
          title="Paired desktop"
          footer="Each time the phone connects, it learns the desktop's current addresses."
        >
          <Row
            leading={<Icon name="monitor" size={20} color={palette.text} />}
            title={pairing.desktopName}
            trailing={<StatusText label={connection} tone={online ? "green" : "neutral"} />}
            accessibilityLabel={`${pairing.desktopName}, ${connection}`}
          />
          <Value label="Address" value={address} monospace />
          <Value label="Paired on" value={new Date(pairing.pairedAt).toLocaleDateString()} />
        </Section>

        <Section title="This phone">
          <Row
            leading={<Icon name="smartphone" size={20} color={palette.text} />}
            title={pairing.deviceName}
            subtitle="The desktop lists this phone by this name"
          />
        </Section>

        <Section footer="Removes the pairing from this phone and asks the desktop to forget the phone too.">
          <Row
            title={forgetting ? "Forgetting…" : `Forget ${pairing.desktopName}`}
            tone="danger"
            disabled={forgetting}
            accessibilityLabel={`Forget ${pairing.desktopName}`}
            onPress={confirmForget}
          />
        </Section>
      </ScrollView>
    </View>
  );
}

function Value({ label, value, monospace = false }: { label: string; value: string; monospace?: boolean }) {
  const palette = usePalette();
  return (
    <View style={local.value} accessible accessibilityLabel={`${label}, ${value}`}>
      <Text style={[local.valueLabel, { color: palette.text }]}>{label}</Text>
      <Text
        selectable
        style={[local.valueText, { color: palette.muted }, monospace ? local.mono : null]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

const local = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.xl },
  value: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    paddingHorizontal: space.lg,
  },
  valueLabel: { ...type.body },
  valueText: { ...type.body, flexShrink: 1, textAlign: "right" },
  mono: { fontFamily: mono, ...type.meta },
});
