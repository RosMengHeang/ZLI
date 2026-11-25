import { useSyncExternalStore } from "react";

/**
 * The notification sounds. ZLI plays them itself, with the system notification kept silent: the built-in ones
 * are drawn with Web Audio, so no sound files ship with the app, and "custom" is a file the person added.
 */
export type NotificationTone = "chime" | "ping" | "pop" | "bell" | "soft" | "custom";

export const DEFAULT_NOTIFICATION_TONE: NotificationTone = "chime";

export const NOTIFICATION_TONES: readonly { value: NotificationTone; label: string }[] = [
  { value: "chime", label: "Chime" },
  { value: "ping", label: "Ping" },
  { value: "pop", label: "Pop" },
  { value: "bell", label: "Bell" },
  { value: "soft", label: "Soft" },
  { value: "custom", label: "Your own sound" },
];

const CUSTOM_KEY = "zli.notificationSound.custom";
/** A sound file stays small: it is kept on this computer beside the other settings. */
export const MAX_CUSTOM_SOUND_BYTES = 1024 * 1024;

export type CustomSound = { name: string; dataUrl: string };

let customCache: CustomSound | null | undefined;
const customListeners = new Set<() => void>();

export function readCustomSound(): CustomSound | null {
  if (customCache !== undefined) return customCache;
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(CUSTOM_KEY) ?? "null");
    const record = value as Partial<CustomSound> | null;
    customCache =
      record &&
      typeof record.name === "string" &&
      typeof record.dataUrl === "string" &&
      record.dataUrl.startsWith("data:audio/")
        ? { name: record.name, dataUrl: record.dataUrl }
        : null;
  } catch {
    customCache = null;
  }
  return customCache;
}

function setCustomSound(next: CustomSound | null) {
  if (next) window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
  else window.localStorage.removeItem(CUSTOM_KEY);
  customCache = next;
  for (const listener of customListeners) listener();
}

/** Reads an audio file into the saved sound. Says what is wrong when it is not audio or is too big. */
export async function saveCustomSound(file: File): Promise<void> {
  if (!file.type.startsWith("audio/")) throw new Error("Pick an audio file, such as MP3, WAV, or OGG.");
  if (file.size > MAX_CUSTOM_SOUND_BYTES) throw new Error("Pick a sound under 1 MB. A short clip works best.");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
  try {
    setCustomSound({ name: file.name, dataUrl });
  } catch {
    throw new Error("There is no room to keep this sound. Try a shorter one.");
  }
}

export function clearCustomSound() {
  try {
    setCustomSound(null);
  } catch {
    customCache = null;
  }
}

export function useCustomSound(): CustomSound | null {
  return useSyncExternalStore(
    (listener) => {
      customListeners.add(listener);
      return () => customListeners.delete(listener);
    },
    readCustomSound,
    () => null,
  );
}

export function isNotificationTone(value: unknown): value is NotificationTone {
  return NOTIFICATION_TONES.some((tone) => tone.value === value);
}

/** One note: a frequency, when it starts and how long it rings, in seconds, and its loudness from 0 to 1. */
type Note = { frequency: number; at: number; length: number; level: number; wave?: OscillatorType; slideTo?: number };

/** The notes of each sound. The first reaches its peak at once, then every note fades out on its own. */
export const TONE_NOTES: Record<Exclude<NotificationTone, "custom">, readonly Note[]> = {
  // Two rising notes, a major fourth apart.
  chime: [
    { frequency: 659.25, at: 0, length: 0.35, level: 0.6 },
    { frequency: 880, at: 0.12, length: 0.5, level: 0.55 },
  ],
  // One short, high note.
  ping: [{ frequency: 1318.5, at: 0, length: 0.3, level: 0.5 }],
  // A quick drop in pitch, like a bubble.
  pop: [{ frequency: 620, at: 0, length: 0.12, level: 0.7, wave: "triangle", slideTo: 260 }],
  // A struck bell: the note and two quieter overtones that ring longer.
  bell: [
    { frequency: 880, at: 0, length: 1.1, level: 0.5 },
    { frequency: 880 * 2.76, at: 0, length: 0.6, level: 0.12 },
    { frequency: 880 * 5.4, at: 0, length: 0.3, level: 0.05 },
  ],
  // Two low, gentle notes for quiet rooms.
  soft: [
    { frequency: 523.25, at: 0, length: 0.45, level: 0.45 },
    { frequency: 659.25, at: 0.16, length: 0.6, level: 0.4 },
  ],
};

let context: AudioContext | undefined;

/** Plays a sound at `volume` (0 to 100). Quietly does nothing without audio. */
export function playNotificationTone(tone: NotificationTone, volume: number): void {
  if (volume <= 0) return;
  if (tone === "custom") {
    const sound = readCustomSound();
    if (!sound || typeof Audio === "undefined") return;
    const audio = new Audio(sound.dataUrl);
    audio.volume = Math.min(1, Math.max(0, volume / 100));
    void audio.play().catch(() => undefined);
    return;
  }
  const Context = typeof window === "undefined" ? undefined : window.AudioContext;
  if (!Context) return;
  try {
    context ??= new Context();
    if (context.state === "suspended") void context.resume();
    const start = context.currentTime + 0.02;
    const master = context.createGain();
    master.gain.value = Math.min(1, Math.max(0, volume / 100)) * 0.5;
    master.connect(context.destination);
    for (const note of TONE_NOTES[tone]) {
      const oscillator = context.createOscillator();
      oscillator.type = note.wave ?? "sine";
      const begin = start + note.at;
      oscillator.frequency.setValueAtTime(note.frequency, begin);
      if (note.slideTo) oscillator.frequency.exponentialRampToValueAtTime(note.slideTo, begin + note.length);
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, begin);
      gain.gain.exponentialRampToValueAtTime(note.level, begin + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, begin + note.length);
      oscillator.connect(gain).connect(master);
      oscillator.start(begin);
      oscillator.stop(begin + note.length + 0.05);
    }
  } catch {
    // A missing audio device must not break the notification.
  }
}
