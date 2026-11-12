import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AnimalArt } from "./AnimalAvatar.js";
import type { Animal } from "./teammates.js";

const ICON_SIZE = 96;
const cache = new Map<Animal, Promise<string | undefined>>();

/** The animal as a PNG data URL, for places outside the page such as system notifications. */
export function animalIcon(animal: Animal): Promise<string | undefined> {
  const known = cache.get(animal);
  if (known) return known;
  const made = draw(animal).catch(() => undefined);
  cache.set(animal, made);
  return made;
}

async function draw(animal: Animal): Promise<string | undefined> {
  if (typeof document === "undefined" || typeof Image === "undefined") return undefined;
  const svg = renderToStaticMarkup(createElement(AnimalArt, { animal, size: ICON_SIZE }));
  const image = new Image(ICON_SIZE, ICON_SIZE);
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE);
  return canvas.toDataURL("image/png");
}
