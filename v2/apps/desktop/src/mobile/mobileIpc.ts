import {
  MobileAvdCreateInput,
  MobileAvdDeleteInput,
  MobileDeviceIdInput,
  MobileIosHostTestInput,
  MobilePanelInput,
  MobilePanelLaunchInput,
  MobilePanelLogsInput,
  MobilePanelOpenUrlInput,
  MobilePopOutAspectInput,
  MobilePopOutPinInput,
  MobileSettings,
  MobileSetupRunInput,
  MobileSimulatorCreateInput,
  MobileSimulatorDeleteInput,
  MobileWifiConnectInput,
  MobileWifiPairInput,
} from "@zli-v2/contracts";
import { PANEL_VIEWER } from "./DeviceManager.js";
import type { MobileDev } from "./dev/index.js";
import type { MobileService } from "./MobileService.js";
import type { MobileSettingsStore } from "./MobileSettingsStore.js";
import type { PopOutWindows } from "./PopOutWindows.js";

/** Which window sent the call, so each window's stream is started and stopped as its own viewer. */
export type MobileIpcContext = { readonly viewer: string };
export type MobileIpcHandler = (input: unknown, context?: MobileIpcContext) => unknown;

/** The stream viewer for a window's renderer. */
export function streamViewer(webContentsId: number): string {
  return `window-${webContentsId}`;
}

/**
 * What each zli:mobile channel does with the renderer's payload. Every payload is parsed here, because the
 * renderer is not trusted to have run the preload's own checks.
 */
export function mobileIpcHandlers(deps: {
  service():
    | Pick<MobileService, "manager" | "setup" | "status" | "avds" | "simulators" | "wireless" | "testIosHost">
    | undefined;
  settings(): Pick<MobileSettingsStore, "get" | "set"> | undefined;
  popOuts?(): Pick<PopOutWindows, "open" | "close" | "pin" | "setAspect" | "list"> | undefined;
  /** The mobile dev features' channels, named zli:mobile:<feature>:<verb>. Read once, when the handlers are made. */
  dev?(): Pick<MobileDev, "ipc"> | undefined;
}): Record<string, MobileIpcHandler> {
  const service = () => {
    const current = deps.service();
    if (!current) throw new Error("ZLI's mobile service is not running.");
    return current;
  };
  const settings = () => {
    const current = deps.settings();
    if (!current) throw new Error("ZLI's mobile service is not running.");
    return current;
  };
  const popOuts = () => {
    const current = deps.popOuts?.();
    if (!current) throw new Error("ZLI's pop-out windows are not ready yet.");
    return current;
  };
  const manager = () => service().manager;
  const deviceId = (input: unknown) => MobileDeviceIdInput.parse(input).deviceId;
  return {
    "zli:mobile:status": (input) =>
      service().status({
        recheckAcceleration: (input as { recheckAcceleration?: unknown } | undefined)?.recheckAcceleration === true,
      }),
    "zli:mobile:setup-plan": () => service().setup.plan(),
    "zli:mobile:setup-progress": () => service().setup.progress,
    // Resolves when setup ends. The panel follows each step through zli:mobile:setup events meanwhile.
    "zli:mobile:setup-run": async (input) => {
      await service().setup.run(MobileSetupRunInput.parse(input).acceptedLicenses);
      return { accepted: true };
    },
    "zli:mobile:setup-cancel": () => {
      service().setup.cancel();
      return { accepted: true };
    },
    "zli:mobile:avd-list": () => service().avds.list(),
    "zli:mobile:avd-create": (input) => service().avds.create(MobileAvdCreateInput.parse(input)),
    "zli:mobile:avd-delete": (input) => service().avds.delete(MobileAvdDeleteInput.parse(input)),
    "zli:mobile:sim-list": () => service().simulators.list(),
    "zli:mobile:sim-create": (input) => service().simulators.create(MobileSimulatorCreateInput.parse(input)),
    "zli:mobile:sim-delete": (input) => service().simulators.delete(MobileSimulatorDeleteInput.parse(input)),
    "zli:mobile:devices": () => manager().list(),
    "zli:mobile:boot": (input) => manager().boot(deviceId(input)),
    "zli:mobile:shutdown": async (input) => {
      await manager().shutdown(deviceId(input));
      return { accepted: true };
    },
    "zli:mobile:wifi-pair": (input) => service().wireless.pair(MobileWifiPairInput.parse(input)),
    "zli:mobile:wifi-connect": (input) => service().wireless.connect(MobileWifiConnectInput.parse(input)),
    "zli:mobile:wifi-disconnect": async (input) => {
      await service().wireless.disconnect(deviceId(input));
      return { accepted: true };
    },
    "zli:mobile:stream-start": (input, context) => manager().startStream(deviceId(input), context?.viewer),
    "zli:mobile:stream-stop": async (input, context) => {
      // Without a viewer, stopping would end the stream for every window showing the device.
      await manager().stopStream(deviceId(input), context?.viewer ?? PANEL_VIEWER);
      return { accepted: true };
    },
    "zli:mobile:popout-list": () => popOuts().list(),
    "zli:mobile:popout-open": (input) => popOuts().open(deviceId(input)),
    "zli:mobile:popout-close": (input) => popOuts().close(deviceId(input)),
    "zli:mobile:popout-pin": (input) => {
      const parsed = MobilePopOutPinInput.parse(input);
      return popOuts().pin(parsed.deviceId, parsed.pinned);
    },
    "zli:mobile:popout-aspect": (input) => {
      popOuts().setAspect(MobilePopOutAspectInput.parse(input));
      return { accepted: true };
    },
    "zli:mobile:input": async (input) => {
      await manager().panelInput(MobilePanelInput.parse(input));
      return { accepted: true };
    },
    "zli:mobile:open-url": (input) => {
      const parsed = MobilePanelOpenUrlInput.parse(input);
      return manager().openUrl(parsed.deviceId, parsed.url);
    },
    "zli:mobile:logs": (input) => {
      const { deviceId: id, ...query } = MobilePanelLogsInput.parse(input);
      return manager().logs(id, {
        ...(query.appId ? { appId: query.appId } : {}),
        ...(query.lines ? { lines: query.lines } : {}),
        ...(query.filter ? { filter: query.filter } : {}),
      });
    },
    "zli:mobile:launch": async (input) => {
      const parsed = MobilePanelLaunchInput.parse(input);
      await manager().launch(parsed.deviceId, parsed.appId, parsed.stop ? { stop: true } : {});
      return { accepted: true };
    },
    "zli:mobile:take-over": (input) => {
      manager().takeOver(deviceId(input));
      return { accepted: true };
    },
    "zli:mobile:release": (input) => {
      manager().release(deviceId(input));
      return { accepted: true };
    },
    "zli:mobile:screenshot": async (input) => {
      const shot = await manager().screenshot(deviceId(input));
      return { data: shot.data.toString("base64"), mimeType: "image/png", width: shot.width, height: shot.height };
    },
    "zli:mobile:settings-get": () => settings().get(),
    "zli:mobile:settings-set": async (input) => {
      const patch = MobileSettings.partial().parse(input);
      const next = await settings().set(patch);
      // Another Mac means other simulators, so the device list is read again and sent to every window.
      const manager = deps.service()?.manager;
      if (patch.iosRemoteHost !== undefined && manager) void manager.list().catch(() => undefined);
      return next;
    },
    "zli:mobile:ios-host-test": (input) => service().testIosHost(MobileIosHostTestInput.parse(input).host),
    ...devIpcHandlers(deps.dev),
  };
}

function devIpcHandlers(dev: (() => Pick<MobileDev, "ipc"> | undefined) | undefined): Record<string, MobileIpcHandler> {
  const handlers = dev?.()?.ipc ?? {};
  for (const channel of Object.keys(handlers)) {
    // The feature segment keeps a feature's channel from replacing a core one such as zli:mobile:status.
    if (!/^zli:mobile:[a-z]+:[a-z-]+$/u.test(channel))
      throw new Error(`Mobile dev channel ${channel} must be named zli:mobile:<feature>:<verb>.`);
  }
  return handlers;
}
