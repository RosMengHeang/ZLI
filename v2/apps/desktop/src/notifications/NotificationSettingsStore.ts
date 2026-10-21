import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  parseNotificationSettings,
} from "./notificationSettings.js";

/** Notification settings kept in a small JSON file beside the app's other per-user state. */
export class NotificationSettingsStore {
  private settings: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS };

  constructor(private readonly path: string) {}

  current(): NotificationSettings {
    return { ...this.settings };
  }

  async load(): Promise<NotificationSettings> {
    try {
      this.settings = parseNotificationSettings(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      // A missing or unreadable file means the defaults.
      this.settings = { ...DEFAULT_NOTIFICATION_SETTINGS };
    }
    return this.current();
  }

  async update(patch: unknown): Promise<NotificationSettings> {
    this.settings = parseNotificationSettings(patch, this.settings);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.settings, null, 2)}\n`, "utf8");
    await rename(temporary, this.path);
    return this.current();
  }
}
