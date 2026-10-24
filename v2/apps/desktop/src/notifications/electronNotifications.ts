import { app, type BrowserWindow, ipcMain, Notification } from "electron";

import type { RuntimeClient } from "@zli-v2/client-runtime";

import { AgentNotifier, type NotifierHost } from "./AgentNotifier.js";
import { NotificationSettingsStore } from "./NotificationSettingsStore.js";

const WINDOWS_APP_ID = "dev.zli.desktop";
const MAX_LIVE_NOTIFICATIONS = 20;

/**
 * Raises system notifications from runtime projections and wires the renderer's settings and
 * visible-tile reports. Call once the main window exists and before the renderer loads.
 */
export async function registerAgentNotifications(options: {
  window: BrowserWindow;
  runtime: RuntimeClient;
  settingsPath: string;
}): Promise<AgentNotifier> {
  const { window, runtime } = options;
  // Windows shows toasts only for an app whose AppUserModelID matches its Start menu shortcut,
  // which electron-builder creates from appId.
  if (process.platform === "win32") app.setAppUserModelId(WINDOWS_APP_ID);
  const store = new NotificationSettingsStore(options.settingsPath);
  await store.load();
  // Electron drops click handlers of notifications that are garbage collected, so live ones are kept.
  const live = new Set<Notification>();
  const bringForward = () => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const host: NotifierHost = {
    show: ({ title, body, silent }, onClick) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title, body, silent });
      live.add(notification);
      if (live.size > MAX_LIVE_NOTIFICATIONS) {
        const oldest = live.values().next().value;
        if (oldest) live.delete(oldest);
      }
      notification.on("click", () => {
        live.delete(notification);
        onClick();
      });
      notification.on("close", () => live.delete(notification));
      notification.show();
    },
    setBadgeCount: (count) => {
      try {
        app.setBadgeCount(count);
      } catch {
        // Not every Linux desktop has a launcher that shows counts.
      }
    },
    flashFrame: (flash) => {
      if (window.isDestroyed()) return;
      if (process.platform === "darwin") {
        if (flash) app.dock?.bounce("informational");
      } else {
        window.flashFrame(flash);
      }
    },
    isFocused: () => !window.isDestroyed() && window.isFocused(),
    activate: (sessionId) => {
      if (window.isDestroyed()) return;
      bringForward();
      window.webContents.send("zli:notifications:activate", { sessionId });
    },
    openConnector: (connectorId) => {
      if (window.isDestroyed()) return;
      bringForward();
      window.webContents.send("zli:connectors:open", { connectorId });
    },
  };
  const notifier = new AgentNotifier(host, () => store.current());
  const initial = runtime.projection();
  if (initial) notifier.update(initial);
  runtime.subscribe((projection) => notifier.update(projection));
  window.on("focus", () => notifier.windowFocused());

  ipcMain.handle("zli:notifications:get-settings", () => store.current());
  ipcMain.handle("zli:notifications:set-settings", async (_event, patch: unknown) => {
    const next = await store.update(patch);
    notifier.settingsChanged();
    return next;
  });
  ipcMain.handle("zli:notifications:set-viewing", (_event, input: unknown) => {
    const ids =
      input && typeof input === "object" && Array.isArray((input as { sessionIds?: unknown }).sessionIds)
        ? (input as { sessionIds: unknown[] }).sessionIds.filter((id): id is string => typeof id === "string")
        : [];
    notifier.setViewing(ids.slice(0, 200));
  });
  return notifier;
}
