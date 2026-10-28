import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHECK_INTERVAL_MS,
  LAUNCH_CHECK_DELAY_MS,
  releaseNotesText,
  type UpdateInfoLike,
  type UpdaterLike,
  UpdateService,
  type UpdateServiceDependencies,
  updateDisabledReason,
  updateErrorMessage,
} from "./UpdateService.js";
import { parseUpdateSettings, type UpdateSettings } from "./UpdateSettingsStore.js";

type Listener = (value: never) => void;

class FakeUpdater implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  checks = 0;
  downloads = 0;
  installs: unknown[][] = [];
  /** What the next check finds; undefined means no newer version. */
  available: UpdateInfoLike | undefined;
  checkError: Error | undefined;
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never);
  }

  async checkForUpdates(): Promise<unknown> {
    this.checks += 1;
    this.emit("checking-for-update", undefined);
    if (this.checkError) {
      this.emit("error", this.checkError);
      throw this.checkError;
    }
    if (this.available) this.emit("update-available", this.available);
    else this.emit("update-not-available", { version: "0.1.0" });
    return null;
  }

  async downloadUpdate(): Promise<unknown> {
    this.downloads += 1;
    return [];
  }

  quitAndInstall(...args: unknown[]): void {
    this.installs.push(args);
  }
}

function memorySettings(initial: Partial<UpdateSettings> = {}) {
  let settings = parseUpdateSettings(initial);
  return {
    current: () => ({ ...settings }),
    update: async (patch: Partial<UpdateSettings>) => {
      settings = parseUpdateSettings(patch, settings);
      return { ...settings };
    },
  };
}

function createService(overrides: Partial<UpdateServiceDependencies> = {}) {
  const updater = new FakeUpdater();
  const opened: string[] = [];
  const loadUpdater = vi.fn(async () => updater);
  const settings = overrides.settings ?? memorySettings();
  const service = new UpdateService({
    loadUpdater,
    platform: "win32",
    isPackaged: true,
    env: {},
    currentVersion: "0.1.0",
    macCanAutoInstall: false,
    settings,
    openExternal: async (url) => {
      opened.push(url);
    },
    now: () => new Date("2025-01-02T03:04:05.000Z"),
    ...overrides,
  });
  return { service, updater, opened, loadUpdater, settings };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("UpdateService schedule", () => {
  it("checks 10 seconds after launch and then every 4 hours", async () => {
    const { service, updater } = createService();
    service.start();

    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS - 1);
    expect(updater.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checks).toBe(1);
    expect(service.status()).toMatchObject({ state: { status: "idle" }, lastCheckedAt: "2025-01-02T03:04:05.000Z" });

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(updater.checks).toBe(2);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(updater.checks).toBe(3);

    service.stop();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(updater.checks).toBe(3);
  });

  it.each([
    ["development builds", { isPackaged: false }],
    ["packaged end-to-end runs", { env: { ZLI_DISABLE_UPDATES: "1" } }],
    ["mock provider test runs", { env: { ZLI_TEST_PROVIDER: "mock" } }],
    ["launches with a throwaway database", { env: { ZLI_DATABASE_PATH: "/tmp/runtime.sqlite" } }],
  ])("never loads the updater in %s", async (_name, overrides) => {
    const { service, loadUpdater } = createService(overrides);
    service.start();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect((await service.check()).disabledReason).toBeTruthy();
    await service.download();
    expect(await service.quitAndInstall()).toBe(false);
    expect(loadUpdater).not.toHaveBeenCalled();
    expect(service.whatsNew()).toBeUndefined();
  });

  it("checks for updates in installed .deb and .rpm builds", () => {
    expect(updateDisabledReason({ isPackaged: true, env: {} })).toBeUndefined();
  });

  it("runs one check at a time", async () => {
    const { service, updater } = createService();
    await Promise.all([service.check(), service.check(), service.check()]);
    expect(updater.checks).toBe(1);
  });
});

describe("UpdateService downloads", () => {
  it.each([
    ["Windows", { platform: "win32" as const }],
    ["the Linux AppImage", { platform: "linux" as const, env: { APPIMAGE: "/opt/ZLI.AppImage" } }],
    ["signed macOS builds", { platform: "darwin" as const, macCanAutoInstall: true }],
  ])("downloads in the background on %s and restarts into the update", async (_name, overrides) => {
    const { service, updater } = createService(overrides);
    const seen: string[] = [];
    service.subscribe((status) => seen.push(status.state.status));
    updater.available = { version: "0.2.0", releaseNotes: "Faster startup" };

    await service.check();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.downloads).toBe(1);
    expect(service.status().state).toEqual({ status: "downloading", version: "0.2.0", percent: 0 });

    updater.emit("download-progress", { percent: 41.7 });
    updater.emit("download-progress", { percent: 41.9 });
    expect(service.status().state).toEqual({ status: "downloading", version: "0.2.0", percent: 41 });
    updater.emit("update-downloaded", { version: "0.2.0" });
    expect(service.status().state).toEqual({ status: "ready", version: "0.2.0", notes: "Faster startup" });
    expect(seen.filter((status) => status === "downloading")).toHaveLength(3);

    // A downloaded update is the newest one this launch gets, so later checks do nothing.
    await service.check();
    expect(updater.checks).toBe(1);
    expect(await service.quitAndInstall()).toBe(true);
    expect(updater.installs).toEqual([[true, true]]);
  });

  it("downloads on .deb and .rpm installs and installs only on Restart to update", async () => {
    const { service, updater } = createService({ platform: "linux", env: {} });
    updater.available = { version: "0.2.0" };

    await service.check();
    // dpkg and dnf ask for a password, which must not appear while ZLI quits.
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.downloads).toBe(1);
    await service.setAutoInstall(false);
    await service.setAutoInstall(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);

    updater.emit("update-downloaded", { version: "0.2.0" });
    expect(await service.quitAndInstall()).toBe(true);
    expect(updater.installs).toEqual([[true, true]]);
  });

  it("starts the current version again when the package install fails", async () => {
    const relaunch = vi.fn();
    const prepareToInstall = vi.fn(async () => {});
    const { service, updater } = createService({ platform: "linux", env: {}, relaunch, prepareToInstall });
    updater.available = { version: "0.2.0" };
    await service.check();
    updater.emit("update-downloaded", { version: "0.2.0" });
    updater.quitAndInstall = () => updater.emit("error", new Error("Command pkexec exited with code 126"));

    expect(await service.quitAndInstall()).toBe(false);
    expect(prepareToInstall).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
    expect(service.status().state).toMatchObject({ status: "ready", version: "0.2.0" });
  });

  it("stops the app's processes before electron-updater starts the installer", async () => {
    const order: string[] = [];
    const { service, updater } = createService({
      prepareToInstall: async () => {
        order.push(`prepare:${updater.installs.length}`);
      },
    });
    updater.available = { version: "0.2.0" };
    await service.check();
    updater.emit("update-downloaded", { version: "0.2.0" });

    expect(await service.quitAndInstall()).toBe(true);
    order.push(`installs:${updater.installs.length}`);
    expect(order).toEqual(["prepare:0", "installs:1"]);
  });

  it("offers the release page on unsigned macOS builds instead of downloading", async () => {
    const { service, updater, opened } = createService({ platform: "darwin" });
    updater.available = { version: "0.3.0", releaseNotes: [{ version: "0.3.0", note: "<p>New tiles</p>" }] };

    await service.check();
    expect(updater.downloads).toBe(0);
    expect(service.status().state).toEqual({
      status: "available",
      version: "0.3.0",
      notes: "## 0.3.0\n\n<p>New tiles</p>",
      releaseUrl: "https://github.com/RosMengHeang/ZLI/releases/tag/v0.3.0",
      canAutoInstall: false,
    });

    await service.download();
    await service.setAutoInstall(true);
    expect(updater.downloads).toBe(0);
    expect(opened).toEqual(["https://github.com/RosMengHeang/ZLI/releases/tag/v0.3.0"]);
    expect(await service.quitAndInstall()).toBe(false);
  });

  it("only reports an update when automatic installs are off, until the person asks", async () => {
    const { service, updater } = createService({ settings: memorySettings({ autoInstall: false }) });
    updater.available = { version: "0.2.0" };

    await service.check();
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.downloads).toBe(0);
    expect(service.status()).toMatchObject({
      autoInstall: false,
      state: { status: "available", version: "0.2.0", canAutoInstall: true },
    });

    await service.download();
    expect(updater.downloads).toBe(1);
    expect(service.status().state.status).toBe("downloading");
  });

  it("starts the download when automatic installs are turned back on", async () => {
    const { service, updater, settings } = createService({ settings: memorySettings({ autoInstall: false }) });
    updater.available = { version: "0.2.0" };
    await service.check();

    const status = await service.setAutoInstall(true);
    expect(settings.current().autoInstall).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.downloads).toBe(1);
    expect(status).toMatchObject({ autoInstall: true, state: { status: "downloading" } });

    await service.setAutoInstall(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it("goes back to idle when a later check finds nothing new", async () => {
    const { service, updater } = createService({ settings: memorySettings({ autoInstall: false }) });
    updater.available = { version: "0.2.0" };
    await service.check();
    updater.available = undefined;
    await service.check();
    expect(service.status().state).toEqual({ status: "idle" });
  });
});

describe("UpdateService errors", () => {
  it("reports the first line of a failed check and tries again next time", async () => {
    const { service, updater } = createService();
    updater.checkError = new Error("net::ERR_INTERNET_DISCONNECTED\n    at ClientRequest.<anonymous>");

    const status = await service.check();
    expect(status.state).toEqual({ status: "error", message: "net::ERR_INTERNET_DISCONNECTED" });
    expect(status.lastCheckedAt).toBe("2025-01-02T03:04:05.000Z");

    updater.checkError = undefined;
    expect((await service.check()).state).toEqual({ status: "idle" });
  });

  it("reports a failed download and retries the updater load after it fails", async () => {
    const updater = new FakeUpdater();
    const loadUpdater = vi
      .fn<() => Promise<UpdaterLike>>()
      .mockRejectedValueOnce(new Error("Cannot find module"))
      .mockResolvedValue(updater);
    const { service } = createService({ loadUpdater });
    expect((await service.check()).state).toEqual({ status: "error", message: "Cannot find module" });

    updater.available = { version: "0.2.0" };
    updater.downloadUpdate = async () => {
      throw new Error("sha512 checksum mismatch");
    };
    await service.check();
    expect(service.status().state).toEqual({ status: "error", message: "sha512 checksum mismatch" });
  });

  it("keeps a downloaded update when a later error arrives", async () => {
    const { service, updater } = createService();
    updater.available = { version: "0.2.0" };
    await service.check();
    updater.emit("update-downloaded", { version: "0.2.0" });
    updater.emit("error", new Error("HttpError: 503"));
    expect(service.status().state).toMatchObject({ status: "ready", version: "0.2.0" });
  });

  it("shortens long messages and fills in empty ones", () => {
    expect(updateErrorMessage(new Error("x".repeat(500)))).toHaveLength(300);
    expect(updateErrorMessage(undefined)).toBe("Something went wrong while updating.");
    expect(releaseNotesText("  ")).toBeUndefined();
    expect(releaseNotesText(null)).toBeUndefined();
  });
});

describe("What's new", () => {
  it("records the version on first launch without showing anything", async () => {
    const settings = memorySettings();
    const { service } = createService({ settings });
    service.start();
    expect(service.whatsNew()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(settings.current().lastSeenVersion).toBe("0.1.0");
  });

  it("shows the notes once after updating to the offered version", async () => {
    const settings = memorySettings({ lastSeenVersion: "0.1.0" });
    const first = createService({ settings });
    first.updater.available = { version: "0.2.0", releaseNotes: "## Fixes\n\n- Faster startup" };
    await first.service.check();
    first.service.stop();

    const second = createService({ settings, currentVersion: "0.2.0" });
    second.service.start();
    expect(second.service.whatsNew()).toEqual({
      version: "0.2.0",
      notes: "## Fixes\n\n- Faster startup",
      releaseUrl: "https://github.com/RosMengHeang/ZLI/releases/tag/v0.2.0",
    });
    await second.service.openReleasePage();
    expect(second.opened).toEqual(["https://github.com/RosMengHeang/ZLI/releases/tag/v0.2.0"]);

    await second.service.dismissWhatsNew();
    expect(second.service.whatsNew()).toBeUndefined();
    expect(settings.current().lastSeenVersion).toBe("0.2.0");
    second.service.stop();

    const third = createService({ settings, currentVersion: "0.2.0" });
    third.service.start();
    expect(third.service.whatsNew()).toBeUndefined();
    third.service.stop();
  });

  it("still links the release when the notes were never offered", () => {
    const { service } = createService({
      settings: memorySettings({ lastSeenVersion: "0.1.0" }),
      currentVersion: "0.1.4",
    });
    service.start();
    expect(service.whatsNew()).toEqual({
      version: "0.1.4",
      releaseUrl: "https://github.com/RosMengHeang/ZLI/releases/tag/v0.1.4",
    });
    service.stop();
  });
});
