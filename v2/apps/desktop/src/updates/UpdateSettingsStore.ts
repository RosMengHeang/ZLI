import { readFile } from "node:fs/promises";

import { writeJsonFile } from "../storage/writeJsonFile.js";

const MAX_NOTES = 50_000;
const VERSION = /^\d+\.\d+\.\d+$/u;

export type UpdateSettings = {
  /** Download updates in the background and install them on the next restart. */
  autoInstall: boolean;
  /** The version the person last opened, so What's new shows once after an update. */
  lastSeenVersion?: string;
  /** The newest release this install was offered, kept so its notes can be shown after updating. */
  offered?: { version: string; notes?: string };
};

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = { autoInstall: true };

/** Reads stored settings. Unknown or malformed fields fall back to `base`. */
export function parseUpdateSettings(value: unknown, base: UpdateSettings = DEFAULT_UPDATE_SETTINGS): UpdateSettings {
  if (typeof value !== "object" || value === null) return { ...base };
  const record = value as Record<string, unknown>;
  const lastSeenVersion =
    typeof record.lastSeenVersion === "string" && VERSION.test(record.lastSeenVersion)
      ? record.lastSeenVersion
      : base.lastSeenVersion;
  const offered = parseOffered(record.offered) ?? base.offered;
  return {
    autoInstall: typeof record.autoInstall === "boolean" ? record.autoInstall : base.autoInstall,
    ...(lastSeenVersion ? { lastSeenVersion } : {}),
    ...(offered ? { offered } : {}),
  };
}

function parseOffered(value: unknown): UpdateSettings["offered"] {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, notes } = value as Record<string, unknown>;
  if (typeof version !== "string" || !VERSION.test(version)) return undefined;
  return { version, ...(typeof notes === "string" && notes ? { notes: notes.slice(0, MAX_NOTES) } : {}) };
}

/** Update settings kept in a small JSON file beside the app's other per-user state. */
export class UpdateSettingsStore {
  private settings: UpdateSettings = { ...DEFAULT_UPDATE_SETTINGS };
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  current(): UpdateSettings {
    return { ...this.settings };
  }

  async load(): Promise<UpdateSettings> {
    try {
      this.settings = parseUpdateSettings(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      // A missing or unreadable file means the defaults.
      this.settings = { ...DEFAULT_UPDATE_SETTINGS };
    }
    return this.current();
  }

  async update(patch: Partial<UpdateSettings>): Promise<UpdateSettings> {
    this.settings = parseUpdateSettings(patch, this.settings);
    const snapshot = this.current();
    // Writes go one at a time because they share one temporary file.
    const write = this.writing.then(() => writeJsonFile(this.path, snapshot));
    this.writing = write.catch(() => undefined);
    await write;
    return snapshot;
  }
}
