import type { RuntimeClient } from "@zli-v2/client-runtime";
import { app, type BrowserWindow, ipcMain, type NativeImage, Notification, nativeImage } from "electron";

import { AgentNotifier, type NotifierHost } from "./AgentNotifier.js";
import { NotificationSettingsStore } from "./NotificationSettingsStore.js";

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
  const store = new NotificationSettingsStore(options.settingsPath);
  await store.load();
  // Electron drops click handlers of notifications that are garbage collected, so live ones are kept.
  const live = new Set<Notification>();
  // The renderer draws each chat's animal; a notification about that chat wears it.
  let faces = new Map<string, NativeImage>();
  const bringForward = () => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const host: NotifierHost = {
    show: ({ title, body, silent, sessionId }, onClick) => {
      if (!Notification.isSupported()) return;
      const icon = sessionId ? faces.get(sessionId) : undefined;
      const notification = new Notification({ title, body, silent, ...(icon ? { icon } : {}) });
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
    focusWindow: () => {
      if (!window.isDestroyed()) bringForward();
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
  ipcMain.handle("zli:notifications:set-faces", (_event, input: unknown) => {
    const raw = input && typeof input === "object" ? (input as { faces?: unknown }).faces : undefined;
    const next = new Map<string, NativeImage>();
    if (raw && typeof raw === "object") {
      for (const [sessionId, icon] of Object.entries(raw).slice(0, 200)) {
        if (typeof icon !== "string" || !icon.startsWith("data:image/png;base64,") || icon.length > 200_000) continue;
        const image = nativeImage.createFromDataURL(icon);
        if (!image.isEmpty()) next.set(sessionId, image);
      }
    }
    faces = next;
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
