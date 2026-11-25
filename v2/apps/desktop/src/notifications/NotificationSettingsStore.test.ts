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
    expect(parseNotificationSettings(undefined)).toEqual({ enabled: true, sound: true, tone: "chime", volume: 70 });
    expect(parseNotificationSettings({ enabled: "no", sound: false })).toEqual({
      enabled: true,
      sound: false,
      tone: "chime",
      volume: 70,
    });
    expect(parseNotificationSettings({ tone: "bell", volume: 40.4 })).toMatchObject({ tone: "bell", volume: 40 });
    expect(parseNotificationSettings({ tone: "siren", volume: 140 })).toMatchObject({ tone: "chime", volume: 70 });
    expect(parseNotificationSettingsPatch({ enabled: false, sound: "loud", extra: 1 })).toEqual({ enabled: false });
    expect(parseNotificationSettingsPatch({ tone: "pop", volume: -1 })).toEqual({ tone: "pop" });
  });

  it("loads defaults when the file is missing or broken and saves updates", async () => {
    const path = await tempPath();
    const store = new NotificationSettingsStore(path);
    expect(await store.load()).toEqual({ enabled: true, sound: true, tone: "chime", volume: 70 });

    expect(await store.update({ sound: false })).toEqual({ enabled: true, sound: false, tone: "chime", volume: 70 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      enabled: true,
      sound: false,
      tone: "chime",
      volume: 70,
    });
    expect(await new NotificationSettingsStore(path).load()).toEqual({
      enabled: true,
      sound: false,
      tone: "chime",
      volume: 70,
    });

    await writeFile(path, "{not json", "utf8");
    expect(await new NotificationSettingsStore(path).load()).toEqual({
      enabled: true,
      sound: true,
      tone: "chime",
      volume: 70,
    });
  });

  it("keeps the last of several quick updates on disk", async () => {
    const path = await tempPath();
    const store = new NotificationSettingsStore(path);
    await Promise.all([
      store.update({ enabled: false }),
      store.update({ sound: false }),
      store.update({ enabled: true }),
    ]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      enabled: true,
      sound: false,
      tone: "chime",
      volume: 70,
    });
  });
});
