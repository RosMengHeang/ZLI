import { needsYou, type RuntimeProjection } from "@zli-v2/contracts";

export type TrayMenuItem = { label: string; enabled?: boolean; click?: () => void } | { type: "separator" };

export type TrayLike = {
  setToolTip(text: string): void;
  setMenu(items: readonly TrayMenuItem[]): void;
  onClick(listener: () => void): void;
  /** Shows a one-time note, where the platform has one. */
  notify?(title: string, body: string): void;
  destroy(): void;
};

export type TrayHost = {
  createTray(): TrayLike;
  showWindow(): void;
  hideWindow(): void;
  quit(): void;
  command(command: Record<string, unknown>): Promise<unknown>;
};

/** Routines that are on need ZLI running, so closing the window hides it instead of quitting. */
export function keepsRunning(projection: RuntimeProjection | undefined): boolean {
  if (!projection || projection.buddySettings?.paused) return false;
  return (projection.routines ?? []).some((routine) => !routine.paused);
}

/**
 * The tray icon for buddies that keep working while the window is closed. It exists only while a
 * routine is on. Quit in its menu always stops everything.
 */
export class TrayController {
  private tray: TrayLike | undefined;
  private noted = false;

  constructor(private readonly host: TrayHost) {}

  get active(): boolean {
    return this.tray !== undefined;
  }

  update(projection: RuntimeProjection | undefined): void {
    if (!keepsRunning(projection)) {
      this.tray?.destroy();
      this.tray = undefined;
      return;
    }
    if (!this.tray) {
      this.tray = this.host.createTray();
      this.tray.onClick(() => this.host.showWindow());
    }
    const waiting = needsYou(projection ?? {}).length;
    const paused = projection?.buddySettings?.paused ?? false;
    this.tray.setToolTip(waiting > 0 ? `ZLI · ${waiting} need${waiting === 1 ? "s" : ""} you` : "ZLI · buddies are on");
    this.tray.setMenu([
      { label: "Open ZLI", click: () => this.host.showWindow() },
      {
        label: waiting > 0 ? `Needs you (${waiting})` : "Nothing needs you",
        enabled: waiting > 0,
        click: () => this.host.showWindow(),
      },
      { type: "separator" },
      {
        label: paused ? "Resume buddies" : "Pause all buddies",
        click: () => void this.host.command({ type: paused ? "buddies.resume" : "buddies.pause" }),
      },
      { type: "separator" },
      { label: "Quit ZLI", click: () => this.host.quit() },
    ]);
  }

  /** The window is closing. Returns true when it was hidden to the tray instead. */
  hideOnClose(): boolean {
    if (!this.tray) return false;
    this.host.hideWindow();
    if (!this.noted) {
      this.noted = true;
      this.tray.notify?.(
        "ZLI is still running",
        "Your buddies' routines keep running from the tray. Quit from the tray menu to stop them.",
      );
    }
    return true;
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = undefined;
  }
}
