import type { MobileCrashReport } from "@zli-v2/contracts";

import type { DetectedCrash } from "./detector.js";

const LINE_MAX = 500;

/** The crashes caught on each device, newest first, at most `limit` per device. Repeats bump a report's count. */
export class CrashReports {
  readonly #byDevice = new Map<string, Map<string, MobileCrashReport>>();
  readonly #limit: number;

  constructor(options: { limit?: number } = {}) {
    this.#limit = options.limit ?? 20;
  }

  record(
    deviceId: string,
    crash: DetectedCrash,
    details: { tail: readonly string[]; heldBy: string | undefined; at: Date },
  ): MobileCrashReport {
    const reports = this.#byDevice.get(deviceId) ?? new Map<string, MobileCrashReport>();
    this.#byDevice.set(deviceId, reports);
    const at = details.at.toISOString();
    const existing = reports.get(crash.signature);
    const fields = {
      ...(crash.appId ? { appId: crash.appId.slice(0, 300) } : {}),
      title: crash.title.slice(0, 300),
      frames: crash.frames.slice(0, 8).map((frame) => frame.slice(0, LINE_MAX)),
      tail: details.tail.slice(-30).map((line) => line.slice(0, LINE_MAX)),
    };
    let report: MobileCrashReport;
    if (existing && crash.updates) {
      report = { ...existing, ...fields, frames: fields.frames.length > 0 ? fields.frames : existing.frames };
    } else if (existing) {
      report = {
        ...existing,
        ...fields,
        lastSeen: at,
        count: existing.count + 1,
        ...(details.heldBy ? { heldBy: details.heldBy } : {}),
        dismissed: false,
      };
    } else {
      report = {
        crashId: crashId(deviceId, crash.signature),
        deviceId,
        kind: crash.kind,
        ...fields,
        firstSeen: at,
        lastSeen: at,
        count: 1,
        ...(details.heldBy ? { heldBy: details.heldBy } : {}),
      };
    }
    // Re-inserting keeps the map in last-seen order, so the oldest report is the first to go.
    reports.delete(crash.signature);
    reports.set(crash.signature, report);
    while (reports.size > this.#limit) reports.delete(reports.keys().next().value as string);
    return report;
  }

  /** Newest first. */
  list(deviceId: string): MobileCrashReport[] {
    return [...(this.#byDevice.get(deviceId)?.values() ?? [])].reverse();
  }

  dismiss(deviceId: string, crashId: string): boolean {
    const reports = this.#byDevice.get(deviceId);
    for (const [signature, report] of reports ?? []) {
      if (report.crashId !== crashId) continue;
      reports?.set(signature, { ...report, dismissed: true });
      return true;
    }
    return false;
  }
}

/** A stable id from the device and the crash signature, so a repeat keeps its id. FNV-1a, two seeds. */
export function crashId(deviceId: string, signature: string): string {
  const text = `${deviceId}\n${signature}`;
  const hash = (seed: number) => {
    let value = seed;
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 0x01000193) >>> 0;
    }
    return value.toString(16).padStart(8, "0");
  };
  return `crash-${hash(0x811c9dc5)}${hash(0x01000193)}`;
}
