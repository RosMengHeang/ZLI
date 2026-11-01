import { type MetroOwner, MobileWorkspace } from "@zli-v2/contracts";

import type { MobileDevToolModule } from "./types.js";

export const workspaceTools: MobileDevToolModule = {
  tools: [
    {
      name: "mobile_workspace",
      title: "This worktree's Metro port and device",
      action: "mobileworkspace",
      description:
        "Your worktree's own Metro port, which ZLI also sets as ZLI_METRO_PORT and RCT_METRO_PORT in your terminal, who is listening on it, the URL that opens your app on a device, and the device you hold. Other worktrees use other ports, so never start Metro on 8081 from a worktree.",
      properties: {},
      readOnly: true,
    },
  ],
  format: (action, result) => {
    if (action !== "mobileworkspace") return undefined;
    const parsed = MobileWorkspace.safeParse(result);
    if (!parsed.success) return undefined;
    return { content: [{ type: "text", text: workspaceText(parsed.data) }] };
  },
  instructions:
    "Start Metro on your worktree's port: npx expo start --port $ZLI_METRO_PORT (add --dev-client for a development build), or npx react-native start --port $ZLI_METRO_PORT. Call mobile_workspace to get the URL to open on the device.",
};

/** For example: Metro port 8142 (free). Open with exp://localhost:8142. Device: android-avd:Pixel_7. */
export function workspaceText(workspace: MobileWorkspace): string {
  const lines = [
    `Metro port ${workspace.metroPort} (${ownerText(workspace.metro)}).`,
    `Open with ${workspace.openUrl}.`,
    `Device: ${workspace.deviceId ?? "none held yet; mobile_boot or mobile_devices picks one"}.`,
  ];
  if (workspace.emulatorPort !== undefined)
    lines.push(`Emulators you boot use emulator-${workspace.emulatorPort} when it is free.`);
  if (workspace.metro.state === "other-worktree")
    lines.push(
      `Do not open this port: the app would load ${workspace.metro.branch}'s bundle. Ask the person to stop that Metro server.`,
    );
  return lines.join(" ");
}

function ownerText(owner: MetroOwner): string {
  switch (owner.state) {
    case "free":
      return "free";
    case "this-worktree":
      return `running from this worktree, pid ${owner.pid}`;
    case "other-worktree":
      return `used by the worktree ${owner.branch}, pid ${owner.pid}`;
    case "other-process":
      return owner.pid === undefined ? "used by another program" : `used by another program, pid ${owner.pid}`;
    case "unknown":
      return `not checked: ${owner.reason}`;
  }
}
