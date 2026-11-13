/**
 * Buddies: the small characters that agents and chats wear. A buddy is a body and a color. It is stored as a
 * plain string, the body alone when it wears its own color ("cloud") or the body and a picked color
 * ("cloud/jade"), so it works as a map key and in saved settings.
 */
export const BUDDY_BODIES = [
  "gumdrop",
  "capsule",
  "plus",
  "cloud",
  "mushroom",
  "peanut",
  "jelly",
  "wedge",
  "squircle",
  "bulb",
  "house",
  "bean",
] as const;
export type BuddyBody = (typeof BUDDY_BODIES)[number];

export const BUDDY_COLORS = {
  paper: { label: "Paper", hex: "#ece8df" },
  clay: { label: "Clay", hex: "#c9825b" },
  tomato: { label: "Tomato", hex: "#ef5a47" },
  tangerine: { label: "Tangerine", hex: "#ff8a3d" },
  butter: { label: "Butter", hex: "#f2cf5b" },
  lime: { label: "Lime", hex: "#a6d44f" },
  jade: { label: "Jade", hex: "#2fbf8f" },
  sky: { label: "Sky", hex: "#4aa8ff" },
  indigo: { label: "Indigo", hex: "#6f6cf6" },
  orchid: { label: "Orchid", hex: "#c56ff0" },
  rose: { label: "Rose", hex: "#ff7aa8" },
  slate: { label: "Slate", hex: "#8a93a3" },
} as const;
export type BuddyColor = keyof typeof BUDDY_COLORS;
export const BUDDY_COLOR_NAMES = Object.keys(BUDDY_COLORS) as BuddyColor[];

export type Buddy = BuddyBody | `${BuddyBody}/${BuddyColor}`;

/** Each body's own color. Chats and unsaved agents wear these, so neighbours differ in shape and color. */
export const SIGNATURE: Record<BuddyBody, BuddyColor> = {
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

export const bodyLabel: Record<BuddyBody, string> = {
  gumdrop: "Gumdrop",
  capsule: "Capsule",
  plus: "Plus",
  cloud: "Cloud",
  mushroom: "Mushroom",
  peanut: "Peanut",
  jelly: "Jelly",
  wedge: "Wedge",
  squircle: "Squircle",
  bulb: "Bulb",
  house: "House",
  bean: "Bean",
};

/** The animals that came before buddies, so saved teammates and chats keep a matching look. */
const LEGACY: Record<string, BuddyBody> = {
  fox: "gumdrop",
  owl: "squircle",
  otter: "jelly",
  cat: "cloud",
  panda: "bean",
  penguin: "mushroom",
  bear: "peanut",
  rabbit: "plus",
  frog: "capsule",
  chick: "wedge",
};

export function isBuddyBody(value: unknown): value is BuddyBody {
  return typeof value === "string" && (BUDDY_BODIES as readonly string[]).includes(value);
}

function isBuddyColor(value: unknown): value is BuddyColor {
  return typeof value === "string" && Object.hasOwn(BUDDY_COLORS, value);
}

/** A saved look as a buddy: a body, a body and color, or one of the old animals. Undefined when it is none. */
export function parseBuddy(value: unknown): Buddy | undefined {
  if (typeof value !== "string") return undefined;
  const [first, color] = value.split("/");
  const body = isBuddyBody(first) ? first : first ? LEGACY[first] : undefined;
  if (!body) return undefined;
  return isBuddyColor(color) ? makeBuddy(body, color) : body;
}

export function makeBuddy(body: BuddyBody, color: BuddyColor): Buddy {
  return color === SIGNATURE[body] ? body : `${body}/${color}`;
}

export function buddyBody(buddy: Buddy): BuddyBody {
  return buddy.split("/")[0] as BuddyBody;
}

export function buddyColor(buddy: Buddy): BuddyColor {
  const color = buddy.split("/")[1];
  return isBuddyColor(color) ? color : SIGNATURE[buddyBody(buddy)];
}

export function buddyHex(buddy: Buddy): string {
  return BUDDY_COLORS[buddyColor(buddy)].hex;
}

/** What a buddy is called, such as "Cloud". A guest brought into a chat takes this as its name. */
export function buddyName(buddy: Buddy): string {
  return bodyLabel[buddyBody(buddy)];
}
