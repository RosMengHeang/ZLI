import type { MobileBridge } from "../../runtime/bridge.js";
import { CrashWatchSettingGroup } from "./crash/CrashWatchSettingGroup.js";
import { WorktreesSettingGroup } from "./workspace/WorktreesSettingGroup.js";

/** The mobile dev features' groups in Settings > Mobile, between Agents and Android SDK. */
export function MobileDevSettingGroups({ mobile }: { mobile: MobileBridge }) {
  return (
    <>
      <WorktreesSettingGroup mobile={mobile} />
      <CrashWatchSettingGroup mobile={mobile} />
    </>
  );
}
