import type { MobileDevice } from "@zli-v2/contracts";

import type { MobileBridge } from "../runtime/bridge.js";
import { screenshotBlob } from "./mobile.js";

const CLIPBOARD_IMAGE_ERROR = "ZLI could not put the image on the clipboard. Save the screenshot instead.";

/** Downloads a PNG of the device's screen, named after the device and the time, and returns the file name. */
export async function saveScreenshot(mobile: MobileBridge, device: MobileDevice): Promise<string> {
  const shot = await mobile.screenshot(device.deviceId);
  const link = document.createElement("a");
  link.href = `data:${shot.mimeType};base64,${shot.data}`;
  link.download = `${fileSafe(device.name)}-${fileStamp(new Date())}.png`;
  link.click();
  return link.download;
}

/** Puts a PNG of the device's screen on the clipboard. Call it straight from a click. */
export async function copyScreenshot(mobile: MobileBridge, device: MobileDevice): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error(CLIPBOARD_IMAGE_ERROR);
  const image = mobile.screenshot(device.deviceId).then(screenshotBlob);
  // The clipboard takes writes only right after a click, so the write starts now and waits for the image.
  const written = navigator.clipboard.write([new ClipboardItem({ "image/png": image })]).then(
    () => true,
    () => false,
  );
  await image;
  if (!(await written)) throw new Error(CLIPBOARD_IMAGE_ERROR);
}

function fileSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "device";
}

function fileStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
