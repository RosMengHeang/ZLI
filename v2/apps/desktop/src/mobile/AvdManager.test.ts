import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AndroidEnvironment } from "./AndroidSetup.js";
import { AvdManager, avdDeleteArgs, deviceProfileName, deviceProfiles, parseDeviceProfileIds } from "./AvdManager.js";
import { FakeProcessRunner } from "./FakeProcessRunner.js";
import { nodeMobileFileSystem } from "./host.js";

const IMAGE = "system-images;android-35;google_apis;x86_64";
const PROFILE_LIST = [
  "Loading local repository...",
  "[=========                              ] 25% Loading local repository...",
  "automotive_1024p_landscape",
  "pixel_6",
  "pixel_7",
  "pixel_8",
  "pixel_9_pro",
  "",
].join("\n");

let root: string;
let avdHome: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zli-avd-manager-"));
  avdHome = join(root, "avd");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function writeAvd(name: string, displayName: string) {
  mkdirSync(join(avdHome, `${name}.avd`), { recursive: true });
  writeFileSync(join(avdHome, `${name}.ini`), `path=${join(avdHome, `${name}.avd`)}\n`);
  writeFileSync(
    join(avdHome, `${name}.avd`, "config.ini"),
    `avd.ini.displayname=${displayName}\nimage.sysdir.1=system-images/android-35/google_apis/x86_64/\n`,
  );
}

/** An SDK with avdmanager, one installed system image, and one AVD, Pixel_8. */
async function sdk(options: { avdmanager?: boolean } = {}): Promise<NodeJS.ProcessEnv> {
  const sdkRoot = join(root, "sdk");
  await mkdir(join(sdkRoot, "cmdline-tools", "latest", "bin"), { recursive: true });
  await mkdir(join(sdkRoot, "platform-tools"), { recursive: true });
  if (options.avdmanager !== false) await writeFile(join(sdkRoot, "cmdline-tools", "latest", "bin", "avdmanager"), "");
  await mkdir(join(sdkRoot, "system-images", "android-35", "google_apis", "x86_64"), { recursive: true });
  await writeFile(join(sdkRoot, "system-images", "android-35", "google_apis", "x86_64", "system.img"), "");
  writeAvd("Pixel_8", "Pixel 8");
  return { ANDROID_HOME: sdkRoot, ANDROID_AVD_HOME: avdHome, PATH: "" };
}

/** avdmanager as the tests need it: lists profiles, and creates or deletes the AVD files it is asked to. */
function avdmanager(options: { failCreate?: string } = {}) {
  return new FakeProcessRunner((command, args) => {
    if (!command.endsWith("avdmanager")) return undefined;
    if (args[0] === "list") return { stdout: PROFILE_LIST };
    if (args[0] === "create") {
      if (options.failCreate) return { code: 1, stderr: options.failCreate };
      const name = args[args.indexOf("--name") + 1] ?? "";
      writeAvd(name, name.replaceAll("_", " "));
    }
    if (args[0] === "delete") {
      const name = args[args.indexOf("-n") + 1] ?? "";
      rmSync(join(avdHome, `${name}.ini`), { force: true });
      rmSync(join(avdHome, `${name}.avd`), { recursive: true, force: true });
    }
    return undefined;
  });
}

function manager(env: NodeJS.ProcessEnv, runner: FakeProcessRunner, running: readonly string[] = []) {
  const onChange = vi.fn(async () => undefined);
  const environment = new AndroidEnvironment({
    os: "linux",
    arch: "x64",
    env,
    home: join(root, "home"),
    mobileDir: join(root, "zli"),
    fs: nodeMobileFileSystem,
    runner,
  });
  const avds = new AvdManager({ environment, isRunning: async (name) => running.includes(name), onChange });
  return { avds, onChange };
}

describe("AvdManager", () => {
  it("lists virtual devices, installed images, and the Pixel profiles avdmanager knows, reading profiles once", async () => {
    const runner = avdmanager();
    const { avds } = manager(await sdk(), runner);
    const list = await avds.list();
    expect(list).toEqual({
      avdmanager: true,
      avds: [{ name: "Pixel_8", displayName: "Pixel 8", systemImage: IMAGE }],
      systemImages: [IMAGE],
      deviceProfiles: [
        { id: "pixel_7", name: "Pixel 7" },
        { id: "pixel_9_pro", name: "Pixel 9 Pro" },
        { id: "pixel_8", name: "Pixel 8" },
        { id: "pixel_6", name: "Pixel 6" },
      ],
      defaultDeviceProfile: "pixel_7",
    });
    await avds.list();
    expect(runner.argsOf("avdmanager")).toEqual([["list", "device", "-c"]]);
  });

  it("creates a device from an installed image with avdmanager, answering its hardware prompt", async () => {
    const runner = avdmanager();
    const env = await sdk();
    const { avds, onChange } = manager(env, runner);
    const list = await avds.create({ name: "Pixel_9", systemImage: IMAGE, device: "pixel_9_pro" });
    const create = runner.calls.find((call) => call.args[0] === "create");
    expect(create?.args).toEqual(["create", "avd", "--name", "Pixel_9", "--package", IMAGE, "--device", "pixel_9_pro"]);
    expect(create?.options).toMatchObject({ input: "no\n", env: { ANDROID_HOME: env.ANDROID_HOME } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(list.avds.map((avd) => avd.name)).toEqual(["Pixel_8", "Pixel_9"]);

    await avds.create({ name: "Small", systemImage: IMAGE });
    expect(runner.calls.find((call) => call.args.includes("Small"))?.args.at(-1)).toBe("pixel_7");
  });

  it("refuses to create with a bad name, an image that is not installed, or a name already taken", async () => {
    const runner = avdmanager();
    const { avds, onChange } = manager(await sdk(), runner);
    await expect(avds.create({ name: "Pixel 9", systemImage: IMAGE })).rejects.toThrow(
      "Use letters, digits, and _ . - only",
    );
    await expect(
      avds.create({ name: "Pixel_9", systemImage: "system-images;android-34;google_apis;x86_64" }),
    ).rejects.toThrow(
      "system-images;android-34;google_apis;x86_64 is not installed. ZLI creates virtual devices only from installed system images.",
    );
    await expect(avds.create({ name: "pixel_8", systemImage: IMAGE })).rejects.toThrow(
      "A virtual device named pixel_8 already exists.",
    );
    expect(runner.calls.filter((call) => call.args[0] === "create")).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports avdmanager's own error and still refreshes the device list", async () => {
    const runner = avdmanager({ failCreate: "Error: Invalid --device pixel_x" });
    const { avds, onChange } = manager(await sdk(), runner);
    await expect(avds.create({ name: "Pixel_9", systemImage: IMAGE, device: "pixel_x" })).rejects.toThrow(
      "Invalid --device pixel_x",
    );
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("deletes a device that is off, and refuses one that is running or missing", async () => {
    const runner = avdmanager();
    const env = await sdk();
    writeAvd("Pixel_9", "Pixel 9");
    const { avds, onChange } = manager(env, runner, ["Pixel_9"]);
    await expect(avds.delete({ name: "Pixel_9" })).rejects.toThrow("Shut down Pixel 9 before deleting it.");
    await expect(avds.delete({ name: "Nexus_5" })).rejects.toThrow("There is no virtual device named Nexus_5.");
    await expect(avds.delete({ name: "-rf" })).rejects.toThrow();
    expect(runner.calls.filter((call) => call.args[0] === "delete")).toEqual([]);

    const list = await avds.delete({ name: "Pixel_8" });
    expect(runner.calls.find((call) => call.args[0] === "delete")?.args).toEqual(["delete", "avd", "-n", "Pixel_8"]);
    expect(list.avds.map((avd) => avd.name)).toEqual(["Pixel_9"]);
    expect(onChange).toHaveBeenCalled();
  });

  it("lists without avdmanager but refuses to change anything", async () => {
    const runner = avdmanager();
    const { avds } = manager(await sdk({ avdmanager: false }), runner);
    expect(await avds.list()).toMatchObject({
      avdmanager: false,
      deviceProfiles: [{ id: "pixel_7", name: "Pixel 7" }],
    });
    await expect(avds.create({ name: "Pixel_9", systemImage: IMAGE })).rejects.toThrow(
      "avdmanager is not installed. Set up the Android emulator first.",
    );
    await expect(avds.delete({ name: "Pixel_8" })).rejects.toThrow("avdmanager is not installed.");
    expect(runner.argsOf("avdmanager")).toEqual([]);
  });
});

describe("avdmanager helpers", () => {
  it("builds delete arguments and reads profile ids past loading lines", () => {
    expect(avdDeleteArgs("Pixel_8")).toEqual(["delete", "avd", "-n", "Pixel_8"]);
    expect(parseDeviceProfileIds(PROFILE_LIST)).toEqual([
      "automotive_1024p_landscape",
      "pixel_6",
      "pixel_7",
      "pixel_8",
      "pixel_9_pro",
    ]);
    expect(deviceProfileName("pixel_tablet")).toBe("Pixel Tablet");
    expect(deviceProfiles([])).toEqual([{ id: "pixel_7", name: "Pixel 7" }]);
  });
});
