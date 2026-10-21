/** Whether ZLI raises system notifications, a badge, and a taskbar flash when an agent needs the person. */
export type NotificationSettings = {
  enabled: boolean;
  sound: boolean;
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = { enabled: true, sound: true };

/** Reads stored or sent settings. Unknown or malformed fields fall back to `base`. */
export function parseNotificationSettings(
  value: unknown,
  base: NotificationSettings = DEFAULT_NOTIFICATION_SETTINGS,
): NotificationSettings {
  if (typeof value !== "object" || value === null) return { ...base };
  const record = value as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : base.enabled,
    sound: typeof record.sound === "boolean" ? record.sound : base.sound,
  };
}

/** Keeps only the boolean fields a caller actually set. */
export function parseNotificationSettingsPatch(value: unknown): Partial<NotificationSettings> {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
    ...(typeof record.sound === "boolean" ? { sound: record.sound } : {}),
  };
}
