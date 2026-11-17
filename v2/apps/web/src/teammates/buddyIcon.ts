import type { BuddyLook } from "@zli-v2/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TileArt } from "./BuddyAvatar.js";

import type { Buddy } from "./buddies.js";

const ICON_SIZE = 96;
const cache = new Map<string, Promise<string | undefined>>();

/** The buddy as a PNG data URL, for places outside the page such as system notifications. */
export function buddyIcon(buddy: Buddy, look?: BuddyLook): Promise<string | undefined> {
  const key = `${buddy}:${look ?? ""}`;
  const known = cache.get(key);
  if (known) return known;
  const made = draw(buddy, look).catch(() => undefined);
  cache.set(key, made);
  return made;
}

/** The buddy's static SVG markup, colors inline, with no stylesheet needed. */
export function buddySvg(buddy: Buddy, size = ICON_SIZE, look?: BuddyLook): string {
  return renderToStaticMarkup(createElement(TileArt, { buddy, size, look }));
}

async function draw(buddy: Buddy, look?: BuddyLook): Promise<string | undefined> {
  if (typeof document === "undefined" || typeof Image === "undefined") return undefined;
  const image = new Image(ICON_SIZE, ICON_SIZE);
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(buddySvg(buddy, ICON_SIZE, look))}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE);
  return canvas.toDataURL("image/png");
}
