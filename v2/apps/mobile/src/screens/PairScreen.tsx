import { PAIRING_CODE_PREFIX } from "@zli-v2/remote-protocol";
import { type BarcodeScanningResult, CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PairError, pairingCodeFromLink, pairWithDesktop, previewPairingCode } from "../lib/pairing.js";
import type { StoredPairing } from "../lib/pairingRecord.js";
import { createSocket, defaultDeviceName, random } from "../platform.js";
import { radius, space, type, usePalette } from "../theme.js";
import { Button, Card, Field, Notice, Row, Section } from "../ui/components.js";
import { Icon } from "../ui/Icon.js";
import { ZliLogo } from "../ui/ZliLogo.js";

const STEPS = [
  "Open Settings, then Phone access, in ZLI on your desktop.",
  "Turn on Allow phones on this network.",
  "Choose Pair a new phone, then scan the code it shows.",
] as const;

export function PairScreen({
  notice,
  onPaired,
}: {
  /** Why the phone is back on this screen, such as the desktop removing it. */
  notice?: string | undefined;
  onPaired: (pairing: StoredPairing) => Promise<void>;
}) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [scanHint, setScanHint] = useState<string>();
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const scanned = useRef(false);

  // A pairing code is itself a zli-remote: link, so scanning it with the phone's camera app opens here.
  useEffect(() => {
    const take = (url: string | null | undefined) => {
      const linked = url ? pairingCodeFromLink(url) : undefined;
      if (!linked) return;
      setScanning(false);
      setError(undefined);
      setCode(linked);
    };
    void Linking.getInitialURL().then(take, () => {});
    const subscription = Linking.addEventListener("url", ({ url }) => take(url));
    return () => subscription.remove();
  }, []);

  const preview = code.trim() ? previewPairingCode(code, Date.now()) : undefined;
  const desktopName = preview && "desktopName" in preview ? preview.desktopName : undefined;
  const codeError = preview && "error" in preview ? preview.error : undefined;
  const cameraBlocked = permission !== null && !permission.granted && !permission.canAskAgain;

  const startScan = async () => {
    setError(undefined);
    setScanHint(undefined);
    const current = permission?.granted ? permission : await requestPermission();
    if (!current.granted) return;
    scanned.current = false;
    setScanning(true);
  };

  const onScanned = ({ data }: BarcodeScanningResult) => {
    if (scanned.current) return;
    if (!data.replace(/\s+/gu, "").startsWith(PAIRING_CODE_PREFIX)) {
      setScanHint("That QR code is not a ZLI pairing code. Scan the code in the desktop's Phone access settings.");
      return;
    }
    scanned.current = true;
    setScanning(false);
    setScanHint(undefined);
    setCode(data);
  };

  const pair = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onPaired(await pairWithDesktop(code, deviceName, { random, createSocket, now: Date.now }));
    } catch (cause) {
      setError(
        cause instanceof PairError
          ? cause.message
          : "Pairing did not finish. Make a new code on the desktop and try again.",
      );
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: palette.canvas }}>
      <ScrollView
        contentContainerStyle={[
          local.content,
          { paddingTop: insets.top + space.xxl, paddingBottom: insets.bottom + space.xl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={local.intro}>
          <ZliLogo size={52} />
          <Text accessibilityRole="header" style={[local.heading, { color: palette.text }]}>
            Pair with your desktop
          </Text>
          <Text style={[local.lede, { color: palette.muted }]}>
            Follow your agents, answer their questions, and start new work from this phone.
          </Text>
        </View>

        {notice ? <Notice tone="warning" message={notice} /> : null}

        <Section title="On the desktop">
          {STEPS.map((step, index) => (
            <View key={step} style={local.step} accessible accessibilityLabel={`Step ${index + 1}. ${step}`}>
              <View style={[local.stepNumber, { backgroundColor: palette.raised }]}>
                <Text style={[local.stepDigit, { color: palette.text }]}>{index + 1}</Text>
              </View>
              <Text style={[local.stepText, { color: palette.text }]}>{step}</Text>
            </View>
          ))}
        </Section>

        {scanning ? (
          <Card>
            <View style={[local.camera, { backgroundColor: palette.well }]}>
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={onScanned}
                accessibilityLabel="Camera view for scanning the pairing code"
              />
            </View>
            <Text accessibilityLiveRegion="polite" style={[local.footnote, { color: palette.muted }]}>
              {scanHint ?? "Point the camera at the QR code on the desktop."}
            </Text>
            <Button label="Stop scanning" onPress={() => setScanning(false)} />
          </Card>
        ) : (
          <View style={local.group}>
            <Button
              label="Scan pairing code"
              icon="scan"
              size="lg"
              variant={desktopName ? "secondary" : "primary"}
              onPress={() => void startScan()}
            />
            {cameraBlocked ? (
              <Notice
                tone="warning"
                message="Camera access is off for ZLI Remote. Paste the code below instead, or turn camera access on in Settings."
                action={{ label: "Open Settings", onPress: () => void Linking.openSettings() }}
              />
            ) : null}
          </View>
        )}

        <Field
          label="Or paste the code"
          hint="On the desktop, choose Copy code under the QR code."
          error={codeError}
          value={code}
          onChangeText={setCode}
          placeholder="zli-remote:"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          multiline
          numberOfLines={3}
          monospace
          style={local.codeInput}
        />

        {desktopName ? (
          <Section>
            <Row
              leading={<Icon name="monitor" size={20} color={palette.text} />}
              title={desktopName}
              subtitle="This code pairs with this desktop"
              trailing={<Icon name="check" size={20} color={palette.tones.green.ink} strokeWidth={2.25} />}
            />
          </Section>
        ) : null}

        <Field
          label="Name for this phone"
          hint="The desktop lists paired phones by this name."
          value={deviceName}
          onChangeText={setDeviceName}
          maxLength={60}
          autoCorrect={false}
          returnKeyType="done"
        />

        {error ? <Notice tone="error" message={error} /> : null}

        <Button
          label={desktopName ? `Pair with ${desktopName}` : "Pair"}
          variant="primary"
          size="lg"
          disabled={!desktopName || !deviceName.trim()}
          busy={busy}
          busyLabel="Pairing…"
          {...(desktopName ? {} : { accessibilityHint: "Scan or paste a pairing code first" })}
          onPress={() => void pair()}
        />

        <View style={local.privacy}>
          <Icon name="shieldCheck" size={16} color={palette.muted} />
          <Text style={[local.footnote, local.privacyText, { color: palette.muted }]}>
            The phone and the desktop need to be on the same network. Everything between them is encrypted with keys
            that stay on the two devices.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const local = StyleSheet.create({
  content: { paddingHorizontal: space.lg, gap: space.xl },
  intro: { gap: space.md, paddingHorizontal: space.xs },
  heading: { ...type.largeTitle, fontWeight: "700", letterSpacing: -0.4, marginTop: space.sm },
  lede: { ...type.body },
  group: { gap: space.md },
  step: { flexDirection: "row", alignItems: "flex-start", gap: space.md, padding: space.lg },
  stepNumber: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  stepDigit: { ...type.meta, fontWeight: "700", fontVariant: ["tabular-nums"] },
  stepText: { ...type.body, flex: 1, marginTop: 1 },
  camera: { height: 280, borderRadius: radius.md, overflow: "hidden" },
  codeInput: { minHeight: 88, textAlignVertical: "top" },
  footnote: { ...type.footnote },
  privacy: { flexDirection: "row", gap: space.sm, paddingHorizontal: space.xs },
  privacyText: { flex: 1 },
});
