import type { UpdateState, UpdateStatus, WhatsNew } from "@zli-v2/contracts";

import type { UpdateSettings } from "./UpdateSettingsStore.js";

export const LAUNCH_CHECK_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const RELEASES_URL = "https://github.com/RosMengHeang/ZLI/releases";
const MAX_NOTES = 50_000;
const MAX_ERROR = 300;
const VERSION = /^\d+\.\d+\.\d+$/u;

export function releaseUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`;
}

type ReleaseNotes = string | readonly { version: string; note?: string | null }[] | null | undefined;
export type UpdateInfoLike = { version: string; releaseNotes?: ReleaseNotes };

/** The parts of electron-updater's autoUpdater the service uses. */
export type UpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(
    event: "update-available" | "update-not-available" | "update-downloaded",
    listener: (info: UpdateInfoLike) => void,
  ): unknown;
  on(event: "download-progress", listener: (progress: { percent: number }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

export type UpdateSettingsHost = {
  current(): UpdateSettings;
  update(patch: Partial<UpdateSettings>): Promise<UpdateSettings>;
};

export type Timers = {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delay: number): unknown;
  clearInterval(handle: unknown): void;
};

const globalTimers: Timers = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export type UpdateServiceDependencies = {
  /** Loaded on the first check, so launches that never check never load electron-updater. */
  loadUpdater(): Promise<UpdaterLike>;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  env: Readonly<Record<string, string | undefined>>;
  currentVersion: string;
  /** Squirrel.Mac refuses to install into an unsigned app, so macOS builds say whether they are signed. */
  macCanAutoInstall: boolean;
  settings: UpdateSettingsHost;
  openExternal(url: string): Promise<unknown>;
  /** Stops the runtime and the terminal daemon, which would otherwise keep the installer from replacing the app. */
  prepareToInstall?: () => Promise<void>;
  /** Starts ZLI again on the version it has, for an install that failed after prepareToInstall stopped the app. */
  relaunch?: () => void;
  now?: () => Date;
  timers?: Timers;
  log?: (level: "info" | "warn" | "error", message: string) => void;
};

/** Why this launch never checks for updates, or undefined when it does. */
export function updateDisabledReason({
  isPackaged,
  env,
}: Pick<UpdateServiceDependencies, "isPackaged" | "env">): string | undefined {
  if (!isPackaged) return "Updates are off in development builds.";
  // Packaged end-to-end runs set these, and must never reach GitHub or replace the app under test.
  if (env.ZLI_DISABLE_UPDATES === "1" || env.ZLI_TEST_PROVIDER || env.ZLI_DATABASE_PATH) {
    return "Updates are off for test and development launches.";
  }
  return undefined;
}

/**
 * Installed .deb and .rpm builds update through dpkg, apt, dnf, or rpm, which ask for an administrator
 * password. The AppImage replaces its own file without one.
 */
export function isLinuxPackage({ platform, env }: Pick<UpdateServiceDependencies, "platform" | "env">): boolean {
  return platform === "linux" && !env.APPIMAGE;
}

/** electron-updater gives GitHub's notes as one string or, with a full changelog, one entry per version. */
export function releaseNotesText(notes: ReleaseNotes): string | undefined {
  if (!notes) return undefined;
  const text =
    typeof notes === "string"
      ? notes
      : notes
          .filter((entry) => entry.note)
          .map((entry) => `## ${entry.version}\n\n${entry.note}`)
          .join("\n\n");
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, MAX_NOTES) : undefined;
}

/** The first line of an updater error, which otherwise can carry whole HTTP responses. */
export function updateErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const line =
    raw
      .split(/\r?\n/u)
      .find((part) => part.trim())
      ?.trim() ?? "";
  if (!line) return "Something went wrong while updating.";
  return line.length > MAX_ERROR ? `${line.slice(0, MAX_ERROR - 1)}…` : line;
}

/**
 * Checks GitHub Releases for a newer ZLI shortly after launch and every few hours, downloads it in
 * the background where the app can replace itself, and reports each step to the renderer.
 */
export class UpdateService {
  readonly disabledReason: string | undefined;
  private readonly canAutoInstall: boolean;
  /** A password prompt while ZLI quits would be unexpected, so .deb and .rpm installs wait for Restart to update. */
  private readonly canInstallOnQuit: boolean;
  private readonly timers: Timers;
  private readonly now: () => Date;
  private state: UpdateState = { status: "idle" };
  private lastCheckedAt: string | undefined;
  private offered: { version: string; notes?: string } | undefined;
  private updater: Promise<UpdaterLike> | undefined;
  private checking: Promise<void> | undefined;
  private launchTimer: unknown;
  private intervalTimer: unknown;
  private pendingWhatsNew: WhatsNew | undefined;
  private installing = false;
  private installFailed = false;
  private readonly listeners = new Set<(status: UpdateStatus) => void>();

  constructor(private readonly deps: UpdateServiceDependencies) {
    this.disabledReason = updateDisabledReason(deps);
    this.canAutoInstall = deps.platform !== "darwin" || deps.macCanAutoInstall;
    this.canInstallOnQuit = !isLinuxPackage(deps);
    this.timers = deps.timers ?? globalTimers;
    this.now = deps.now ?? (() => new Date());
    // The process that failed the install has exited. The next launch is what the person sees.
    const installError = deps.settings.current().installError;
    if (installError) this.state = { status: "error", message: installError };
  }

  status(): UpdateStatus {
    const settings = this.deps.settings.current();
    return {
      state: this.state,
      currentVersion: this.deps.currentVersion,
      ...(this.lastCheckedAt ? { lastCheckedAt: this.lastCheckedAt } : {}),
      autoInstall: settings.autoInstall,
      channel: "stable",
      ...(this.disabledReason ? { disabledReason: this.disabledReason } : {}),
    };
  }

  subscribe(listener: (status: UpdateStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Schedules the launch check and the periodic ones. Does nothing in launches that never update. */
  start(): void {
    if (this.disabledReason || this.launchTimer !== undefined) return;
    this.recordLaunch();
    this.launchTimer = this.timers.setTimeout(() => void this.check(), LAUNCH_CHECK_DELAY_MS);
    this.intervalTimer = this.timers.setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.launchTimer !== undefined) this.timers.clearTimeout(this.launchTimer);
    if (this.intervalTimer !== undefined) this.timers.clearInterval(this.intervalTimer);
    this.launchTimer = undefined;
    this.intervalTimer = undefined;
  }

  async check(): Promise<UpdateStatus> {
    if (this.disabledReason) return this.status();
    // A downloaded or downloading update is already the newest one this launch will get.
    if (this.state.status === "downloading" || this.state.status === "ready") return this.status();
    this.checking ??= this.runCheck().finally(() => {
      this.checking = undefined;
    });
    await this.checking;
    return this.status();
  }

  /** Starts the download the person asked for, or opens the release page where the app cannot install it. */
  async download(): Promise<UpdateStatus> {
    const state = this.state;
    if (state.status !== "available") return this.status();
    if (!state.canAutoInstall) {
      await this.openReleasePage();
      return this.status();
    }
    await this.startDownload(state.version);
    return this.status();
  }

  /** Restarts into the downloaded update. Returns false when there is nothing to install or the install failed. */
  async quitAndInstall(): Promise<boolean> {
    if (this.state.status !== "ready" || !this.updater) return false;
    const updater = await this.updater;
    const version = this.state.version;
    this.deps.log?.("info", `restarting to install ZLI ${version}`);
    // electron-updater starts the installer before the app quits, so stop the app's processes first.
    await this.deps.prepareToInstall?.();
    // A .deb or .rpm install runs dpkg or dnf before quitAndInstall returns, and reports a closed
    // password prompt or a failed install as an error event during the call.
    this.installing = true;
    this.installFailed = false;
    try {
      updater.quitAndInstall(true, true);
    } catch (error) {
      this.fail(error);
    } finally {
      this.installing = false;
    }
    if (!this.installFailed) return true;
    // Staying on ready would look like the install worked, including when the password prompt was closed.
    const message = `ZLI ${version} was not installed. Check for updates, then try Restart to update again.`;
    this.deps.log?.("warn", `ZLI ${version} was not installed; starting the current version again`);
    this.setState({ status: "error", message });
    await this.saveSettings({ installError: message });
    this.deps.relaunch?.();
    return false;
  }

  /** Opens the GitHub page of the offered, downloaded, or just-installed release. */
  async openReleasePage(): Promise<void> {
    const state = this.state;
    const version =
      state.status === "available" || state.status === "downloading" || state.status === "ready"
        ? state.version
        : this.pendingWhatsNew?.version;
    await this.deps.openExternal(version ? releaseUrl(version) : `${RELEASES_URL}/latest`);
  }

  async setAutoInstall(autoInstall: boolean): Promise<UpdateStatus> {
    await this.deps.settings.update({ autoInstall });
    if (this.updater) (await this.updater).autoInstallOnAppQuit = this.canInstallOnQuit && autoInstall;
    const state = this.state;
    if (autoInstall && state.status === "available" && state.canAutoInstall) await this.startDownload(state.version);
    else this.emit();
    return this.status();
  }

  whatsNew(): WhatsNew | undefined {
    return this.pendingWhatsNew;
  }

  async dismissWhatsNew(): Promise<void> {
    if (!this.pendingWhatsNew) return;
    this.pendingWhatsNew = undefined;
    await this.saveSettings({ lastSeenVersion: this.deps.currentVersion });
  }

  /** The first launch only records the version; a later launch on a new version has notes to show. */
  private recordLaunch(): void {
    const current = this.deps.currentVersion;
    if (!VERSION.test(current)) return;
    const { lastSeenVersion, offered } = this.deps.settings.current();
    if (lastSeenVersion === current) return;
    if (lastSeenVersion === undefined) {
      void this.saveSettings({ lastSeenVersion: current });
      return;
    }
    const notes = offered?.version === current ? offered.notes : undefined;
    this.pendingWhatsNew = { version: current, ...(notes ? { notes } : {}), releaseUrl: releaseUrl(current) };
  }

  private async runCheck(): Promise<void> {
    await this.clearInstallError();
    // An offer already on screen stays there while the next check runs in the background.
    if (this.state.status !== "available") this.setState({ status: "checking" });
    try {
      const updater = await this.loadUpdater();
      await updater.checkForUpdates();
    } catch (error) {
      this.fail(error);
    } finally {
      this.lastCheckedAt = this.now().toISOString();
      if (this.state.status === "checking") this.setState({ status: "idle" });
      else this.emit();
    }
  }

  private loadUpdater(): Promise<UpdaterLike> {
    if (this.updater) return this.updater;
    const loading = this.deps.loadUpdater().then((updater) => {
      // The service decides when to download, so the setting and the platform both apply.
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = this.canInstallOnQuit && this.deps.settings.current().autoInstall;
      updater.on("update-available", (info) => this.onAvailable(info));
      updater.on("update-not-available", () => {
        if (this.state.status === "checking" || this.state.status === "available") this.setState({ status: "idle" });
      });
      updater.on("download-progress", (progress) => this.onProgress(progress.percent));
      updater.on("update-downloaded", (info) => this.onDownloaded(info));
      updater.on("error", (error) => this.fail(error));
      return updater;
    });
    this.updater = loading;
    // A failed load is retried on the next check.
    loading.catch(() => {
      if (this.updater === loading) this.updater = undefined;
    });
    return loading;
  }

  private onAvailable(info: UpdateInfoLike): void {
    if (!VERSION.test(info.version)) return;
    const notes = releaseNotesText(info.releaseNotes);
    this.offered = { version: info.version, ...(notes ? { notes } : {}) };
    void this.saveSettings({ offered: this.offered });
    this.deps.log?.("info", `ZLI ${info.version} is available`);
    if (this.canAutoInstall && this.deps.settings.current().autoInstall) {
      void this.startDownload(info.version);
      return;
    }
    this.setState({
      status: "available",
      version: info.version,
      ...(notes ? { notes } : {}),
      releaseUrl: releaseUrl(info.version),
      canAutoInstall: this.canAutoInstall,
    });
  }

  private async startDownload(version: string): Promise<void> {
    if (this.state.status === "downloading" || this.state.status === "ready") return;
    this.setState({ status: "downloading", version, percent: 0 });
    try {
      await (await this.loadUpdater()).downloadUpdate();
    } catch (error) {
      this.fail(error);
    }
  }

  private onProgress(percent: number): void {
    const state = this.state;
    if (state.status !== "downloading" || !Number.isFinite(percent)) return;
    const next = Math.min(100, Math.max(0, Math.floor(percent)));
    // Progress events arrive many times a second; the renderer only needs whole percents.
    if (next !== state.percent) this.setState({ ...state, percent: next });
  }

  private onDownloaded(info: UpdateInfoLike): void {
    if (!VERSION.test(info.version)) return;
    const notes =
      releaseNotesText(info.releaseNotes) ?? (this.offered?.version === info.version ? this.offered.notes : undefined);
    this.deps.log?.("info", `ZLI ${info.version} is ready to install`);
    this.setState({ status: "ready", version: info.version, ...(notes ? { notes } : {}) });
  }

  private fail(error: unknown): void {
    const message = updateErrorMessage(error);
    this.deps.log?.("warn", `update failed: ${message}`);
    if (this.installing) this.installFailed = true;
    // A later failed check must not hide an update that is already downloaded.
    if (this.state.status === "ready") return;
    this.setState({ status: "error", message });
  }

  /** Drops a stored install failure once a check is trying again. An empty string clears it. */
  private async clearInstallError(): Promise<void> {
    if (!this.deps.settings.current().installError) return;
    await this.saveSettings({ installError: "" });
  }

  private async saveSettings(patch: Partial<UpdateSettings>): Promise<void> {
    try {
      await this.deps.settings.update(patch);
    } catch (error) {
      this.deps.log?.("warn", `update settings could not be saved: ${updateErrorMessage(error)}`);
    }
  }

  private setState(state: UpdateState): void {
    this.state = state;
    this.emit();
  }

  private emit(): void {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }
}
