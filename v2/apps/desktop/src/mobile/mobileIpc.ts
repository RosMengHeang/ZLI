import {
  MobileAvdCreateInput,
  MobileAvdDeleteInput,
  MobileDeviceIdInput,
  MobilePanelInput,
  MobilePanelLaunchInput,
  MobilePanelLogsInput,
  MobilePanelOpenUrlInput,
  MobileSettings,
  MobileSetupRunInput,
} from "@zli-v2/contracts";

import type { MobileService } from "./MobileService.js";
import type { MobileSettingsStore } from "./MobileSettingsStore.js";

export type MobileIpcHandler = (input: unknown) => unknown;

/**
 * What each zli:mobile channel does with the renderer's payload. Every payload is parsed here, because the
 * renderer is not trusted to have run the preload's own checks.
 */
export function mobileIpcHandlers(deps: {
  service(): Pick<MobileService, "manager" | "setup" | "status" | "avds"> | undefined;
  settings(): Pick<MobileSettingsStore, "get" | "set"> | undefined;
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
    "zli:mobile:devices": () => manager().list(),
    "zli:mobile:boot": (input) => manager().boot(deviceId(input)),
    "zli:mobile:shutdown": async (input) => {
      await manager().shutdown(deviceId(input));
      return { accepted: true };
    },
    "zli:mobile:stream-start": (input) => manager().startStream(deviceId(input)),
    "zli:mobile:stream-stop": async (input) => {
      await manager().stopStream(deviceId(input));
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
    "zli:mobile:settings-set": (input) => settings().set(MobileSettings.partial().parse(input)),
  };
}
