// @vitest-environment jsdom

import type { MobileDevice } from "@zli-v2/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileControls } from "./MobileControls.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

async function renderControls(extra: { deviceSettingsOpen?: boolean; onDeviceSettings?: () => void }) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <MobileControls
        mobile={{ input: vi.fn(async () => undefined), openUrl: vi.fn(async () => ({})) } as never}
        device={
          { deviceId: "android-avd:Pixel_7", platform: "android", kind: "emulator", name: "Pixel 7" } as MobileDevice
        }
        canRotate
        inputBlocked={false}
        onBlockedInput={() => undefined}
        onError={() => undefined}
        onNotice={() => undefined}
        screenshotBusy={false}
        onScreenshot={() => undefined}
        onCopyScreenshot={() => undefined}
        showFrame
        onShowFrame={() => undefined}
        {...extra}
      />,
    ),
  );
  const more = container.querySelector('button[aria-label="More device buttons"]') as HTMLButtonElement;
  await act(async () => more.click());
  return [...document.body.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')];
}

describe("mobile controls menu", () => {
  it("toggles the Device settings drawer from the More menu", async () => {
    const onDeviceSettings = vi.fn();
    const items = await renderControls({ deviceSettingsOpen: true, onDeviceSettings });
    const item = items.find((entry) => entry.textContent?.includes("Device settings")) as HTMLElement;
    expect(item.getAttribute("role")).toBe("menuitemcheckbox");
    expect(item.getAttribute("aria-checked")).toBe("true");
    await act(async () => item.click());
    expect(onDeviceSettings).toHaveBeenCalledTimes(1);
  });

  it("leaves the item out when the bridge has no device settings", async () => {
    const items = await renderControls({});
    expect(items.some((entry) => entry.textContent?.includes("Device settings"))).toBe(false);
  });
});
