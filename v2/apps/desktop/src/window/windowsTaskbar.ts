/** Matches appId in electron-builder.yml, which the installer writes into the Start menu and taskbar shortcuts. */
export const WINDOWS_APP_ID = "dev.zli.desktop";

/**
 * The app ID a launch runs under. Development launches must not share the installer's ID: Windows picks
 * a taskbar icon from any shortcut carrying the window's ID, and pinning a development window writes one
 * that points at electron.exe, which then gives the installed ZLI Electron's icon too. An executable path
 * is the ID Windows accepts for unregistered apps, so development toasts still show.
 */
export function windowsAppId(execPath: string, packaged: boolean): string {
  return packaged ? WINDOWS_APP_ID : execPath;
}

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
