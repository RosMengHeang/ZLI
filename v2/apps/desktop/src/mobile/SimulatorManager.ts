import {
  type MobileDevice,
  type MobileSimDeviceType,
  MobileSimDeviceTypeId,
  type MobileSimRuntime,
  MobileSimRuntimeId,
  MobileSimUdid,
  type MobileSimulatorCatalog,
  type MobileSimulatorCreated,
  MobileSimulatorCreateInput,
  MobileSimulatorDeleteInput,
} from "@zli-v2/contracts";

import type { IosTools } from "./IosSimulatorDriver.js";
import { MobileDriverError } from "./MobileDriver.js";
import { type ProcessRunner, runChecked, withDefaultEnv } from "./ProcessRunner.js";

export const SIMCTL_CATALOG_ARGS: readonly string[] = ["simctl", "list", "-j", "devicetypes", "runtimes"];

export function simctlCreateArgs(name: string, deviceTypeId: string, runtimeId: string): string[] {
  return ["simctl", "create", name, deviceTypeId, runtimeId];
}

export function simctlDeleteArgs(udid: string): string[] {
  return ["simctl", "delete", udid];
}

type RawDeviceType = {
  identifier?: unknown;
  name?: unknown;
  productFamily?: unknown;
  minRuntimeVersionString?: unknown;
  maxRuntimeVersionString?: unknown;
};

type RawRuntime = {
  identifier?: unknown;
  name?: unknown;
  version?: unknown;
  platform?: unknown;
  isAvailable?: unknown;
  supportedDeviceTypes?: unknown;
};

/** 17.5 is before 18.0; missing parts count as zero. */
function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function family(entry: RawDeviceType): MobileSimDeviceType["family"] | undefined {
  const value = typeof entry.productFamily === "string" ? entry.productFamily : "";
  if (value === "iPhone" || value === "iPad") return value;
  if (value) return undefined;
  const name = typeof entry.name === "string" ? entry.name : "";
  return name.startsWith("iPhone") ? "iPhone" : name.startsWith("iPad") ? "iPad" : undefined;
}

/**
 * Parses `xcrun simctl list -j devicetypes runtimes` into iPhone and iPad models and the iOS runtimes that can run.
 * A runtime's supportedDeviceTypes decides which models it offers; older Xcode versions leave that out, and then
 * each model's own minimum and maximum iOS version decide.
 */
export function parseSimctlCatalog(json: string): Omit<MobileSimulatorCatalog, "simctl"> {
  const parsed = JSON.parse(json) as { devicetypes?: unknown; runtimes?: unknown };
  const rawTypes = Array.isArray(parsed.devicetypes) ? (parsed.devicetypes as RawDeviceType[]) : [];
  const types: Array<MobileSimDeviceType & { min?: string; max?: string }> = [];
  for (const entry of rawTypes) {
    const id = MobileSimDeviceTypeId.safeParse(entry.identifier);
    const kind = family(entry);
    if (!id.success || !kind || typeof entry.name !== "string" || !entry.name.trim()) continue;
    types.push({
      id: id.data,
      name: entry.name.trim().slice(0, 200),
      family: kind,
      ...(typeof entry.minRuntimeVersionString === "string" ? { min: entry.minRuntimeVersionString } : {}),
      ...(typeof entry.maxRuntimeVersionString === "string" ? { max: entry.maxRuntimeVersionString } : {}),
    });
  }

  const rawRuntimes = Array.isArray(parsed.runtimes) ? (parsed.runtimes as RawRuntime[]) : [];
  const runtimes: MobileSimRuntime[] = [];
  for (const entry of rawRuntimes) {
    const id = MobileSimRuntimeId.safeParse(entry.identifier);
    if (!id.success || entry.isAvailable === false) continue;
    const ios = entry.platform === "iOS" || (entry.platform === undefined && /\.SimRuntime\.iOS-/u.test(id.data));
    if (!ios) continue;
    const version =
      typeof entry.version === "string"
        ? entry.version
        : (/\.iOS-(\d+(?:-\d+)*)$/u.exec(id.data)?.[1]?.replaceAll("-", ".") ?? "");
    let supported: readonly string[];
    if (Array.isArray(entry.supportedDeviceTypes)) {
      const listed = new Set(
        (entry.supportedDeviceTypes as Array<{ identifier?: unknown }>)
          .map((type) => type?.identifier)
          .filter((value): value is string => typeof value === "string"),
      );
      supported = types.filter((type) => listed.has(type.id)).map((type) => type.id);
    } else {
      supported = types
        .filter(
          (type) =>
            !version ||
            ((!type.min || compareVersions(version, type.min) >= 0) &&
              (!type.max || compareVersions(version, type.max) <= 0)),
        )
        .map((type) => type.id);
    }
    if (supported.length === 0) continue;
    runtimes.push({
      id: id.data,
      name: (typeof entry.name === "string" && entry.name.trim()) || `iOS ${version}`,
      version: version.slice(0, 50),
      deviceTypeIds: [...supported],
    });
  }
  runtimes.sort((left, right) => compareVersions(left.version, right.version));
  return { deviceTypes: types.map(({ id, name, family: kind }) => ({ id, name, family: kind })), runtimes };
}

export type SimulatorManagerDeps = {
  readonly runner: ProcessRunner;
  /** The environment for simctl, without ZLI's runtime secrets. */
  readonly env: NodeJS.ProcessEnv;
  readonly tools: () => Promise<IosTools>;
  /** The iOS simulators the device list knows, to refuse a taken name or deleting one that runs. */
  devices(): Promise<readonly Pick<MobileDevice, "deviceId" | "name" | "state" | "platform">[]>;
  /** Runs after a simulator is created or deleted, so device lists pick up the change. */
  onChange(): Promise<void> | void;
};

/** Creates and deletes iPhone and iPad simulators with simctl, from the models and iOS versions Xcode has. */
export class SimulatorManager {
  readonly #deps: SimulatorManagerDeps;
  readonly #runner: ProcessRunner;
  #busy = false;

  constructor(deps: SimulatorManagerDeps) {
    this.#deps = deps;
    this.#runner = withDefaultEnv(deps.runner, deps.env);
  }

  async list(): Promise<MobileSimulatorCatalog> {
    const { xcrun } = await this.#deps.tools();
    if (!xcrun) return { simctl: false, deviceTypes: [], runtimes: [] };
    return { simctl: true, ...(await this.#catalog(xcrun)) };
  }

  async create(input: unknown): Promise<MobileSimulatorCreated> {
    const { name, deviceTypeId, runtimeId } = MobileSimulatorCreateInput.parse(input);
    return this.#change(async (xcrun) => {
      const catalog = await this.#catalog(xcrun);
      const runtime = catalog.runtimes.find((entry) => entry.id === runtimeId);
      if (!runtime)
        throw new MobileDriverError(
          "That iOS version is not installed on this Mac. Add it in Xcode under Settings > Components.",
        );
      const type = catalog.deviceTypes.find((entry) => entry.id === deviceTypeId);
      if (!type) throw new MobileDriverError("Xcode does not know that iPhone or iPad model.");
      if (!runtime.deviceTypeIds.includes(type.id))
        throw new MobileDriverError(`${runtime.name} cannot run ${type.name}. Pick another iOS version.`);
      // simctl allows two simulators with one name, but rotation finds the Simulator window by name.
      if ((await this.#simulators()).some((device) => device.name.toLowerCase() === name.toLowerCase()))
        throw new MobileDriverError(`A simulator named ${name} already exists.`, 409);
      const result = await runChecked(this.#runner, xcrun, simctlCreateArgs(name, type.id, runtime.id), {
        timeoutMs: 120_000,
      });
      const udid = MobileSimUdid.safeParse(result.stdout.toString("utf8").trim());
      if (!udid.success) throw new MobileDriverError("simctl created the simulator but did not say its id.", 502);
      return { deviceId: `ios:${udid.data}`, name };
    });
  }

  async delete(input: unknown): Promise<{ accepted: true }> {
    const { udid } = MobileSimulatorDeleteInput.parse(input);
    return this.#change(async (xcrun) => {
      const deviceId = `ios:${udid}`;
      const device = (await this.#simulators()).find(
        (entry) => entry.deviceId.toLowerCase() === deviceId.toLowerCase(),
      );
      if (!device) throw new MobileDriverError("That simulator is not on this Mac anymore.", 404);
      if (device.state !== "shutdown") throw new MobileDriverError(`Shut down ${device.name} before deleting it.`, 409);
      await runChecked(this.#runner, xcrun, simctlDeleteArgs(udid), { timeoutMs: 60_000 });
      return { accepted: true as const };
    });
  }

  async #change<T>(work: (xcrun: string) => Promise<T>): Promise<T> {
    if (this.#busy) throw new MobileDriverError("Another simulator change is still running.", 409);
    const { xcrun } = await this.#deps.tools();
    if (!xcrun) throw new MobileDriverError("iPhone simulators need a Mac with Xcode installed.", 409);
    this.#busy = true;
    try {
      return await work(xcrun);
    } finally {
      this.#busy = false;
      await this.#deps.onChange();
    }
  }

  async #catalog(xcrun: string): Promise<Omit<MobileSimulatorCatalog, "simctl">> {
    const result = await runChecked(this.#runner, xcrun, SIMCTL_CATALOG_ARGS, { timeoutMs: 30_000 });
    try {
      return parseSimctlCatalog(result.stdout.toString("utf8"));
    } catch {
      throw new MobileDriverError("simctl listed the simulator models in a form ZLI could not read.", 502);
    }
  }

  async #simulators() {
    return (await this.#deps.devices()).filter((device) => device.platform === "ios");
  }
}
