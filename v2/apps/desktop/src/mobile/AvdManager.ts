import {
  type MobileAvdList,
  MobileAvdCreateInput as AvdCreateInput,
  MobileAvdDeleteInput as AvdDeleteInput,
} from "@zli-v2/contracts";

import { DEFAULT_AVD_DEVICE } from "./AndroidRepository.js";
import { type AndroidEnvironment, type AndroidInspection, avdCreateArgs, sdkToolEnv } from "./AndroidSetup.js";
import { MobileDriverError } from "./MobileDriver.js";
import { runChecked } from "./ProcessRunner.js";

/** Pixel hardware profiles worth offering when this avdmanager knows them, in the order they are listed. */
export const COMMON_DEVICE_PROFILES: readonly string[] = [
  "pixel_9",
  "pixel_9_pro",
  "pixel_8",
  "pixel_8_pro",
  "pixel_7",
  "pixel_7_pro",
  "pixel_6",
  "pixel_fold",
  "pixel_tablet",
];

export function avdDeleteArgs(name: string): string[] {
  return ["delete", "avd", "-n", name];
}

/** `avdmanager list device -c` prints one profile id per line, after any loading or warning lines. */
export function parseDeviceProfileIds(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9_.-]+$/u.test(line));
}

/** pixel_7_pro becomes "Pixel 7 Pro". */
export function deviceProfileName(id: string): string {
  return id
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** The default profile first, then the common Pixel profiles this avdmanager knows. */
export function deviceProfiles(knownIds: readonly string[]): MobileAvdList["deviceProfiles"] {
  const known = new Set(knownIds);
  const ids = [
    DEFAULT_AVD_DEVICE,
    ...COMMON_DEVICE_PROFILES.filter((id) => id !== DEFAULT_AVD_DEVICE && known.has(id)),
  ];
  return ids.map((id) => ({ id, name: deviceProfileName(id) }));
}

export type AvdManagerDeps = {
  readonly environment: AndroidEnvironment;
  /** Whether the AVD's emulator is booting or running. */
  isRunning(name: string): Promise<boolean>;
  /** Runs after a device is created or deleted, so device lists pick up the change. */
  onChange(): Promise<void> | void;
  setupRunning?(): boolean;
};

/**
 * Creates and deletes Android virtual devices with avdmanager. Devices are made only from system images that
 * are already installed, so nothing here downloads.
 */
export class AvdManager {
  readonly #deps: AvdManagerDeps;
  #profiles: { tool: string; ids: Promise<string[]> } | undefined;
  #busy = false;

  constructor(deps: AvdManagerDeps) {
    this.#deps = deps;
  }

  async list(): Promise<MobileAvdList> {
    return this.#describe(await this.#deps.environment.inspect());
  }

  async create(input: unknown): Promise<MobileAvdList> {
    const { name, systemImage, device } = AvdCreateInput.parse(input);
    return this.#change(async (inspection) => {
      if (!inspection.systemImages.includes(systemImage))
        throw new MobileDriverError(
          `${systemImage} is not installed. ZLI creates virtual devices only from installed system images.`,
        );
      if (inspection.avds.some((avd) => avd.name.toLowerCase() === name.toLowerCase()))
        throw new MobileDriverError(`A virtual device named ${name} already exists.`, 409);
      return {
        args: avdCreateArgs(name, systemImage, device ?? DEFAULT_AVD_DEVICE),
        // avdmanager asks whether to create a custom hardware profile; the device definition already has one.
        input: "no\n",
        timeoutMs: 120_000,
      };
    });
  }

  async delete(input: unknown): Promise<MobileAvdList> {
    const { name } = AvdDeleteInput.parse(input);
    return this.#change(async (inspection) => {
      const avd = inspection.avds.find((entry) => entry.name === name);
      if (!avd) throw new MobileDriverError(`There is no virtual device named ${name}.`, 404);
      if (await this.#deps.isRunning(name))
        throw new MobileDriverError(`Shut down ${avd.displayName} before deleting it.`, 409);
      return { args: avdDeleteArgs(name), timeoutMs: 60_000 };
    });
  }

  /** Checks the request against what is installed, then runs avdmanager once and refreshes the device lists. */
  async #change(
    check: (inspection: AndroidInspection) => Promise<{ args: string[]; input?: string; timeoutMs: number }>,
  ): Promise<MobileAvdList> {
    if (this.#busy) throw new MobileDriverError("Another virtual device change is still running.", 409);
    if (this.#deps.setupRunning?.()) throw new MobileDriverError("Wait for Android setup to finish.", 409);
    this.#busy = true;
    try {
      const inspection = await this.#deps.environment.inspect();
      const avdmanager = inspection.layout.avdmanager;
      if (!avdmanager)
        throw new MobileDriverError("avdmanager is not installed. Set up the Android emulator first.", 409);
      const { args, ...options } = await check(inspection);
      try {
        await runChecked(this.#deps.environment.deps.runner, avdmanager, args, {
          ...options,
          env: this.#env(inspection),
        });
      } finally {
        // A failed create can still leave files behind, so the lists are reread either way.
        await this.#deps.onChange();
      }
      return await this.list();
    } finally {
      this.#busy = false;
    }
  }

  async #describe(inspection: AndroidInspection): Promise<MobileAvdList> {
    const avdmanager = inspection.layout.avdmanager;
    return {
      avdmanager: Boolean(avdmanager),
      avds: inspection.avds.map((avd) => ({
        name: avd.name,
        displayName: avd.displayName,
        ...(avd.systemImage ? { systemImage: avd.systemImage } : {}),
      })),
      systemImages: [...inspection.systemImages],
      deviceProfiles: deviceProfiles(avdmanager ? await this.#profileIds(avdmanager, inspection) : []),
      defaultDeviceProfile: DEFAULT_AVD_DEVICE,
    };
  }

  /**
   * avdmanager starts a JVM, so its profile list is read once per tool and kept. A failed listing is kept
   * too, falling back to the default profile, so a broken avdmanager is not rerun on every refresh.
   */
  #profileIds(avdmanager: string, inspection: AndroidInspection): Promise<string[]> {
    if (this.#profiles?.tool !== avdmanager) {
      const ids = runChecked(this.#deps.environment.deps.runner, avdmanager, ["list", "device", "-c"], {
        env: this.#env(inspection),
        timeoutMs: 60_000,
      }).then(
        (result) => parseDeviceProfileIds(result.stdout.toString("utf8")),
        () => [],
      );
      this.#profiles = { tool: avdmanager, ids };
    }
    return this.#profiles.ids;
  }

  #env(inspection: AndroidInspection): NodeJS.ProcessEnv {
    const { env, os } = this.#deps.environment.deps;
    return sdkToolEnv(env, os, inspection.layout.root, inspection.java);
  }
}
