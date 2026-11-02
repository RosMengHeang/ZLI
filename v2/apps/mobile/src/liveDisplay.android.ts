import { NativeModule, requireOptionalNativeModule } from "expo";

import { agentLink, type LiveAction, type LiveDisplay } from "./lib/liveStatus.js";

type NativeStatus = {
  title: string;
  detail: string;
  badge: string;
  others?: string;
  needsYou: boolean;
  url: string;
  actions: LiveAction[];
};

declare class LiveStatusModule extends NativeModule<{ onAction: (event: { target: string }) => void }> {
  show(status: NativeStatus): Promise<void>;
  hide(): Promise<void>;
}

// The module lives in modules/zli-live-status; Expo Go does not have it.
const native = requireOptionalNativeModule<LiveStatusModule>("ZliLiveStatus");

/**
 * An ongoing notification from a foreground service, which also keeps the app and its connection
 * running. Android 16 promotes it to a Live Update in the status bar.
 */
export const liveDisplay: LiveDisplay = {
  keepsAppRunning: native !== null,
  show: async (status) => {
    await native?.show({
      title: status.title,
      detail: status.detail,
      badge: status.badge,
      ...(status.others ? { others: status.others } : {}),
      needsYou: status.needsYou,
      url: agentLink(status.threadId),
      actions: status.actions,
    });
  },
  hide: async () => {
    await native?.hide();
  },
  onAction: (listener) => native?.addListener("onAction", (event) => listener(event.target)) ?? { remove: () => {} },
};
