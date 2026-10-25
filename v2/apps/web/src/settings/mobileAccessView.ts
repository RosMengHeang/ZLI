import type { MobileDevice } from "@zli-v2/contracts";
import qrcode from "qrcode-generator";

/**
 * The dark modules of a QR code as one SVG path, in module units. The caller adds the quiet zone.
 * Error correction M survives a glare spot on the screen without making the code too dense to scan.
 */
export function qrPath(text: string): { size: number; path: string } {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  const parts: string[] = [];
  for (let row = 0; row < size; row += 1) {
    let column = 0;
    while (column < size) {
      if (!qr.isDark(row, column)) {
        column += 1;
        continue;
      }
      const start = column;
      while (column < size && qr.isDark(row, column)) column += 1;
      parts.push(`M${start} ${row}h${column - start}v1h${start - column}z`);
    }
  }
  return { size, path: parts.join("") };
}

/** Minutes and seconds left on a pairing code, such as 4:05. */
export function countdown(expiresAt: string, now: number): string {
  const left = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

function shortDate(iso: string, now: number): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" });
}

function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  return `on ${shortDate(iso, now)}`;
}

/** The line under a phone's name in Settings. */
export function deviceDetail(device: MobileDevice, now: number): string {
  const paired = `Paired ${shortDate(device.pairedAt, now)}`;
  if (device.connected) return `${paired}. Connected now.`;
  if (!device.lastSeenAt) return `${paired}.`;
  return `${paired}. Last seen ${ago(device.lastSeenAt, now)}.`;
}

/** Phones in the list that were not there before, for the "paired" confirmation. */
export function newlyPaired(before: readonly MobileDevice[], after: readonly MobileDevice[]): MobileDevice | undefined {
  const known = new Set(before.map((device) => device.deviceId));
  return after.find((device) => !known.has(device.deviceId));
}
