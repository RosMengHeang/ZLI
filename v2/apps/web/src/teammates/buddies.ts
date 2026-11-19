/**
 * Buddies: the face tiles that agents and chats wear. Every buddy is the same rounded square with two eyes; only
 * the color changes. A buddy is stored as its color name ("sky"), so it works as a map key and in saved settings.
 */
export const BUDDY_COLORS = {
  sky: { label: "Sky", hex: "#4aa8ff" },
  indigo: { label: "Indigo", hex: "#6f6cf6" },
  orchid: { label: "Orchid", hex: "#c56ff0" },
  rose: { label: "Rose", hex: "#ff7aa8" },
  tomato: { label: "Tomato", hex: "#ef5a47" },
  tangerine: { label: "Tangerine", hex: "#ff8a3d" },
  butter: { label: "Butter", hex: "#f2cf5b" },
  lime: { label: "Lime", hex: "#a6d44f" },
  jade: { label: "Jade", hex: "#2fbf8f" },
  clay: { label: "Clay", hex: "#c9825b" },
  paper: { label: "Paper", hex: "#ece8df" },
  slate: { label: "Slate", hex: "#8a93a3" },
} as const;
export type BuddyColor = keyof typeof BUDDY_COLORS;
/** The 12 colors in picker order. */
export const BUDDY_COLOR_NAMES = Object.keys(BUDDY_COLORS) as BuddyColor[];

export type Buddy = BuddyColor;

/** Buddies once had 12 body shapes, each with its own color; a look saved as a body keeps that color. */
const BODY_COLOR: Record<string, BuddyColor> = {
  gumdrop: "tangerine",
  capsule: "lime",
  plus: "rose",
  cloud: "sky",
  mushroom: "indigo",
  peanut: "clay",
  jelly: "jade",
  wedge: "butter",
  squircle: "paper",
  bulb: "orchid",
  house: "tomato",
  bean: "slate",
};

/** And before bodies, teammates were animals. */
const ANIMAL_COLOR: Record<string, BuddyColor> = {
  fox: "tangerine",
  owl: "paper",
  otter: "jade",
  cat: "sky",
  panda: "slate",
  penguin: "indigo",
  bear: "clay",
  rabbit: "rose",
  frog: "lime",
  chick: "butter",
};

export function isBuddyColor(value: unknown): value is BuddyColor {
  return typeof value === "string" && Object.hasOwn(BUDDY_COLORS, value);
}

/**
 * A saved look as a buddy: a color, an old body ("cloud") or body and color ("cloud/jade"), or an old animal.
 * Undefined when it is none of these.
 */
export function parseBuddy(value: unknown): Buddy | undefined {
  if (typeof value !== "string") return undefined;
  if (isBuddyColor(value)) return value;
  const [first = "", color] = value.split("/");
  if (isBuddyColor(color) && Object.hasOwn(BODY_COLOR, first)) return color;
  if (Object.hasOwn(BODY_COLOR, first)) return BODY_COLOR[first];
  if (Object.hasOwn(ANIMAL_COLOR, first)) return ANIMAL_COLOR[first];
  return undefined;
}

export function buddyHex(buddy: Buddy): string {
  return BUDDY_COLORS[buddy].hex;
}

/** What a buddy is called, such as "Sky". A guest brought into a chat takes this as its name. */
export function buddyName(buddy: Buddy): string {
  return BUDDY_COLORS[buddy].label;
}
