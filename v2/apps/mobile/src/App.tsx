import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { LinkProvider } from "./LinkContext.js";
import { Navigator } from "./Navigator.js";
import { PairError } from "./lib/pairing.js";
import type { StoredPairing } from "./lib/pairingRecord.js";
import { clearPairing, loadPairing, savePairing } from "./platform.js";
import { PairScreen } from "./screens/PairScreen.js";
import { usePalette } from "./theme.js";
import { EmptyState } from "./ui/components.js";

type Boot =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "unpaired"; notice?: string | undefined }
  | { kind: "paired"; pairing: StoredPairing };

export function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const palette = usePalette();
  const [boot, setBoot] = useState<Boot>({ kind: "loading" });

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(palette.canvas);
  }, [palette.canvas]);

  const load = useCallback(() => {
    setBoot({ kind: "loading" });
    loadPairing().then(
      (pairing) => setBoot(pairing ? { kind: "paired", pairing } : { kind: "unpaired" }),
      () => setBoot({ kind: "failed" }),
    );
  }, []);

  useEffect(() => load(), [load]);

  const onPaired = async (pairing: StoredPairing) => {
    try {
      await savePairing(pairing);
    } catch {
      throw new PairError(
        "The desktop paired, but this phone could not save the pairing. Revoke this phone on the desktop and pair again.",
      );
    }
    setBoot({ kind: "paired", pairing });
  };

  const forget = async (notice?: string) => {
    // Clearing can fail if the keystore is locked; the pairing is useless either way.
    await clearPairing().catch(() => {});
    setBoot({ kind: "unpaired", notice });
  };

  return (
    <View style={{ flex: 1, backgroundColor: palette.canvas }}>
      <StatusBar style={palette.scheme === "dark" ? "light" : "dark"} />
      {boot.kind === "loading" ? (
        <EmptyState busy title="Opening ZLI Remote" />
      ) : boot.kind === "failed" ? (
        <EmptyState
          title="Could not read the saved pairing"
          message="This phone's secure storage did not answer. Try again, or pair again if it keeps failing."
          action={{ label: "Try again", onPress: load }}
        />
      ) : boot.kind === "unpaired" ? (
        <PairScreen notice={boot.notice} onPaired={onPaired} />
      ) : (
        <LinkProvider key={boot.pairing.deviceId} pairing={boot.pairing}>
          <Navigator onForget={forget} />
        </LinkProvider>
      )}
    </View>
  );
}
