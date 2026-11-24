import type { CSSProperties } from "react";

import type { SidebarLook, WindowLayout } from "../settings/appSettings.js";

/**
 * The classes the sidebar takes: a box of its own in the Classic layout (Columns keeps it flush with the
 * window edge), compact rows, and the chat's background.
 */
export function sidebarLookClass(look: SidebarLook, layout: WindowLayout): string {
  return `${layout === "classic" ? " is-floating" : ""}${look.density === "compact" ? " is-dense" : ""}${
    look.background === "surface" ? " has-backdrop" : ""
  }`;
}

/**
 * The sidebar's color, set on the sidebar itself so every ring and mask that reads `--zli-sidebar` follows it.
 * The theme's color sets nothing.
 */
export function sidebarLookStyle(look: SidebarLook): CSSProperties | undefined {
  if (look.background === "surface") return { "--zli-sidebar": "var(--zli-surface)" } as CSSProperties;
  if (look.background === "tint") {
    const color = look.color ?? "var(--zli-accent)";
    // The theme's sidebar is read from the root, since this element redefines the same name.
    return {
      "--zli-sidebar": `color-mix(in srgb, ${color} ${look.strength}%, var(--zli-sidebar-base))`,
    } as CSSProperties;
  }
  return undefined;
}
