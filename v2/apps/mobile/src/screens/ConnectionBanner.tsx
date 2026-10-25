import { useLink, useLinkSnapshot } from "../LinkContext.js";
import { Banner } from "../ui/components.js";

/** Says when the screen may be stale, and offers to retry at once. */
export function ConnectionBanner() {
  const link = useLink();
  const snapshot = useLinkSnapshot();
  const { state } = snapshot;
  if (state.kind === "offline" && snapshot.projection) {
    return (
      <Banner
        tone="warning"
        title={`${snapshot.pairing.desktopName} is out of reach`}
        message={`${state.message} What you see may be out of date.`}
        action={{ label: "Try now", onPress: () => link.retryNow() }}
      />
    );
  }
  if (state.kind === "connecting" && snapshot.projection) {
    return <Banner tone="info" message="Reconnecting. What you see may be out of date." />;
  }
  return null;
}
