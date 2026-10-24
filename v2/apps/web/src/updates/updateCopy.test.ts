import type { UpdateStatus } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { busyAgentCount, lastCheckedText, updatePill, updateStatusText } from "./updateCopy.js";

const base: UpdateStatus = { state: { status: "idle" }, currentVersion: "0.1.0", autoInstall: true, channel: "stable" };
const releaseUrl = "https://github.com/RosMengHeang/ZLI/releases/tag/v0.2.0";

describe("update copy", () => {
  it("describes each update state in one sentence", () => {
    expect(updateStatusText(base)).toBe("ZLI checks for updates a few seconds after it starts.");
    expect(updateStatusText({ ...base, lastCheckedAt: "2025-01-02T03:04:05.000Z" })).toBe("ZLI is up to date.");
    expect(updateStatusText({ ...base, state: { status: "checking" } })).toBe("Checking for updates.");
    expect(
      updateStatusText({
        ...base,
        state: { status: "available", version: "0.2.0", releaseUrl, canAutoInstall: false },
      }),
    ).toContain("download it from the release page");
    expect(updateStatusText({ ...base, state: { status: "downloading", version: "0.2.0", percent: 40 } })).toBe(
      "Downloading ZLI 0.2.0: 40%.",
    );
    expect(updateStatusText({ ...base, state: { status: "ready", version: "0.2.0" } })).toBe(
      "ZLI 0.2.0 is downloaded. Restart ZLI to finish updating.",
    );
    expect(updateStatusText({ ...base, state: { status: "error", message: "offline" } })).toBe(
      "The last update attempt failed: offline",
    );
    expect(updateStatusText({ ...base, disabledReason: "Updates are off in development builds." })).toBe(
      "Updates are off in development builds.",
    );
  });

  it("shows the title bar pill only when the person has something to do", () => {
    expect(updatePill(undefined)).toBeUndefined();
    expect(updatePill(base)).toBeUndefined();
    expect(updatePill({ ...base, state: { status: "downloading", version: "0.2.0", percent: 3 } })).toBeUndefined();
    expect(updatePill({ ...base, state: { status: "ready", version: "0.2.0" } })).toEqual({
      label: "Restart to update to v0.2.0",
      action: "restart",
    });
    expect(
      updatePill({ ...base, state: { status: "available", version: "0.2.0", releaseUrl, canAutoInstall: false } }),
    ).toEqual({ label: "Update available: v0.2.0", action: "open-release" });
    expect(
      updatePill({ ...base, state: { status: "available", version: "0.2.0", releaseUrl, canAutoInstall: true } })
        ?.action,
    ).toBe("open-settings");
  });

  it("counts agents a restart would cut off and formats the last check", () => {
    expect(busyAgentCount([{ status: "working" }, { status: "waiting" }, { status: "ready" }])).toBe(2);
    expect(lastCheckedText(undefined)).toBe("Not checked yet");
    expect(lastCheckedText("2025-01-02T03:04:05.000Z")).toMatch(/^Last checked /u);
  });
});
