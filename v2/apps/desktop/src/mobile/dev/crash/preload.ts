import { MobileCrashDismissInput, MobileCrashEvent, MobileCrashList, MobileDeviceIdInput } from "@zli-v2/contracts";

import { listenParsed, type PreloadIpc } from "../preloadIpc.js";

/** The crash banner's view of crash watch: the reports per device, dismiss, and a push when they change. */
export function createCrashApi(ipc: PreloadIpc) {
  return {
    crash: {
      list: async (deviceId: string) =>
        MobileCrashList.parse(await ipc.invoke("zli:mobile:crash:list", MobileDeviceIdInput.parse({ deviceId }))),
      dismiss: async (deviceId: string, crashId: string) =>
        MobileCrashList.parse(
          await ipc.invoke("zli:mobile:crash:dismiss", MobileCrashDismissInput.parse({ deviceId, crashId })),
        ),
      onChange: listenParsed(ipc, "zli:mobile:crash", MobileCrashEvent),
    },
  };
}
