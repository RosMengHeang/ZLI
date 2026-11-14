import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Buddy } from "./buddies.js";
import { BuddyArt } from "./BuddyAvatar.js";

const ICON_SIZE = 96;
const cache = new Map<Buddy, Promise<string | undefined>>();

/** The buddy as a PNG data URL, for places outside the page such as system notifications. */
export function buddyIcon(buddy: Buddy): Promise<string | undefined> {
  const known = cache.get(buddy);
  if (known) return known;
  const made = draw(buddy).catch(() => undefined);
  cache.set(buddy, made);
  return made;
}

/** The buddy's static SVG markup, colors inline, with no stylesheet needed. */
export function buddySvg(buddy: Buddy, size = ICON_SIZE): string {
  return renderToStaticMarkup(createElement(BuddyArt, { buddy, size }));
}

async function draw(buddy: Buddy): Promise<string | undefined> {
  if (typeof document === "undefined" || typeof Image === "undefined") return undefined;
  const image = new Image(ICON_SIZE, ICON_SIZE);
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(buddySvg(buddy))}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE);
  return canvas.toDataURL("image/png");
}
