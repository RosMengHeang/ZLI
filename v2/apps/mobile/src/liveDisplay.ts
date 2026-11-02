import type { LiveDisplay } from "./lib/liveStatus.js";

/** Web and anything else without a system surface for it: the status only shows inside the app. */
export const liveDisplay: LiveDisplay = {
  keepsAppRunning: false,
  show: async () => {},
  hide: async () => {},
  onAction: () => ({ remove: () => {} }),
};
