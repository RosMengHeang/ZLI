import {
  MobileControlCrashesInput,
  MobileCrashDismissInput,
  MobileCrashListInput,
  type MobileCrashReport,
  MobileTestEmitLogInput,
} from "@zli-v2/contracts";

import type { LeaseOwner } from "../../DeviceLeases.js";
import type { MobileDevFeature, MobileDevHost } from "../host.js";
import { CrashWatcher } from "./CrashWatcher.js";

/** The fake driver's test method. Only the e2e fake has it. */
type EmitsLog = { emitLog(deviceId: string, lines: readonly string[]): number };

/**
 * Crash watch: reads the log of each device an agent or a window uses, keeps the crashes it finds, and tells the
 * agent holding the device on its next zli-mobile result. Nothing goes into a chat from here.
 */
export function createCrash(host: MobileDevHost): MobileDevFeature {
  const watcher = new CrashWatcher({
    manager: () => host.manager(),
    settings: () => host.settings(),
    send: (channel, payload) => host.send(channel, payload),
    now: () => host.now().getTime(),
  });
  watcher.start();
  /** Per owner, the last sighting of each crash it was already told about. */
  const told = new Map<string, Map<string, string>>();

  const ownerReports = (owner: LeaseOwner): MobileCrashReport[] => {
    const manager = host.manager();
    if (!manager) return [];
    return manager.leases
      .heldBy(owner.ownerId)
      .flatMap((deviceId) => watcher.reports(deviceId))
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  };

  return {
    actions: {
      mobilecrashes: async (input, context) => {
        const parsed = MobileControlCrashesInput.parse(input);
        const { device } = await context.online(parsed);
        watcher.flush(device.deviceId);
        const reports = watcher.reports(device.deviceId);
        return {
          deviceId: device.deviceId,
          watching: watcher.isWatching(device.deviceId),
          reports,
        };
      },
    },
    ipc: {
      "zli:mobile:crash:list": (input) => watcher.reports(MobileCrashListInput.parse(input).deviceId),
      "zli:mobile:crash:dismiss": (input) => {
        const parsed = MobileCrashDismissInput.parse(input);
        return watcher.dismiss(parsed.deviceId, parsed.crashId);
      },
    },
    decorate: (owner, action, result) => {
      if (owner.kind !== "agent") return result;
      const reports = ownerReports(owner);
      if (reports.length === 0) return result;
      const seen = told.get(owner.ownerId) ?? new Map<string, string>();
      told.set(owner.ownerId, seen);
      const fresh = reports.filter((report) => seen.get(report.crashId) !== sighting(report));
      if (action === "mobilecrashes") {
        // The agent just read every report, so none of them is news any more.
        for (const report of reports) seen.set(report.crashId, sighting(report));
        return result;
      }
      const newest = fresh[0];
      if (!newest || typeof result !== "object" || result === null || Array.isArray(result)) return result;
      for (const report of fresh) seen.set(report.crashId, sighting(report));
      return { ...result, crashNotice: crashNotice(newest, host.now()) };
    },
    testOps: {
      "emit-log": async (input) => {
        const parsed = MobileTestEmitLogInput.parse(input);
        const manager = host.manager();
        if (!manager) throw new Error("ZLI's mobile service is not running.");
        const devices = await manager.list();
        const device = devices.find(
          (entry) => entry.state === "online" && (parsed.deviceId === undefined || entry.deviceId === parsed.deviceId),
        );
        if (!device) throw new Error("No running device to print the log lines on.");
        if (!(await watcher.watchNow(device.deviceId)))
          throw new Error(`ZLI could not read the log of ${device.name}.`);
        const driver = manager.driverFor(device) as Partial<EmitsLog>;
        if (typeof driver.emitLog !== "function") throw new Error("Only the fake device can print test log lines.");
        driver.emitLog(device.deviceId, parsed.lines);
        watcher.flush(device.deviceId);
        return { deviceId: device.deviceId, reports: watcher.reports(device.deviceId) };
      },
    },
    dispose: () => watcher.dispose(),
  };
}

function sighting(report: MobileCrashReport): string {
  return `${report.lastSeen}#${report.count}`;
}

/** "The app crashed 12 s ago: <title>. Call mobile_crashes for the stack." */
export function crashNotice(report: MobileCrashReport, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(report.lastSeen)) / 1_000));
  const ago = seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
  const title = /[.!?…]$/u.test(report.title) ? report.title : `${report.title}.`;
  return `The app crashed ${ago} ago: ${title} Call mobile_crashes for the stack.`;
}
