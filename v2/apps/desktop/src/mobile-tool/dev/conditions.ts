import { DEVICE_PERMISSIONS } from "@zli-v2/contracts";

import type { MobileDevToolModule } from "./types.js";

const PERMISSION_LIST = { type: "array", items: { type: "string", enum: [...DEVICE_PERMISSIONS] } };

export const conditionsTools: MobileDevToolModule = {
  tools: [
    {
      name: "mobile_device_settings",
      title: "Change device settings",
      action: "mobiledevicesettings",
      description:
        "Change the conditions your app runs under: light or dark appearance, text size, a simulated GPS location, the app's permissions, and a test push notification (iOS simulators only). Pass any mix; they run in the order listed and the result says what changed. Android sets the location only on emulators; iOS simulators cannot set camera or notification permission.",
      properties: {
        appearance: { type: "string", enum: ["light", "dark"] },
        textSize: {
          type: "string",
          enum: ["small", "default", "large", "largest"],
          description: "Android font scale 0.85, 1.0, 1.15, or 1.3; the matching iOS Dynamic Type size.",
        },
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 },
        clearLocation: { type: "boolean", description: "iOS simulators only: stop simulating a location." },
        appId: {
          type: "string",
          description:
            "The Android package or iOS bundle id, such as com.example.app. Needed for permissions and notifications.",
        },
        grant: { ...PERMISSION_LIST, description: "Permissions to grant the app." },
        revoke: { ...PERMISSION_LIST, description: "Permissions to take away from the app." },
        notificationTitle: {
          type: "string",
          description: "Sends a test notification with this title (iOS simulators).",
        },
        notificationBody: { type: "string", description: "The test notification's text." },
      },
    },
  ],
  format: (action, result) => {
    if (action !== "mobiledevicesettings" || typeof result !== "object" || result === null) return undefined;
    const done = (result as { done?: unknown }).done;
    if (!Array.isArray(done) || !done.every((line) => typeof line === "string")) return undefined;
    return { content: [{ type: "text", text: done.join("\n") }] };
  },
  instructions:
    "To test dark mode, larger text, a location, or a permission prompt, call mobile_device_settings instead of tapping through the device's Settings app.",
};
