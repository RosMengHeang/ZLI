import type { ReactElement } from "react";

import { MobileDeviceWindow } from "./mobile/MobileDeviceWindow.js";
import { getBridge, type ZliBridge } from "./runtime/bridge.js";
import { AppShell } from "./shell/AppShell.js";
import { TooltipLayer } from "./ui/Tooltip.js";

/**
 * What the renderer shows. The desktop app loads the same page for a pop-out device window, with
 * ?view=mobile-device&deviceId=... in place of the whole app.
 */
export function rootView(search: string, bridge: ZliBridge | undefined = getBridge()): ReactElement {
  const params = new URLSearchParams(search);
  const deviceId = params.get("deviceId");
  if (params.get("view") === "mobile-device" && deviceId)
    return (
      <>
        <MobileDeviceWindow mobile={bridge?.mobile} deviceId={deviceId} />
        <TooltipLayer />
      </>
    );
  return <AppShell />;
}
