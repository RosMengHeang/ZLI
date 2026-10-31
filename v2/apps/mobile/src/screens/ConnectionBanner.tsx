import { View } from "react-native";

import { useLink, useLinkSnapshot } from "../LinkContext.js";
import { space } from "../theme.js";
import { Notice } from "../ui/components.js";

/** Says when the screen may be stale, and offers to retry at once. */
export function ConnectionBanner() {
  const link = useLink();
  const snapshot = useLinkSnapshot();
  const { state } = snapshot;
  if (state.kind === "offline" && snapshot.projection) {
    return (
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
        <Notice
          tone="warning"
          title={`${snapshot.pairing.desktopName} is out of reach`}
          message={`${state.message} What you see may be out of date.`}
          action={{ label: "Try now", onPress: () => link.retryNow() }}
        />
      </View>
    );
  }
  if (state.kind === "connecting" && snapshot.projection) {
    return (
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
        <Notice tone="info" message="Reconnecting. What you see may be out of date." />
      </View>
    );
  }
  return null;
}
