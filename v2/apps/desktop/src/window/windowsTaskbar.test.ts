import { describe, expect, it } from "vitest";

import { WINDOWS_APP_ID, windowsAppDetails } from "./windowsTaskbar.js";

describe("windowsAppDetails", () => {
  it("points an installed build's taskbar button at ZLI.exe under the installer's app ID", () => {
    const exe = "C:\\Users\\me\\AppData\\Local\\Programs\\ZLI\\ZLI.exe";
    expect(windowsAppDetails(exe, true)).toEqual({
      appId: WINDOWS_APP_ID,
      appIconPath: exe,
      appIconIndex: 0,
      relaunchCommand: `"${exe}"`,
      relaunchDisplayName: "ZLI",
    });
    expect(WINDOWS_APP_ID).toBe("dev.zli.desktop");
  });

  it("leaves development launches alone, since electron.exe carries Electron's icon", () => {
    expect(windowsAppDetails("C:\\repo\\node_modules\\electron\\dist\\electron.exe", false)).toBeUndefined();
  });
});
