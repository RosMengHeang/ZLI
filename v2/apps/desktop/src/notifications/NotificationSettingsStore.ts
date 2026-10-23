import { readFile } from "node:fs/promises";

import { writeJsonFile } from "../storage/writeJsonFile.js";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  parseNotificationSettings,
} from "./notificationSettings.js";

/** Notification settings kept in a small JSON file beside the app's other per-user state. */
export class NotificationSettingsStore {
  private settings: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS };
  private writing: Promise<void> = Promise.resolve();

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
    const snapshot = this.current();
    // Two quick toggles share one temporary file, so writes go one at a time.
    const write = this.writing.then(() => writeJsonFile(this.path, snapshot));
    this.writing = write.catch(() => undefined);
    await write;
    return snapshot;
  }
}
