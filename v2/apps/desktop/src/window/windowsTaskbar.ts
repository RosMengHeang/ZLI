/** Matches appId in electron-builder.yml, which the installer writes into the Start menu and taskbar shortcuts. */
export const WINDOWS_APP_ID = "dev.zli.desktop";

export type WindowsAppDetails = {
  appId: string;
  appIconPath: string;
  appIconIndex: number;
  relaunchCommand: string;
  relaunchDisplayName: string;
};

/**
 * Taskbar details for the main window of an installed build: the icon comes from ZLI.exe, and pinning
 * the running window starts ZLI.exe again. Development launches run electron.exe, whose icon is
 * Electron's, so they keep the window icon instead.
 */
export function windowsAppDetails(execPath: string, packaged: boolean): WindowsAppDetails | undefined {
  if (!packaged) return undefined;
  return {
    appId: WINDOWS_APP_ID,
    appIconPath: execPath,
    appIconIndex: 0,
    relaunchCommand: `"${execPath}"`,
    relaunchDisplayName: "ZLI",
  };
}
