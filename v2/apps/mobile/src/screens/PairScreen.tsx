import { type BarcodeScanningResult, CameraView, useCameraPermissions } from "expo-camera";
import { PAIRING_CODE_PREFIX } from "@zli-v2/remote-protocol";
import { useRef, useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PairError, pairWithDesktop, previewPairingCode } from "../lib/pairing.js";
import type { StoredPairing } from "../lib/pairingRecord.js";
import { createSocket, defaultDeviceName, random } from "../platform.js";
import { radius, space, type, usePalette } from "../theme.js";
import { Banner, Button, Card, Field } from "../ui/components.js";

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

  const preview = code.trim() ? previewPairingCode(code, Date.now()) : undefined;
  const desktopName = preview && "desktopName" in preview ? preview.desktopName : undefined;
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
      setScanHint("That QR code is not a ZLI pairing code. Scan the code in the desktop's Mobile access settings.");
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
    <ScrollView
      style={{ backgroundColor: palette.canvas }}
      contentContainerStyle={[
        local.content,
        { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.xl },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={local.intro}>
        <Text accessibilityRole="header" style={[local.heading, { color: palette.text }]}>
          Pair with ZLI on your desktop
        </Text>
        <Text style={[local.body, { color: palette.muted }]}>
          On the desktop, open Settings, then Mobile access. Turn on Allow phones on this network, then choose Pair a
          new phone.
        </Text>
      </View>

      {notice ? <Banner tone="warning" message={notice} /> : null}

      <Card>
        {scanning ? (
          <>
            <View style={[local.camera, { borderColor: palette.borderStrong }]}>
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={onScanned}
                accessibilityLabel="Camera view for scanning the pairing code"
              />
            </View>
            <Text accessibilityLiveRegion="polite" style={[local.body, { color: palette.muted }]}>
              {scanHint ?? "Point the camera at the QR code on the desktop."}
            </Text>
            <Button label="Stop scanning" onPress={() => setScanning(false)} />
          </>
        ) : (
          <>
            <Button label="Scan the QR code" variant="primary" onPress={() => void startScan()} />
            {cameraBlocked ? (
              <Banner
                tone="warning"
                message="Camera access is off for ZLI Remote. Paste the code below instead, or turn camera access on in Settings."
                action={{ label: "Open Settings", onPress: () => void Linking.openSettings() }}
              />
            ) : null}
          </>
        )}
      </Card>

      <Field
        label="Or paste the pairing code"
        hint="Use Copy code under the QR code on the desktop, then paste it here."
        error={preview && "error" in preview ? preview.error : undefined}
        value={code}
        onChangeText={setCode}
        placeholder="zli-remote:…"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        multiline
        monospace
        style={local.codeInput}
      />

      {desktopName ? (
        <Text style={[local.body, { color: palette.text }]} accessibilityLiveRegion="polite">
          This code pairs with <Text style={local.strong}>{desktopName}</Text>.
        </Text>
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

      {error ? <Banner tone="error" message={error} /> : null}

      <Button
        label={desktopName ? `Pair with ${desktopName}` : "Pair"}
        variant="primary"
        disabled={!desktopName || !deviceName.trim()}
        busy={busy}
        busyLabel="Pairing…"
        onPress={() => void pair()}
      />

      <Text style={[local.footnote, { color: palette.dim }]}>
        The phone and the desktop need to be on the same network. Everything between them is encrypted with keys that
        stay on the two devices.
      </Text>
    </ScrollView>
  );
}

const local = StyleSheet.create({
  content: { paddingHorizontal: space.lg, gap: space.lg },
  intro: { gap: space.sm },
  heading: { fontSize: type.heading, fontWeight: "700" },
  body: { fontSize: type.body, lineHeight: 22 },
  strong: { fontWeight: "600" },
  camera: {
    height: 280,
    borderRadius: radius.md,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
  },
  codeInput: { minHeight: 88, textAlignVertical: "top" },
  footnote: { fontSize: type.meta, lineHeight: 18 },
});
