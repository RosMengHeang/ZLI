import type { MobileDevice } from "@zli-v2/contracts";

import type { MobileBridge } from "../../runtime/bridge.js";
import type { DevServerHint } from "../mobile.js";

/** What the Mobile panel gives every mobile dev banner and project group. */
export type MobileDevContext = {
  readonly mobile: MobileBridge;
  /** The worktree the current agent works in. Without one there is no project to check or propose for. */
  readonly worktreeId: string | undefined;
  /** The device the panel shows, if any. */
  readonly device: MobileDevice | undefined;
  readonly online: boolean;
  /** An agent holds the shown device, so the person's input is refused until they take over. */
  readonly agentHolds: boolean;
  readonly devServers: readonly DevServerHint[];
  /** Shows an error in the panel's error banner, or clears it with undefined. */
  onError(message: string | undefined): void;
  /** Shows a short confirmation in the panel. */
  onNotice(message: string): void;
  /** Opens the terminal drawer, where accepted commands run. */
  onOpenTerminal?(): void;
};
