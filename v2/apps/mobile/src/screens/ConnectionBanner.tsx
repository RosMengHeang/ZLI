import { View } from "react-native";

import { useLink, useLinkSnapshot } from "../LinkContext.js";
import { routeBadge } from "../lib/routes.js";
import { space } from "../theme.js";
import { Notice, StatusText } from "../ui/components.js";

/** Says when the screen may be stale and offers to retry at once; while online, names the route in use. */
export function ConnectionBanner() {
  const link = useLink();
  const snapshot = useLinkSnapshot();
  const { state } = snapshot;
  const badge = routeBadge(state.kind, snapshot.route);
  if (badge) {
    // Blue marks the relay, the route to notice; the home network is the unremarkable case.
    return (
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm, alignItems: "flex-start" }}>
        <StatusText label={badge} tone={snapshot.route === "relay" ? "blue" : "neutral"} />
      </View>
    );
  }
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
