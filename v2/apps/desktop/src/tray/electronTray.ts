import { Menu, nativeImage, Tray } from "electron";

import type { TrayLike, TrayMenuItem } from "./TrayController.js";

/** The real tray icon behind TrayController. */
export function createElectronTray(iconPath: string | undefined): TrayLike {
  const image = iconPath
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();
  const tray = new Tray(image);
  return {
    setToolTip: (text) => tray.setToolTip(text),
    setMenu: (items: readonly TrayMenuItem[]) =>
      tray.setContextMenu(
        Menu.buildFromTemplate(
          items.map((item) =>
            "type" in item
              ? { type: "separator" as const }
              : { label: item.label, enabled: item.enabled ?? true, ...(item.click ? { click: item.click } : {}) },
          ),
        ),
      ),
    onClick: (listener) => {
      tray.on("click", listener);
    },
    notify: (title, content) => {
      if (process.platform === "win32") tray.displayBalloon({ title, content });
    },
    destroy: () => tray.destroy(),
  };
}
