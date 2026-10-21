import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NotificationSettingsStore } from "./NotificationSettingsStore.js";
import { parseNotificationSettings, parseNotificationSettingsPatch } from "./notificationSettings.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zli-notifications-"));
  roots.push(root);
  return join(root, "settings", "notifications.json");
}

describe("notification settings", () => {
  it("defaults to on with sound and ignores fields of the wrong type", () => {
    expect(parseNotificationSettings(undefined)).toEqual({ enabled: true, sound: true });
    expect(parseNotificationSettings({ enabled: "no", sound: false })).toEqual({ enabled: true, sound: false });
    expect(parseNotificationSettingsPatch({ enabled: false, sound: "loud", extra: 1 })).toEqual({ enabled: false });
  });

  it("loads defaults when the file is missing or broken and saves updates", async () => {
    const path = await tempPath();
    const store = new NotificationSettingsStore(path);
    expect(await store.load()).toEqual({ enabled: true, sound: true });

    expect(await store.update({ sound: false })).toEqual({ enabled: true, sound: false });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ enabled: true, sound: false });
    expect(await new NotificationSettingsStore(path).load()).toEqual({ enabled: true, sound: false });

    await writeFile(path, "{not json", "utf8");
    expect(await new NotificationSettingsStore(path).load()).toEqual({ enabled: true, sound: true });
  });
});
