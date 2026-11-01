import {
  isFrameLine,
  type MobileCrashEvent,
  type MobileCrashReport,
  type MobileDevice,
  type MobileLease,
  type MobileSettings,
} from "@zli-v2/contracts";

import type { LogStream, MobileDriver } from "../../MobileDriver.js";
import { CrashDetector, type DetectedCrash } from "./detector.js";
import { CrashReports } from "./reports.js";

/** The part of the DeviceManager crash watch reads. It never lists devices itself, so it adds no adb calls. */
export type CrashWatchManager = {
  cached(): MobileDevice[];
  viewerCount(deviceId: string): number;
  driverFor(device: Pick<MobileDevice, "platform">): MobileDriver;
  readonly leases: { get(deviceId: string): MobileLease | null; heldBy(ownerId: string): string[] };
};

export type CrashWatcherDeps = {
  manager(): CrashWatchManager | undefined;
  settings(): Promise<MobileSettings>;
  send(channel: string, payload: MobileCrashEvent): void;
  now(): number;
  log?(message: string): void;
  pollMs?: number;
  /** How long a device nobody holds or shows keeps its log stream. */
  idleStopMs?: number;
  /** A crash block still open after the log goes quiet this long is closed. */
  quietFlushMs?: number;
  restartDelaysMs?: readonly number[];
  throttleMs?: number;
};

export const CRASH_EVENT = "zli:mobile:crash";
const RING_LINES = 500;
const TAIL_LINES = 30;
/** A stream that ran this long without dying earns its restarts back. */
const HEALTHY_MS = 60_000;

type Watch = {
  readonly device: MobileDevice;
  readonly detector: CrashDetector;
  readonly ring: string[];
  stream: LogStream | undefined;
  lastWanted: number;
  startedAt: number;
  restarts: number;
  stopped: boolean;
  restartTimer: ReturnType<typeof setTimeout> | undefined;
  quietTimer: ReturnType<typeof setTimeout> | undefined;
};

/**
 * Reads the log of each running device while an agent holds it or a window shows it, and keeps the crashes it
 * finds. It stops once the device goes offline, crash watch is turned off, or two minutes pass with neither.
 */
export class CrashWatcher {
  readonly #deps: CrashWatcherDeps;
  readonly #watches = new Map<string, Watch>();
  readonly #reports = new CrashReports();
  /** Devices whose log could not be read, so ZLI does not retry every poll. Cleared when crash watch is turned off. */
  readonly #unavailable = new Set<string>();
  readonly #lastSent = new Map<string, number>();
  readonly #sendTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #poll: ReturnType<typeof setInterval> | undefined;
  #ticking: Promise<void> | undefined;
  #disposed = false;

  constructor(deps: CrashWatcherDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#poll || this.#disposed) return;
    this.#poll = setInterval(() => void this.tick(), this.#deps.pollMs ?? 2_000);
    this.#poll.unref?.();
  }

  /** Starts and stops streams to match the devices, the setting, and who holds or shows each device. */
  tick(): Promise<void> {
    this.#ticking ??= this.#tick().finally(() => {
      this.#ticking = undefined;
    });
    return this.#ticking;
  }

  async #tick(): Promise<void> {
    if (this.#disposed) return;
    const settings = await this.#deps.settings().catch(() => undefined);
    if (!settings?.crashWatch) {
      for (const watch of [...this.#watches.values()]) this.#stop(watch);
      this.#unavailable.clear();
      return;
    }
    const manager = this.#deps.manager();
    if (!manager) return;
    const online = new Map(
      manager
        .cached()
        .filter((device) => device.state === "online")
        .map((device) => [device.deviceId, device]),
    );
    for (const watch of [...this.#watches.values()]) if (!online.has(watch.device.deviceId)) this.#stop(watch);
    const now = this.#deps.now();
    for (const device of online.values()) {
      const wanted = manager.leases.get(device.deviceId)?.kind === "agent" || manager.viewerCount(device.deviceId) > 0;
      const watch = this.#watches.get(device.deviceId);
      if (watch) {
        if (wanted) watch.lastWanted = now;
        else if (now - watch.lastWanted >= (this.#deps.idleStopMs ?? 120_000)) this.#stop(watch);
      } else if (wanted && !this.#unavailable.has(device.deviceId)) {
        await this.#start(manager, device);
      }
    }
  }

  /** Watches a running device now, whoever holds it. The e2e tests use this. */
  async watchNow(deviceId: string): Promise<boolean> {
    const manager = this.#deps.manager();
    const device = manager?.cached().find((entry) => entry.deviceId === deviceId && entry.state === "online");
    if (!manager || !device) return false;
    const watch = this.#watches.get(deviceId) ?? (await this.#start(manager, device));
    if (watch) watch.lastWanted = this.#deps.now();
    return watch?.stream !== undefined;
  }

  isWatching(deviceId: string): boolean {
    return this.#watches.get(deviceId)?.stream !== undefined;
  }

  /** Newest first, dismissed ones included. */
  reports(deviceId: string): MobileCrashReport[] {
    return this.#reports.list(deviceId);
  }

  dismiss(deviceId: string, crashId: string): MobileCrashReport[] {
    if (this.#reports.dismiss(deviceId, crashId)) this.#send(deviceId);
    return this.reports(deviceId);
  }

  /** Closes crash blocks still waiting for more lines. */
  flush(deviceId?: string): void {
    for (const watch of this.#watches.values()) {
      if (deviceId === undefined || watch.device.deviceId === deviceId) this.#handle(watch, watch.detector.flush());
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = undefined;
    for (const watch of [...this.#watches.values()]) this.#stop(watch);
    for (const timer of this.#sendTimers.values()) clearTimeout(timer);
    this.#sendTimers.clear();
  }

  async #start(manager: CrashWatchManager, device: MobileDevice): Promise<Watch | undefined> {
    const now = this.#deps.now();
    const watch: Watch = {
      device,
      detector: new CrashDetector(),
      ring: [],
      stream: undefined,
      lastWanted: now,
      startedAt: now,
      restarts: 0,
      stopped: false,
      restartTimer: undefined,
      quietTimer: undefined,
    };
    this.#watches.set(device.deviceId, watch);
    return (await this.#open(manager, watch)) ? watch : undefined;
  }

  async #open(manager: CrashWatchManager, watch: Watch): Promise<boolean> {
    let stream: LogStream;
    try {
      stream = await manager.driverFor(watch.device).streamLogs(watch.device);
    } catch (cause) {
      this.#giveUp(
        watch,
        `ZLI could not read the log of ${watch.device.name}, so crash watch is off for it: ${message(cause)}`,
      );
      return false;
    }
    if (watch.stopped || this.#disposed) {
      stream.stop();
      return false;
    }
    watch.stream = stream;
    watch.startedAt = this.#deps.now();
    stream.onLine((line) => this.#line(watch, line));
    void stream.exited.then(() => this.#exited(manager, watch, stream));
    return true;
  }

  #line(watch: Watch, line: string): void {
    if (watch.stopped) return;
    watch.ring.push(line);
    if (watch.ring.length > RING_LINES) watch.ring.splice(0, watch.ring.length - RING_LINES);
    this.#handle(watch, watch.detector.push(line));
    if (watch.quietTimer) clearTimeout(watch.quietTimer);
    watch.quietTimer = watch.detector.pending
      ? setTimeout(() => {
          watch.quietTimer = undefined;
          this.#handle(watch, watch.detector.flush());
        }, this.#deps.quietFlushMs ?? 500)
      : undefined;
  }

  #handle(watch: Watch, crashes: readonly DetectedCrash[]): void {
    if (crashes.length === 0) return;
    const lease = this.#deps.manager()?.leases.get(watch.device.deviceId);
    for (const crash of crashes) {
      this.#reports.record(watch.device.deviceId, crash, {
        tail: tailFor(watch.ring, crash.lines),
        heldBy: lease?.kind === "agent" ? lease.ownerLabel : undefined,
        at: new Date(this.#deps.now()),
      });
    }
    this.#send(watch.device.deviceId);
  }

  #exited(manager: CrashWatchManager, watch: Watch, stream: LogStream): void {
    if (watch.stream !== stream || watch.stopped) return;
    watch.stream = undefined;
    this.#handle(watch, watch.detector.flush());
    const delays = this.#deps.restartDelaysMs ?? [1_000, 5_000, 15_000];
    if (this.#deps.now() - watch.startedAt >= HEALTHY_MS) watch.restarts = 0;
    const delay = delays[watch.restarts];
    if (delay === undefined) {
      this.#giveUp(
        watch,
        `The log of ${watch.device.name} stopped ${delays.length + 1} times, so crash watch is off for it.`,
      );
      return;
    }
    watch.restarts += 1;
    watch.restartTimer = setTimeout(() => {
      watch.restartTimer = undefined;
      if (!watch.stopped) void this.#open(manager, watch);
    }, delay);
    watch.restartTimer.unref?.();
  }

  #giveUp(watch: Watch, reason: string): void {
    this.#unavailable.add(watch.device.deviceId);
    (this.#deps.log ?? console.warn)(reason);
    this.#stop(watch);
  }

  #stop(watch: Watch): void {
    if (watch.stopped) return;
    watch.stopped = true;
    if (watch.restartTimer) clearTimeout(watch.restartTimer);
    if (watch.quietTimer) clearTimeout(watch.quietTimer);
    watch.stream?.stop();
    watch.stream = undefined;
    if (this.#watches.get(watch.device.deviceId) === watch) this.#watches.delete(watch.device.deviceId);
    this.#handle(watch, watch.detector.flush());
  }

  /** At most one event per device per second; a burst ends with one more event carrying the latest reports. */
  #send(deviceId: string): void {
    if (this.#sendTimers.has(deviceId)) return;
    const throttle = this.#deps.throttleMs ?? 1_000;
    const wait = (this.#lastSent.get(deviceId) ?? Number.NEGATIVE_INFINITY) + throttle - this.#deps.now();
    const send = () => {
      this.#sendTimers.delete(deviceId);
      this.#lastSent.set(deviceId, this.#deps.now());
      this.#deps.send(CRASH_EVENT, { deviceId, reports: this.reports(deviceId) });
    };
    if (wait <= 0) {
      send();
      return;
    }
    const timer = setTimeout(send, wait);
    timer.unref?.();
    this.#sendTimers.set(deviceId, timer);
  }
}

/** The log lines before the crash, then the crash's own lines without its frames, at most 30. */
export function tailFor(ring: readonly string[], block: readonly string[]): string[] {
  const header = block.filter((line) => !isFrameLine(line.replace(/^.*?: /u, ""))).slice(0, 10);
  const first = block[0];
  const index = first === undefined ? -1 : ring.lastIndexOf(first);
  const before = index < 0 ? [] : ring.slice(Math.max(0, index - (TAIL_LINES - header.length)), index);
  return [...before, ...header].slice(-TAIL_LINES);
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
