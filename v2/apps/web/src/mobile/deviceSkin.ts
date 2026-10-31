import type { MobileDevice } from "@zli-v2/contracts";

export type SkinShape = "phone" | "tablet";
/** The camera in the screen: a round hole on Android phones, a pill on iPhones, none on older 16:9 screens. */
export type SkinCutout = "punch-hole" | "island" | "none";
export type SkinOrientation = "portrait" | "landscape";
export type SkinEdge = "left" | "right" | "top" | "bottom";
export type SideButtonName = "power" | "volume_up" | "volume_down";

/** A button on the body's edge. start and length are shares of that edge, measured from its top or left end. */
export type SideButton = {
  name: SideButtonName;
  label: string;
  edge: SkinEdge;
  start: number;
  length: number;
  /** False where the device cannot press it, such as the volume buttons idb has no command for. */
  pressable: boolean;
};

export type DeviceSkin = {
  shape: SkinShape;
  cutout: SkinCutout;
  orientation: SkinOrientation;
  buttons: SideButton[];
};

/** The body around the screen, in the frame's own pixels. */
export type SkinGeometry = {
  /** The even border between the screen and the body's outer edge, metal rim included. */
  bezel: number;
  width: number;
  height: number;
  /** The body's corner radius; the screen's corners follow it, inset by the bezel. */
  radius: number;
  screenRadius: number;
  /** The metal rim drawn on the outer edge of the bezel. */
  rim: number;
};

/** Phones are taller than about 5:3; anything squarer, such as 16:10 or 4:3, is drawn as a tablet. */
const TABLET_MIN_SHARE = 0.6;
/** 16:9 phones came before screen cutouts, so only taller screens get a camera hole or island. */
const CUTOUT_MIN_ASPECT = 1.9;
const TABLET_NAME = /\b(?:tablet|tab|ipad)\b/iu;
const PHONE_NAME = /\b(?:phone|iphone)\b|\bpixel \d/iu;

/**
 * The generic body to draw around a device's screen. The shape comes from the name when it says phone or
 * tablet and from the screen's proportions otherwise; the frame's own width and height say which way the
 * device is turned, so the body rotates with it.
 */
export function deviceSkin(
  device: Pick<MobileDevice, "platform" | "name">,
  frame: { width: number; height: number },
): DeviceSkin {
  const short = Math.min(frame.width, frame.height);
  const long = Math.max(frame.width, frame.height);
  const share = long > 0 ? short / long : 0.5;
  // AVD names such as Pixel_Tablet_API_34 use underscores, which \b does not treat as a word break.
  const name = device.name.replace(/[_.-]+/gu, " ");
  const shape: SkinShape = TABLET_NAME.test(name)
    ? "tablet"
    : PHONE_NAME.test(name) || share < TABLET_MIN_SHARE
      ? "phone"
      : "tablet";
  const orientation: SkinOrientation = frame.width > frame.height ? "landscape" : "portrait";
  const ios = device.platform === "ios";
  const cutout: SkinCutout =
    shape === "tablet" || share <= 0 || 1 / share < CUTOUT_MIN_ASPECT ? "none" : ios ? "island" : "punch-hole";
  const portrait = portraitButtons(shape, ios);
  return { shape, cutout, orientation, buttons: orientation === "portrait" ? portrait : portrait.map(turned) };
}

/** Where the buttons sit with the device upright. iPhones keep volume on the left and power on the right. */
function portraitButtons(shape: SkinShape, ios: boolean): SideButton[] {
  const power = (edge: SkinEdge, start: number, length: number): SideButton => ({
    name: "power",
    label: "Power",
    edge,
    start,
    length,
    pressable: true,
  });
  const volume = (edge: SkinEdge, start: number, length: number): SideButton[] => [
    { name: "volume_up", label: "Volume up", edge, start, length, pressable: !ios },
    { name: "volume_down", label: "Volume down", edge, start: start + length + 0.008, length, pressable: !ios },
  ];
  if (shape === "tablet") return [power("top", 0.8, 0.08), ...volume("right", 0.08, 0.055)];
  if (ios) return [...volume("left", 0.22, 0.07), power("right", 0.25, 0.11)];
  return [power("right", 0.2, 0.075), ...volume("right", 0.31, 0.075)];
}

/**
 * A button's place once the device is turned a quarter to the left, the way Android turns into landscape:
 * the right edge becomes the top, the left edge the bottom, and the top edge the left.
 */
function turned(button: SideButton): SideButton {
  switch (button.edge) {
    case "right":
      return { ...button, edge: "top" };
    case "left":
      return { ...button, edge: "bottom" };
    case "top":
      return { ...button, edge: "left", start: 1 - button.start - button.length };
    case "bottom":
      return { ...button, edge: "right", start: 1 - button.start - button.length };
  }
}

/** Shares of the screen's short side, close to current hardware: a thin phone bezel and a wider tablet one. */
const BEZEL = { phone: 0.042, tablet: 0.068 } as const;
/** Shares of the body's short side. Phones without a cutout have the squarer corners of their era. */
const RADIUS = { phone: 0.14, phoneSquare: 0.075, tablet: 0.07 } as const;
const RIM = 0.011;

export function skinGeometry(skin: DeviceSkin, frame: { width: number; height: number }): SkinGeometry {
  const short = Math.max(1, Math.min(frame.width, frame.height));
  const bezel = Math.round(short * BEZEL[skin.shape]);
  const bodyShort = short + 2 * bezel;
  const radiusShare =
    skin.shape === "tablet" ? RADIUS.tablet : skin.cutout === "none" ? RADIUS.phoneSquare : RADIUS.phone;
  const radius = Math.round(bodyShort * radiusShare);
  return {
    bezel,
    width: frame.width + 2 * bezel,
    height: frame.height + 2 * bezel,
    radius,
    screenRadius: Math.max(Math.round(short * 0.012), radius - bezel),
    rim: Math.max(1, Math.round(bodyShort * RIM)),
  };
}
