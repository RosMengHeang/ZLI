import { describe, expect, it, vi } from "vitest";

import { FakeProcessRunner } from "./FakeProcessRunner.js";
import {
  parseSimctlCatalog,
  SIMCTL_CATALOG_ARGS,
  SimulatorManager,
  simctlCreateArgs,
  simctlDeleteArgs,
} from "./SimulatorManager.js";

const TYPE = "com.apple.CoreSimulator.SimDeviceType.";
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.";
const UDID = "5A3F2C1D-1111-4222-8333-944455556666";

const CATALOG = {
  devicetypes: [
    { identifier: `${TYPE}iPhone-15`, name: "iPhone 15", productFamily: "iPhone", minRuntimeVersionString: "17.0.0" },
    { identifier: `${TYPE}iPhone-16-Pro`, name: "iPhone 16 Pro", productFamily: "iPhone" },
    { identifier: `${TYPE}iPad-Air-11-inch-M2`, name: "iPad Air 11-inch (M2)", productFamily: "iPad" },
    {
      identifier: `${TYPE}Apple-Watch-Series-10-46mm`,
      name: "Apple Watch Series 10 (46mm)",
      productFamily: "Apple Watch",
    },
    { identifier: `${TYPE}Apple-TV-4K-3rd-generation-4K`, name: "Apple TV 4K", productFamily: "Apple TV" },
  ],
  runtimes: [
    {
      identifier: `${RUNTIME}iOS-18-2`,
      name: "iOS 18.2",
      version: "18.2",
      platform: "iOS",
      isAvailable: true,
      supportedDeviceTypes: [
        { identifier: `${TYPE}iPhone-15` },
        { identifier: `${TYPE}iPhone-16-Pro` },
        { identifier: `${TYPE}iPad-Air-11-inch-M2` },
      ],
    },
    {
      identifier: `${RUNTIME}iOS-17-5`,
      name: "iOS 17.5",
      version: "17.5",
      platform: "iOS",
      isAvailable: true,
      supportedDeviceTypes: [{ identifier: `${TYPE}iPhone-15` }, { identifier: `${TYPE}iPad-Air-11-inch-M2` }],
    },
    {
      identifier: `${RUNTIME}iOS-16-4`,
      name: "iOS 16.4",
      version: "16.4",
      platform: "iOS",
      isAvailable: false,
      availabilityError: "The runtime bundle could not be found.",
      supportedDeviceTypes: [{ identifier: `${TYPE}iPhone-15` }],
    },
    {
      identifier: `${RUNTIME}watchOS-11-2`,
      name: "watchOS 11.2",
      version: "11.2",
      platform: "watchOS",
      isAvailable: true,
      supportedDeviceTypes: [{ identifier: `${TYPE}Apple-Watch-Series-10-46mm` }],
    },
  ],
};

describe("parseSimctlCatalog", () => {
  it("keeps iPhone and iPad models and the iOS runtimes that can run, oldest first", () => {
    const catalog = parseSimctlCatalog(JSON.stringify(CATALOG));
    expect(catalog.deviceTypes).toEqual([
      { id: `${TYPE}iPhone-15`, name: "iPhone 15", family: "iPhone" },
      { id: `${TYPE}iPhone-16-Pro`, name: "iPhone 16 Pro", family: "iPhone" },
      { id: `${TYPE}iPad-Air-11-inch-M2`, name: "iPad Air 11-inch (M2)", family: "iPad" },
    ]);
    expect(catalog.runtimes).toEqual([
      {
        id: `${RUNTIME}iOS-17-5`,
        name: "iOS 17.5",
        version: "17.5",
        deviceTypeIds: [`${TYPE}iPhone-15`, `${TYPE}iPad-Air-11-inch-M2`],
      },
      {
        id: `${RUNTIME}iOS-18-2`,
        name: "iOS 18.2",
        version: "18.2",
        deviceTypeIds: [`${TYPE}iPhone-15`, `${TYPE}iPhone-16-Pro`, `${TYPE}iPad-Air-11-inch-M2`],
      },
    ]);
  });

  it("falls back to each model's own iOS range when a runtime does not list its device types", () => {
    const catalog = parseSimctlCatalog(
      JSON.stringify({
        devicetypes: [
          { identifier: `${TYPE}iPhone-8`, name: "iPhone 8", maxRuntimeVersionString: "16.99.99" },
          { identifier: `${TYPE}iPhone-15`, name: "iPhone 15", minRuntimeVersionString: "17.0.0" },
          { identifier: "not.a.device.type", name: "Broken" },
        ],
        runtimes: [{ identifier: `${RUNTIME}iOS-16-4`, name: "iOS 16.4", version: "16.4", isAvailable: true }],
      }),
    );
    expect(catalog.deviceTypes.map((type) => type.name)).toEqual(["iPhone 8", "iPhone 15"]);
    expect(catalog.runtimes).toEqual([
      { id: `${RUNTIME}iOS-16-4`, name: "iOS 16.4", version: "16.4", deviceTypeIds: [`${TYPE}iPhone-8`] },
    ]);
  });

  it("drops runtimes that can run none of the models", () => {
    const catalog = parseSimctlCatalog(JSON.stringify({ devicetypes: [], runtimes: [CATALOG.runtimes[0]] }));
    expect(catalog).toEqual({ deviceTypes: [], runtimes: [] });
  });
});

function simctl(options: { createOut?: string; createError?: string } = {}) {
  return new FakeProcessRunner((command, args) => {
    if (command !== "/usr/bin/xcrun") return undefined;
    if (args.join(" ") === SIMCTL_CATALOG_ARGS.join(" ")) return { stdout: JSON.stringify(CATALOG) };
    if (args[1] === "create")
      return options.createError
        ? { code: 1, stderr: options.createError }
        : { stdout: options.createOut ?? `${UDID}\n` };
    return undefined;
  });
}

function manager(
  runner: FakeProcessRunner,
  devices: Array<{ deviceId: string; name: string; state: "shutdown" | "online"; platform: "ios" | "android" }> = [],
  xcrun: string | null = "/usr/bin/xcrun",
) {
  const onChange = vi.fn(async () => undefined);
  const simulators = new SimulatorManager({
    runner,
    env: { PATH: "/usr/bin" },
    tools: async () => (xcrun ? { xcrun } : {}),
    devices: async () => devices,
    onChange,
  });
  return { simulators, onChange };
}

describe("SimulatorManager", () => {
  it("lists the catalog, or says simctl is missing without running anything", async () => {
    const runner = simctl();
    expect((await manager(runner).simulators.list()).runtimes.map((runtime) => runtime.name)).toEqual([
      "iOS 17.5",
      "iOS 18.2",
    ]);
    expect(runner.argsOf("xcrun")).toEqual([[...SIMCTL_CATALOG_ARGS]]);
    expect(runner.calls[0]?.options?.env).toEqual({ PATH: "/usr/bin" });

    const none = simctl();
    expect(await manager(none, [], null).simulators.list()).toEqual({ simctl: false, deviceTypes: [], runtimes: [] });
    expect(none.calls).toEqual([]);
  });

  it("creates a simulator from a listed model and iOS version, passing the name as one argument", async () => {
    const runner = simctl();
    const { simulators, onChange } = manager(runner);
    const created = await simulators.create({
      name: "Checkout iPhone (16 Pro)",
      deviceTypeId: `${TYPE}iPhone-16-Pro`,
      runtimeId: `${RUNTIME}iOS-18-2`,
    });
    expect(created).toEqual({ deviceId: `ios:${UDID}`, name: "Checkout iPhone (16 Pro)" });
    expect(runner.argsOf("xcrun").at(-1)).toEqual(
      simctlCreateArgs("Checkout iPhone (16 Pro)", `${TYPE}iPhone-16-Pro`, `${RUNTIME}iOS-18-2`),
    );
    expect(simctlCreateArgs("a", "b", "c")).toEqual(["simctl", "create", "a", "b", "c"]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("refuses models, versions, and names that are not on the lists before running simctl create", async () => {
    const runner = simctl();
    const { simulators } = manager(runner, [
      { deviceId: "ios:AAAA", name: "iPhone 15", state: "shutdown", platform: "ios" },
    ]);
    await expect(
      simulators.create({ name: "Old", deviceTypeId: `${TYPE}iPhone-15`, runtimeId: `${RUNTIME}iOS-16-4` }),
    ).rejects.toThrow("That iOS version is not installed on this Mac.");
    await expect(
      simulators.create({ name: "New", deviceTypeId: `${TYPE}iPhone-16-Pro`, runtimeId: `${RUNTIME}iOS-17-5` }),
    ).rejects.toThrow("iOS 17.5 cannot run iPhone 16 Pro. Pick another iOS version.");
    await expect(
      simulators.create({
        name: "Watch",
        deviceTypeId: `${TYPE}Apple-Watch-Series-10-46mm`,
        runtimeId: `${RUNTIME}iOS-18-2`,
      }),
    ).rejects.toThrow("Xcode does not know that iPhone or iPad model.");
    await expect(
      simulators.create({ name: "iphone 15", deviceTypeId: `${TYPE}iPhone-15`, runtimeId: `${RUNTIME}iOS-18-2` }),
    ).rejects.toThrow("A simulator named iphone 15 already exists.");
    await expect(
      simulators.create({ name: "-x; rm -rf ~", deviceTypeId: `${TYPE}iPhone-15`, runtimeId: `${RUNTIME}iOS-18-2` }),
    ).rejects.toThrow();
    await expect(
      simulators.create({ name: "Phone", deviceTypeId: `${TYPE}iPhone-15 --help`, runtimeId: `${RUNTIME}iOS-18-2` }),
    ).rejects.toThrow();
    expect(runner.argsOf("xcrun").filter((args) => args[1] === "create")).toEqual([]);
  });

  it("reports simctl's own reason when create fails", async () => {
    const { simulators, onChange } = manager(simctl({ createError: "Invalid runtime: not enough disk space" }));
    await expect(
      simulators.create({ name: "Phone", deviceTypeId: `${TYPE}iPhone-15`, runtimeId: `${RUNTIME}iOS-18-2` }),
    ).rejects.toThrow("xcrun simctl failed: Invalid runtime: not enough disk space");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("explains that simulators need Xcode when xcrun is missing", async () => {
    const { simulators } = manager(simctl(), [], null);
    await expect(
      simulators.create({ name: "Phone", deviceTypeId: `${TYPE}iPhone-15`, runtimeId: `${RUNTIME}iOS-18-2` }),
    ).rejects.toThrow("iPhone simulators need a Mac with Xcode installed.");
  });

  it("deletes a shut down simulator and refuses one that runs or is gone", async () => {
    const runner = simctl();
    const { simulators } = manager(runner, [
      { deviceId: `ios:${UDID}`, name: "Spare", state: "shutdown", platform: "ios" },
      { deviceId: "ios:6B4E3D2C-1111-4222-8333-944455556666", name: "Busy", state: "online", platform: "ios" },
    ]);
    expect(await simulators.delete({ udid: UDID })).toEqual({ accepted: true });
    expect(runner.argsOf("xcrun").at(-1)).toEqual(simctlDeleteArgs(UDID));
    await expect(simulators.delete({ udid: "6B4E3D2C-1111-4222-8333-944455556666" })).rejects.toThrow(
      "Shut down Busy before deleting it.",
    );
    await expect(simulators.delete({ udid: "00000000-1111-4222-8333-944455556666" })).rejects.toThrow(
      "That simulator is not on this Mac anymore.",
    );
    await expect(simulators.delete({ udid: "all" })).rejects.toThrow();
    expect(runner.argsOf("xcrun").filter((args) => args[1] === "delete")).toHaveLength(1);
  });
});
