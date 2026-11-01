import { MobileCrashList, type MobileCrashReport } from "@zli-v2/contracts";

import type { MobileDevToolModule } from "./types.js";

const MAX_REPORTS = 3;

/** A report as the agent reads it: the title, the frames indented, then the log lines before the crash. */
export function formatCrashReport(report: MobileCrashReport): string {
  const who = report.appId ?? "The app";
  const seen = report.count > 1 ? ` (${report.count} times, last at ${report.lastSeen})` : ` (at ${report.lastSeen})`;
  const lines = [`${who} crashed: ${report.title}${seen}`];
  if (report.heldBy) lines.push(`${report.heldBy} held the device.`);
  lines.push(...report.frames.map((frame) => `    ${frame.trim()}`));
  if (report.tail.length > 0) lines.push(`Last ${report.tail.length} log lines:`, ...report.tail);
  return lines.join("\n");
}

export const crashTools: MobileDevToolModule = {
  tools: [
    {
      name: "mobile_crashes",
      title: "Read app crashes",
      action: "mobilecrashes",
      readOnly: true,
      description:
        "Crashes and ANRs ZLI caught in the device log while you used it: the exception, the top stack frames, and the log lines before it. Native crashes never reach Metro, so check this when the app closes, freezes, or stays on the splash screen.",
      properties: {},
    },
  ],
  format: (action, result) => {
    if (action !== "mobilecrashes") return undefined;
    if (typeof result !== "object" || result === null) return undefined;
    const { deviceId, watching } = result as { deviceId?: unknown; watching?: unknown };
    const parsed = MobileCrashList.safeParse((result as { reports?: unknown }).reports);
    if (!parsed.success || typeof deviceId !== "string") return undefined;
    const reports = parsed.data;
    if (reports.length === 0) {
      const text =
        watching === false
          ? `ZLI is not reading the log of ${deviceId}, so it has no crashes to report. Crash watch may be off in Settings > Mobile.`
          : `No crashes on ${deviceId} since ZLI started reading its log.`;
      return { content: [{ type: "text", text }] };
    }
    const shown = reports.slice(0, MAX_REPORTS).map(formatCrashReport);
    const more = reports.length > MAX_REPORTS ? [`${reports.length - MAX_REPORTS} older crashes are not shown.`] : [];
    return { content: [{ type: "text", text: [...shown, ...more].join("\n\n") }] };
  },
  instructions:
    "When a result carries crashNotice, the app crashed on your device: call mobile_crashes for the exception and stack before you change code.",
};
