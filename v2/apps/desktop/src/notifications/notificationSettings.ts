/**
 * Whether ZLI raises system notifications, a badge, and a taskbar flash when an agent needs the person, and
 * the sound they make. The window plays the tone itself, at `volume` (0 to 100); the system notification stays
 * silent so only one sound plays.
 */
export type NotificationSettings = {
  enabled: boolean;
  sound: boolean;
  tone: NotificationTone;
  volume: number;
};

export type NotificationTone = "chime" | "ping" | "pop" | "bell" | "soft" | "custom";
const TONES: readonly NotificationTone[] = ["chime", "ping", "pop", "bell", "soft", "custom"];

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  sound: true,
  tone: "chime",
  volume: 70,
};

const isTone = (value: unknown): value is NotificationTone => TONES.includes(value as NotificationTone);
const isVolume = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

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
    tone: isTone(record.tone) ? record.tone : base.tone,
    volume: isVolume(record.volume) ? Math.round(record.volume) : base.volume,
  };
}

/** Keeps only the fields a caller actually set, and only well-formed ones. */
export function parseNotificationSettingsPatch(value: unknown): Partial<NotificationSettings> {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
    ...(typeof record.sound === "boolean" ? { sound: record.sound } : {}),
    ...(isTone(record.tone) ? { tone: record.tone } : {}),
    ...(isVolume(record.volume) ? { volume: Math.round(record.volume) } : {}),
  };
}
