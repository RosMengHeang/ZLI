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
    const write = this.writing.then(() => this.write(snapshot));
    this.writing = write.catch(() => undefined);
    await write;
    return snapshot;
  }

  private async write(settings: NotificationSettings): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await renameWithRetry(temporary, this.path);
  }
}

/** Antivirus and the search indexer briefly lock new files on Windows, which makes rename fail. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 9 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20 * (attempt + 1)));
    }
  }
}
