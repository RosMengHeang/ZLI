import { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useConnectionLabel, useLink, useLinkSnapshot } from "../LinkContext.js";
import { unpairFromDesktop } from "../lib/pairing.js";
import { useNavigation } from "../navigation.js";
import { createSocket, random } from "../platform.js";
import { mono, space, type, usePalette } from "../theme.js";
import { Button, Card, Header, SectionTitle } from "../ui/components.js";

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
      "Forget it on this phone anyway? The desktop keeps listing this phone until you revoke it in Mobile access.",
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
      <ScrollView contentContainerStyle={[local.content, { paddingBottom: insets.bottom + space.xl }]}>
        <SectionTitle>Paired desktop</SectionTitle>
        <Card>
          <Detail label="Desktop" value={pairing.desktopName} />
          <Detail label="Status" value={connection} />
          <Detail label="Address" value={address} monospace />
          <Detail label="This phone" value={pairing.deviceName} />
          <Detail label="Paired" value={new Date(pairing.pairedAt).toLocaleDateString()} />
        </Card>
        <Text style={[local.note, { color: palette.muted }]}>
          Each time the phone connects, it learns the desktop's current addresses.
        </Text>

        <SectionTitle>Forget this desktop</SectionTitle>
        <Text style={[local.note, { color: palette.muted }]}>
          Removes the pairing from this phone and asks the desktop to forget the phone too.
        </Text>
        <Button
          label={`Forget ${pairing.desktopName}`}
          variant="danger"
          busy={forgetting}
          busyLabel="Forgetting…"
          onPress={confirmForget}
        />
      </ScrollView>
    </View>
  );
}

function Detail({ label, value, monospace = false }: { label: string; value: string; monospace?: boolean }) {
  const palette = usePalette();
  return (
    <View style={local.detail} accessible accessibilityLabel={`${label}, ${value}`}>
      <Text style={[local.detailLabel, { color: palette.muted }]}>{label}</Text>
      <Text
        style={[
          local.detailValue,
          { color: palette.text },
          monospace ? { fontFamily: mono, fontSize: type.meta } : null,
        ]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

const local = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: space.lg, gap: space.md },
  note: { fontSize: type.meta, lineHeight: 18 },
  detail: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.md },
  detailLabel: { fontSize: type.body },
  detailValue: { flexShrink: 1, fontSize: type.body, fontWeight: "500", textAlign: "right" },
});
