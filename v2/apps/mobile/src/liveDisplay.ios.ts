import { requireOptionalNativeModule } from "expo";

import type { LiveDisplay } from "./lib/liveStatus.js";

// Expo Go has no widget extension, and importing expo-widgets there throws.
const activity = requireOptionalNativeModule("ExpoWidgets") ? import("./liveActivity.js") : undefined;

/** A Live Activity on the lock screen and in the Dynamic Island. */
export const liveDisplay: LiveDisplay = {
  keepsAppRunning: false,
  show: async (status, options) => {
    await (await activity)?.showActivity(status, options);
  },
  hide: async () => {
    await (await activity)?.hideActivity();
  },
  onAction: (listener) => {
    let subscription: { remove(): void } | undefined;
    let removed = false;
    void activity?.then((module) => {
      if (!removed) subscription = module.onActivityAction(listener);
    });
    return {
      remove: () => {
        removed = true;
        subscription?.remove();
      },
    };
  },
};
