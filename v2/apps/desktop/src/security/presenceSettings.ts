import { readFile } from "node:fs/promises";

import { type KeychainCodec, protectWithKeychain, protectWithPresence } from "./secretsKey.js";
import { isPresenceSealed, type UserPresence } from "./userPresence.js";

import type { PresenceStatus } from "./presenceStatus.js";

export type PresenceSettingsDeps = {
  /** The Hello layer, or undefined off Windows. */
  presence: UserPresence | undefined;
  codec: KeychainCodec;
  path: string;
  /** The key unlocked at launch, if any; it stays in this process. */
  key: () => string | undefined;
};

export function presenceSettings(deps: PresenceSettingsDeps) {
  const sealed = async () => {
    const file = await readFile(deps.path).catch(() => undefined);
    return file !== undefined && isPresenceSealed(file);
  };
  const status = async (error?: string): Promise<PresenceStatus> => {
    const result: PresenceStatus = !deps.presence
      ? { status: "unsupported" }
      : (await sealed())
        ? { status: "on" }
        : (await deps.presence.available().catch(() => false))
          ? { status: "off" }
          : { status: "unavailable" };
    return error ? { ...result, error } : result;
  };
  return {
    status: () => status(),
    turnOn: async (): Promise<PresenceStatus> => {
      const key = deps.key();
      if (!deps.presence) return status();
      if (!key) return status("Connected apps are locked on this launch. Restart ZLI and try again.");
      if (await protectWithPresence(deps.path, key, deps.presence)) return status();
      return status("Windows Hello didn't confirm it was you, so this stays off.");
    },
    turnOff: async (): Promise<PresenceStatus> => {
      const key = deps.key();
      if (!key) return status("Unlock connected apps with Windows Hello first: restart ZLI and confirm the prompt.");
      if (await protectWithKeychain(deps.path, key, deps.codec)) return status();
      return status("Couldn't save the key with the Windows keychain, so this stays on.");
    },
  };
}

export type PresenceSettings = ReturnType<typeof presenceSettings>;

type IpcMainLike = { handle(channel: string, listener: (...args: unknown[]) => unknown): void };

export function registerPresenceIpc(ipcMain: IpcMainLike, settings: PresenceSettings): void {
  ipcMain.handle("zli:security:presence-status", () => settings.status());
  ipcMain.handle("zli:security:presence-on", () => settings.turnOn());
  ipcMain.handle("zli:security:presence-off", () => settings.turnOff());
}
