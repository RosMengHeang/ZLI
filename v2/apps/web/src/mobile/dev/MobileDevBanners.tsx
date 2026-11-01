import type { MobileDevContext } from "./context.js";
import { CrashBanner } from "./crash/CrashBanner.js";
import { ProposalCards } from "./ProposalCards.js";
import { WorkspaceBanner } from "./workspace/WorkspaceBanner.js";
import "./styles.js";

/** The mobile dev features' banners under the Mobile panel's header, in a fixed order. */
export function MobileDevBanners({ context }: { context: MobileDevContext }) {
  return (
    <>
      <ProposalCards context={context} />
      <WorkspaceBanner context={context} />
      <CrashBanner context={context} />
    </>
  );
}
