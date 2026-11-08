// @vitest-environment jsdom

import type { MobileSettings } from "@zli-v2/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MobileBridge } from "../../../runtime/bridge.js";
import { CrashWatchSettingGroup } from "./CrashWatchSettingGroup.js";
import { cleanup, render } from "./testRender.js";

afterEach(cleanup);

describe("crash watch setting", () => {
  it("shows the setting and saves a change", async () => {
    let settings: MobileSettings = { agentTools: true, crashWatch: true };
    const mobile = {
      getSettings: vi.fn(async () => settings),
      setSettings: vi.fn(async (patch: Partial<MobileSettings>) => {
        settings = { ...settings, ...patch };
        return settings;
      }),
    } as unknown as MobileBridge;
    const container = await render(<CrashWatchSettingGroup mobile={mobile} />);
    expect(container.querySelector("h4")?.textContent).toBe("Crash watch");
    expect(container.textContent).toContain("Watch for crashes");
    expect(container.textContent).toContain(
      "While a device runs, ZLI reads its log for crashes and tells the agent using it. Nothing goes into a chat unless you choose Send to agent.",
    );
    const toggle = container.querySelector<HTMLInputElement>('input[role="switch"]');
    expect(toggle?.checked).toBe(true);
    await act(async () => toggle?.click());
    expect(mobile.setSettings).toHaveBeenCalledWith({ crashWatch: false });
    expect(toggle?.checked).toBe(false);
  });
});
