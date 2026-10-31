import { UpdateAutoInstallInput } from "@zli-v2/contracts";
import { app, type BrowserWindow, ipcMain } from "electron";

import { type UpdaterLike, UpdateService } from "./UpdateService.js";
import { UpdateSettingsStore } from "./UpdateSettingsStore.js";

/**
 * scripts/build.mjs sets this to true when ZLI_MAC_SIGNED=1, which the release workflow does once
 * macOS builds are signed and notarized. Until then macOS offers the release page instead.
 */
declare const __ZLI_MAC_SIGNED__: boolean | undefined;

/**
 * Starts the update checks and wires the renderer's update controls. Call once the main window
 * exists and before the renderer loads.
 */
export async function registerUpdates(options: {
  window: BrowserWindow;
  settingsPath: string;
  openExternal(url: string): Promise<unknown>;
  prepareToInstall(): Promise<void>;
  log(level: "info" | "warn" | "error", message: string): void;
}): Promise<UpdateService> {
  const { window } = options;
  const settings = new UpdateSettingsStore(options.settingsPath);
  await settings.load();
  const service = new UpdateService({
    loadUpdater: async () => (await import("electron-updater")).default.autoUpdater as unknown as UpdaterLike,
    platform: process.platform,
    isPackaged: app.isPackaged,
    env: process.env,
    currentVersion: app.getVersion(),
    macCanAutoInstall: typeof __ZLI_MAC_SIGNED__ === "boolean" && __ZLI_MAC_SIGNED__,
    settings,
    openExternal: options.openExternal,
    prepareToInstall: options.prepareToInstall,
    // The app's processes are already stopped, so skip before-quit and start fresh.
    relaunch: () => {
      app.relaunch();
      app.exit(0);
    },
    log: options.log,
  });
  service.subscribe((status) => {
    if (!window.isDestroyed()) window.webContents.send("zli:updates:status", status);
  });

  ipcMain.handle("zli:updates:get-status", () => service.status());
  ipcMain.handle("zli:updates:check", () => service.check());
  ipcMain.handle("zli:updates:download", () => service.download());
  ipcMain.handle("zli:updates:install", () => service.quitAndInstall());
  ipcMain.handle("zli:updates:open-release", () => service.openReleasePage());
  ipcMain.handle("zli:updates:set-auto-install", (_event, input: unknown) =>
    service.setAutoInstall(UpdateAutoInstallInput.parse(input).autoInstall),
  );
  ipcMain.handle("zli:updates:whats-new", () => service.whatsNew() ?? null);
  ipcMain.handle("zli:updates:dismiss-whats-new", () => service.dismissWhatsNew());
  app.on("will-quit", () => service.stop());

  service.start();
  return service;
}
