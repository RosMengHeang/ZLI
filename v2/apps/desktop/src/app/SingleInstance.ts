export type InstanceApp = {
  requestSingleInstanceLock(): boolean;
  on(event: "second-instance", listener: () => void): unknown;
};

export type InstanceWindow = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
};

/**
 * Takes the lock that lets one ZLI run per user data folder. Two copies on the same data would share
 * the terminal daemon and the agents' browser control file, and the copy that quit first would take both
 * down under the other. Returns false in the later copy, which should exit without starting anything.
 * The copy that holds the lock brings its window forward each time another launch is attempted.
 */
export function claimSingleInstance(app: InstanceApp, mainWindow: () => InstanceWindow | undefined): boolean {
  if (!app.requestSingleInstanceLock()) return false;
  app.on("second-instance", () => bringToFront(mainWindow()));
  return true;
}

export function bringToFront(window: InstanceWindow | undefined): void {
  // A launch while the first copy is still starting finds no window yet; that window shows itself once ready.
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
