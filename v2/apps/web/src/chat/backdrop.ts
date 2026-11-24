/**
 * The chat background. Five drawn looks share one color (the theme accent unless the person picks one):
 * a soft wash along the bottom edge, a field of fine dots rising from the bottom, and dither pixels, a soft aurora, or halftone dots gathered in the
 * corners. A fifth look shows the person's own picture as a photo, blurred, dithered, or in halftone.
 * The canvas stays transparent outside its marks, so the theme's surface shows through.
 */

export type BackdropStyle = "glow" | "dots" | "dither" | "aurora" | "halftone" | "image" | "off";
export type ImageEffect = "photo" | "blur" | "dither" | "halftone";

export const BACKDROP_STYLES: readonly BackdropStyle[] = [
  "glow",
  "dots",
  "dither",
  "aurora",
  "halftone",
  "image",
  "off",
];
export const IMAGE_EFFECTS: readonly ImageEffect[] = ["photo", "blur", "dither", "halftone"];
export const DEFAULT_BACKDROP_STYLE: BackdropStyle = "glow";
export const DEFAULT_IMAGE_EFFECT: ImageEffect = "photo";
export const DEFAULT_BACKDROP_INTENSITY = 60;

export const BACKDROP_NAMES: Record<BackdropStyle, string> = {
  glow: "Soft",
  dots: "Dots",
  dither: "Dither",
  aurora: "Aurora",
  halftone: "Halftone",
  image: "Image",
  off: "Off",
};

export const IMAGE_EFFECT_NAMES: Record<ImageEffect, string> = {
  photo: "Photo",
  blur: "Blur",
  dither: "Dither",
  halftone: "Halftone",
};

/** Colors offered next to "Theme" in Settings. Each reads on both dark and light surfaces. */
export const BACKDROP_SWATCHES: readonly { name: string; hex: string }[] = [
  { name: "Blue", hex: "#4a6fdc" },
  { name: "Violet", hex: "#8b5cf6" },
  { name: "Teal", hex: "#14b8a6" },
  { name: "Green", hex: "#22c55e" },
  { name: "Amber", hex: "#f59e0b" },
  { name: "Rose", hex: "#f43f5e" },
  { name: "Silver", hex: "#c8c8d0" },
];

export type Rgb = readonly [number, number, number];

export function isBackdropStyle(value: unknown): value is BackdropStyle {
  return BACKDROP_STYLES.includes(value as BackdropStyle);
}

export function isImageEffect(value: unknown): value is ImageEffect {
  return IMAGE_EFFECTS.includes(value as ImageEffect);
}

export function clampIntensity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_BACKDROP_INTENSITY;
  return Math.round(Math.min(100, Math.max(0, value)));
}

/** A `#rrggbb` color, lower-cased, or undefined for anything else. */
export function normalizeHex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^#?([0-9a-f]{6})$/iu.exec(value.trim());
  return match?.[1] ? `#${match[1].toLowerCase()}` : undefined;
}

export function hexToRgb(hex: string): Rgb | undefined {
  const normalized = normalizeHex(hex);
  if (!normalized) return undefined;
  const n = Number.parseInt(normalized.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * How strong the corner field is at a point, 0 to 1. Strongest in the top-left and bottom-right corners,
 * with some along the top right, and gently rippled so the edges are not perfect circles. Coordinates are
 * fractions of the width and height, so a small preview looks like the full view.
 */
export function backdropField(nx: number, ny: number, seed = 1.2): number {
  const ripple =
    Math.sin(nx * 5.1 + seed) * Math.cos(ny * 4.3 - seed * 0.7) * 0.5 +
    Math.sin((nx + ny) * 7.7 + seed * 1.3) * 0.25 +
    Math.sin(nx * 13.1 - ny * 9.4) * 0.12;
  const topLeft = Math.max(0, 1 - Math.hypot(nx - 0.02, ny) * 1.55);
  const bottomRight = Math.max(0, 1 - Math.hypot(nx - 1, ny - 1) * 1.35) * 1.15;
  const topRight = Math.max(0, 1 - Math.hypot(nx - 0.95, ny) * 1.9) * 0.75;
  const value = (topLeft + bottomRight + topRight) * (0.62 + 0.38 * ripple);
  return Math.max(0, Math.min(1, value));
}

/**
 * How strong the soft look is at a point, 0 to 1: an even band along the bottom edge, the same across the
 * whole width so there is no bright spot, plus a faint tint in the top-left corner. Both are gone well
 * before the reading column.
 */
export function softField(nx: number, ny: number): number {
  const bottom = Math.max(0, (ny - 0.55) / 0.45) ** 2;
  const corner = Math.max(0, 1 - Math.hypot(nx, ny) / 0.6) ** 2 * 0.45;
  return Math.min(1, bottom + corner);
}

/** Reads any CSS color the canvas understands into red, green, and blue. */
export function parseColor(ctx: CanvasRenderingContext2D, color: string, fallback: Rgb): Rgb {
  const hex = hexToRgb(color);
  if (hex) return hex;
  ctx.fillStyle = "#000";
  ctx.fillStyle = color;
  const normalized = String(ctx.fillStyle);
  const fromCanvas = hexToRgb(normalized);
  if (fromCanvas) return fromCanvas;
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(normalized);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return fallback;
}

/** A lighter step of a color for the densest spots, mixed toward white. */
function lift([r, g, b]: Rgb, amount = 0.35): Rgb {
  return [Math.round(r + (255 - r) * amount), Math.round(g + (255 - g) * amount), Math.round(b + (255 - b) * amount)];
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

type Paint = { ctx: CanvasRenderingContext2D; width: number; height: number; color: Rgb; strength: number };

/** Smooth gradients with grain, no dots: the band along the bottom and the corner tint of `softField`. */
function drawSoft({ ctx, width, height, color, strength }: Paint) {
  const [r, g, b] = color;
  const band = ctx.createLinearGradient(0, height * 0.55, 0, height);
  for (const stop of [0, 0.25, 0.5, 0.75, 1]) {
    const alpha = Math.min(1, softField(0.5, 0.55 + stop * 0.45) * 0.22 * strength);
    band.addColorStop(stop, `rgba(${r},${g},${b},${alpha})`);
  }
  ctx.fillStyle = band;
  ctx.fillRect(0, height * 0.55, width, height * 0.45);
  const radius = Math.hypot(width, height) * 0.6;
  const corner = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
  corner.addColorStop(0, `rgba(${r},${g},${b},${Math.min(1, 0.1 * strength)})`);
  corner.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = corner;
  ctx.fillRect(0, 0, width, height);
  drawGrain(ctx, width, height);
}

/**
 * How strong the dots are at a point, 0 to 1: a wide dome rising from the bottom middle, at most 45% of the
 * height, fading out toward the sides and top.
 */
export function dotsField(nx: number, ny: number, height = 800): number {
  const reach = Math.min(0.45, 380 / Math.max(1, height));
  const distance = Math.hypot((nx - 0.5) / 0.55, (1 - ny) / reach);
  if (distance >= 0.8) return 0;
  return distance < 0.55 ? 1 - (distance / 0.55) * 0.76 : 0.24 * (1 - (distance - 0.55) / 0.25);
}

/** Even, tiny dots on a 4px grid, each as strong as `dotsField` at its spot. */
function drawDots({ ctx, width, height, color, strength }: Paint, step = 4) {
  const [r, g, b] = color;
  const top = height * (1 - Math.min(0.45, 380 / height));
  for (let y = step / 2 + Math.floor(top / step) * step; y < height; y += step) {
    for (let x = step / 2; x < width; x += step) {
      const value = dotsField(x / width, y / height, height);
      if (value <= 0) continue;
      ctx.fillStyle = `rgba(${r},${g},${b},${Math.min(1, value * 0.55 * strength)})`;
      ctx.beginPath();
      ctx.arc(x, y, 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawDither({ ctx, width, height, color, strength }: Paint, cell = 5) {
  const bright = lift(color);
  for (let y = 0, row = 0; y < height; y += cell, row++) {
    for (let x = 0, col = 0; x < width; x += cell, col++) {
      const value = backdropField(x / width, y / height);
      const threshold = BAYER[(row % 4) * 4 + (col % 4)] ?? 0.5;
      if (value <= 0.18 || value <= threshold * 1.05) continue;
      const level = value > 0.72 ? 1 : value > 0.45 ? 0.62 : 0.34;
      const [r, g, b] = value > 0.8 ? bright : color;
      ctx.fillStyle = `rgba(${r},${g},${b},${Math.min(1, (0.08 + 0.55 * level * value) * strength)})`;
      ctx.fillRect(x, y, cell - 1, cell - 1);
    }
  }
}

function drawHalftone({ ctx, width, height, color, strength }: Paint, step = 11) {
  const bright = lift(color);
  for (let y = step / 2, row = 0; y < height; y += step, row++) {
    for (let x = step / 2 + (row % 2 ? step / 2 : 0); x < width; x += step) {
      const value = backdropField(x / width, y / height, 2.4);
      if (value < 0.05) continue;
      const [r, g, b] = value > 0.75 ? bright : color;
      ctx.fillStyle = `rgba(${r},${g},${b},${Math.min(1, (0.18 + 0.6 * value) * strength)})`;
      ctx.beginPath();
      ctx.arc(x, y, 0.6 + value * step * 0.42, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawAurora({ ctx, width, height, color, strength }: Paint) {
  const [r, g, b] = color;
  // A cooler and a warmer neighbour of the color, so the glow has some depth without new hues.
  const cool: Rgb = [
    Math.round(r * 0.55),
    Math.round(Math.min(255, g * 0.9 + 30)),
    Math.round(Math.min(255, b * 0.8 + 20)),
  ];
  const warm: Rgb = [Math.round(Math.min(255, r * 1.25 + 20)), Math.round(g * 0.65), Math.round(b * 0.9)];
  const blobs: readonly [number, number, number, Rgb, number][] = [
    [0.08, 0.05, 0.55, color, 0.55],
    [0.95, 0.98, 0.6, warm, 0.5],
    [0.75, 0, 0.35, cool, 0.28],
    [0.2, 1.05, 0.35, color, 0.25],
  ];
  const size = Math.max(width, height);
  for (const [bx, by, radius, [cr, cg, cb], alpha] of blobs) {
    const gradient = ctx.createRadialGradient(bx * width, by * height, 0, bx * width, by * height, radius * size);
    gradient.addColorStop(0, `rgba(${cr},${cg},${cb},${Math.min(1, alpha * strength)})`);
    gradient.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
  drawGrain(ctx, width, height);
}

function drawGrain(ctx: CanvasRenderingContext2D, width: number, height: number) {
  grain ??= grainTile();
  const pattern = grain ? ctx.createPattern(grain, "repeat") : null;
  if (!pattern) return;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, width, height);
}

/** Fine grain over the smooth looks, so its gradients do not band. Drawn once into a small tile and repeated. */
function grainTile(): HTMLCanvasElement | undefined {
  if (typeof document === "undefined") return undefined;
  const tile = document.createElement("canvas");
  tile.width = 128;
  tile.height = 128;
  const ctx = tile.getContext("2d");
  if (!ctx) return undefined;
  const image = ctx.createImageData(128, 128);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = Math.random() * 255;
    image.data[i] = v;
    image.data[i + 1] = v;
    image.data[i + 2] = v;
    image.data[i + 3] = 14;
  }
  ctx.putImageData(image, 0, 0);
  return tile;
}

let grain: HTMLCanvasElement | undefined;

/** Where a picture lands so it covers the whole area without stretching, centered. */
export function coverRect(imageWidth: number, imageHeight: number, width: number, height: number) {
  const scale = Math.max(width / imageWidth, height / imageHeight);
  const w = imageWidth * scale;
  const h = imageHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

/** The picture shrunk to one pixel per cell, read back so each cell knows its color and brightness. */
function sample(
  image: CanvasImageSource & { width: number; height: number },
  width: number,
  height: number,
  cell: number,
) {
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  const small = document.createElement("canvas");
  small.width = cols;
  small.height = rows;
  const ctx = small.getContext("2d", { willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.imageSmoothingQuality = "high";
  const rect = coverRect(image.width, image.height, cols, rows);
  ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h);
  return { cols, rows, data: ctx.getImageData(0, 0, cols, rows).data };
}

/**
 * How much of a picture shows at a point, 0 to 1: all of the top half, thinning toward the bottom and the
 * side edges, so the picture dissolves into the surface instead of ending on a hard line.
 */
export function imageFade(nx: number, ny: number): number {
  const down = ny < 0.45 ? 1 : Math.max(0, 1 - ((ny - 0.45) / 0.55) ** 1.4);
  const side = Math.min(1, Math.min(nx, 1 - nx) / 0.12);
  return down * (0.35 + 0.65 * side);
}

/** Brighter shadows and a little more contrast, so a dark photo still leaves enough marks to read. */
function tone(light: number): number {
  return Math.min(1, Math.max(0, (light ** 0.6 - 0.06) / 0.86));
}

/** The color scaled up to the brightness its mark stands for, so dark parts of a photo do not turn to mud. */
function brighten([r, g, b]: Rgb, light: number): Rgb {
  const scale = Math.min(2.4, Math.max(1, tone(light) / Math.max(0.04, light)));
  return [
    Math.min(255, Math.round(r * scale)),
    Math.min(255, Math.round(g * scale)),
    Math.min(255, Math.round(b * scale)),
  ];
}

/** A color pushed away from its own gray, so small marks keep the picture's color. */
function saturate([r, g, b]: Rgb, amount = 1.35): Rgb {
  const gray = (r + g + b) / 3;
  const push = (v: number) => Math.round(Math.min(255, Math.max(0, gray + (v - gray) * amount)));
  return [push(r), push(g), push(b)];
}

/** Masks what is already drawn with `imageFade`, for the photo and the blur. */
function fadeEdges(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  const down = ctx.createLinearGradient(0, 0, 0, height);
  for (const stop of [0, 0.45, 0.6, 0.75, 0.9, 1]) down.addColorStop(stop, `rgba(0,0,0,${imageFade(0.5, stop)})`);
  ctx.fillStyle = down;
  ctx.fillRect(0, 0, width, height);
  const side = ctx.createLinearGradient(0, 0, width, 0);
  for (const stop of [0, 0.06, 0.12, 0.88, 0.94, 1]) side.addColorStop(stop, `rgba(0,0,0,${imageFade(stop, 0)})`);
  ctx.fillStyle = side;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/**
 * Dither: a fine grid of 2px squares in the picture's own colors. A square shows where the toned
 * brightness beats its Bayer threshold, and the darks keep a faint square, so the shape reads even in
 * shadow. Written as pixels into a small canvas, then drawn up without smoothing.
 */
function drawDitheredImage(
  ctx: CanvasRenderingContext2D,
  sampled: { cols: number; rows: number; data: Uint8ClampedArray },
  cell: number,
  opacity: number,
) {
  const { cols, rows, data } = sampled;
  const out = document.createElement("canvas");
  out.width = cols * cell;
  out.height = rows * cell;
  const outCtx = out.getContext("2d");
  if (!outCtx) return;
  const pixels = outCtx.createImageData(out.width, out.height);
  const dot = cell - 1;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = (row * cols + col) * 4;
      const color: Rgb = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
      const fade = imageFade(col / cols, row / rows);
      const light = (0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]) / 255;
      const level = tone(light) * fade;
      const threshold = BAYER[(row % 4) * 4 + (col % 4)] ?? 0.5;
      const on = level > threshold;
      if (!on && level < 0.03) continue;
      const [r, g, b] = on ? saturate(brighten(color, light)) : color;
      const alpha = Math.round(255 * Math.min(1, on ? opacity : opacity * 0.16 * fade));
      for (let y = 0; y < dot; y++) {
        let p = ((row * cell + y) * out.width + col * cell) * 4;
        for (let x = 0; x < dot; x++, p += 4) {
          pixels.data[p] = r;
          pixels.data[p + 1] = g;
          pixels.data[p + 2] = b;
          pixels.data[p + 3] = alpha;
        }
      }
    }
  }
  outCtx.putImageData(pixels, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(out, 0, 0);
  ctx.restore();
}

function drawImage(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  image: HTMLImageElement,
  effect: ImageEffect,
  strength: number,
) {
  if (!image.complete || image.naturalWidth === 0) return;
  const opacity = Math.min(1, 0.3 + 0.7 * strength);
  if (effect === "photo" || effect === "blur") {
    const rect = coverRect(image.naturalWidth, image.naturalHeight, width, height);
    ctx.save();
    ctx.globalAlpha = opacity;
    if (effect === "blur") {
      // Drawn a little larger so the blur does not pull the dark edge in.
      ctx.filter = "blur(36px) saturate(1.5) brightness(1.3)";
      ctx.drawImage(image, rect.x - 60, rect.y - 60, rect.w + 120, rect.h + 120);
    } else {
      ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h);
    }
    ctx.restore();
    if (effect === "blur") fadeEdges(ctx, width, height);
    return;
  }
  const cell = effect === "dither" ? 3 : 7;
  const sampled = sample(image, width, height, cell);
  if (!sampled) return;
  if (effect === "dither") {
    drawDitheredImage(ctx, sampled, cell, opacity);
    return;
  }
  // Halftone: round dots on a staggered grid, sized by the toned brightness, in the picture's colors.
  const { cols, rows, data } = sampled;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = (row * cols + col) * 4;
      const color: Rgb = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
      const fade = imageFade(col / cols, row / rows);
      const light = (0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]) / 255;
      const level = tone(light) * fade;
      const radius = Math.sqrt(level) * cell * 0.56;
      if (radius < 0.5) continue;
      const [r, g, b] = saturate(brighten(color, light));
      ctx.fillStyle = `rgba(${r},${g},${b},${opacity})`;
      ctx.beginPath();
      ctx.arc(col * cell + cell / 2 + (row % 2 ? cell / 2 : 0), row * cell + cell / 2, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export type BackdropDrawing = {
  style: BackdropStyle;
  color: Rgb;
  intensity: number;
  image?: HTMLImageElement | undefined;
  imageEffect?: ImageEffect;
  /** The sidebar draws its own version of each look, shaped for a tall, narrow column. */
  place?: BackdropPlace;
};

export type BackdropPlace = "chat" | "sidebar";

/*
 * The sidebar's versions. Each keeps its look's character but is drawn for a tall, narrow column with text
 * running edge to edge: the marks gather at the bottom and along the edge that meets the chat, never behind
 * the project and chat names at the top left.
 */

/** Soft: a glow rising from the bottom and a faint light along the edge that meets the chat. */
export function sidebarSoftField(nx: number, ny: number): number {
  const bottom = Math.max(0, (ny - 0.6) / 0.4) ** 2;
  const edge = Math.max(0, (nx - 0.7) / 0.3) ** 2 * 0.35 * (0.4 + 0.6 * ny);
  return Math.min(1, bottom + edge);
}

function drawSidebarSoft({ ctx, width, height, color, strength }: Paint) {
  const [r, g, b] = color;
  const band = ctx.createLinearGradient(0, height * 0.6, 0, height);
  band.addColorStop(0, `rgba(${r},${g},${b},0)`);
  band.addColorStop(1, `rgba(${r},${g},${b},${Math.min(1, 0.26 * strength)})`);
  ctx.fillStyle = band;
  ctx.fillRect(0, height * 0.6, width, height * 0.4);
  const edge = ctx.createLinearGradient(width * 0.7, 0, width, 0);
  edge.addColorStop(0, `rgba(${r},${g},${b},0)`);
  edge.addColorStop(1, `rgba(${r},${g},${b},${Math.min(1, 0.1 * strength)})`);
  ctx.fillStyle = edge;
  ctx.fillRect(width * 0.7, 0, width * 0.3, height);
  drawGrain(ctx, width, height);
}

/** Dots: a strip of fine dots down the edge that meets the chat, thickest near the bottom. */
export function sidebarDotsField(nx: number, ny: number): number {
  return Math.max(0, (nx - 0.55) / 0.45) ** 1.5 * (0.3 + 0.7 * ny);
}

function drawSidebarDots({ ctx, width, height, color, strength }: Paint, step = 5) {
  const [r, g, b] = color;
  const left = step / 2 + Math.floor((width * 0.55) / step) * step;
  for (let y = step / 2; y < height; y += step) {
    for (let x = left; x < width; x += step) {
      const value = sidebarDotsField(x / width, y / height);
      if (value <= 0.02) continue;
      ctx.fillStyle = `rgba(${r},${g},${b},${Math.min(1, value * 0.6 * strength)})`;
      ctx.beginPath();
      ctx.arc(x, y, 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** How far up a bottom ramp a row sits, 0 at `from` to 1 at the bottom edge. */
export function sidebarRampField(ny: number, from = 0.55): number {
  return Math.max(0, Math.min(1, (ny - from) / (1 - from)));
}

/** Dither: an ordered-dither ramp rising from the bottom, like ground under the list. */
function drawSidebarDither({ ctx, width, height, color, strength }: Paint, cell = 4) {
  const [r, g, b] = color;
  const top = Math.floor((height * 0.55) / cell) * cell;
  for (let y = top, row = top / cell; y < height; y += cell, row++) {
    const value = sidebarRampField((y + cell / 2) / height);
    for (let x = 0, col = 0; x < width; x += cell, col++) {
      const threshold = BAYER[(row % 4) * 4 + (col % 4)] ?? 0.5;
      if (value <= threshold) continue;
      ctx.fillStyle = `rgba(${r},${g},${b},${Math.min(1, (0.1 + 0.3 * value) * strength)})`;
      ctx.fillRect(x, y, cell - 1, cell - 1);
    }
  }
}

/** Halftone: rows of dots that grow toward the bottom, the classic halftone fade. */
function drawSidebarHalftone({ ctx, width, height, color, strength }: Paint, step = 9) {
  const [r, g, b] = color;
  const from = 0.5;
  for (let y = height - step / 2, row = 0; y > height * from; y -= step, row++) {
    const value = sidebarRampField(y / height, from);
    const radius = 0.4 + value * step * 0.4;
    ctx.fillStyle = `rgba(${r},${g},${b},${Math.min(1, (0.14 + 0.4 * value) * strength)})`;
    for (let x = step / 2 + (row % 2 ? step / 2 : 0); x < width; x += step) {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Aurora: long, tall glows that drift down the column instead of pooling in corners. */
function drawSidebarAurora({ ctx, width, height, color, strength }: Paint) {
  const [r, g, b] = color;
  const cool: Rgb = [
    Math.round(r * 0.55),
    Math.round(Math.min(255, g * 0.9 + 30)),
    Math.round(Math.min(255, b * 0.8 + 20)),
  ];
  const warm: Rgb = [Math.round(Math.min(255, r * 1.25 + 20)), Math.round(g * 0.65), Math.round(b * 0.9)];
  // Each glow is a circle stretched to the column's height, so it reads as a ribbon.
  const stretch = Math.max(1, height / Math.max(1, width)) * 0.7;
  const blobs: readonly [number, number, number, Rgb, number][] = [
    [1, 0.15, 0.7, cool, 0.22],
    [0.1, 0.75, 0.8, color, 0.3],
    [0.95, 1, 0.6, warm, 0.3],
  ];
  for (const [bx, by, radius, [cr, cg, cb], alpha] of blobs) {
    ctx.save();
    ctx.scale(1, stretch);
    const cy = (by * height) / stretch;
    const gradient = ctx.createRadialGradient(bx * width, cy, 0, bx * width, cy, radius * width);
    gradient.addColorStop(0, `rgba(${cr},${cg},${cb},${Math.min(1, alpha * strength)})`);
    gradient.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height / stretch);
    ctx.restore();
  }
  drawGrain(ctx, width, height);
}

function drawSidebarBackdrop(paint: Paint, drawing: BackdropDrawing) {
  const { style } = drawing;
  if (style === "image") {
    // A picture is always blurred and kept quieter here, since the list sits over all of it.
    if (drawing.image) drawImage(paint.ctx, paint.width, paint.height, drawing.image, "blur", paint.strength * 0.6);
    return;
  }
  if (style === "glow") drawSidebarSoft(paint);
  else if (style === "dots") drawSidebarDots(paint);
  else if (style === "dither") drawSidebarDither(paint);
  else if (style === "halftone") drawSidebarHalftone(paint);
  else drawSidebarAurora(paint);
}

/**
 * Draws the background onto a canvas already sized to `width` by `height` CSS pixels (the context carries
 * the device pixel scale).
 */
export function drawBackdrop(ctx: CanvasRenderingContext2D, width: number, height: number, drawing: BackdropDrawing) {
  ctx.clearRect(0, 0, width, height);
  const { style } = drawing;
  if (style === "off" || width <= 0 || height <= 0) return;
  const strength = 0.25 + (clampIntensity(drawing.intensity) / 100) * 1.1;
  if (drawing.place === "sidebar") {
    drawSidebarBackdrop({ ctx, width, height, color: drawing.color, strength }, drawing);
    return;
  }
  if (style === "image") {
    if (drawing.image)
      drawImage(ctx, width, height, drawing.image, drawing.imageEffect ?? DEFAULT_IMAGE_EFFECT, strength);
    return;
  }
  const paint = { ctx, width, height, color: drawing.color, strength };
  if (style === "glow") drawSoft(paint);
  else if (style === "dots") drawDots(paint);
  else if (style === "dither") drawDither(paint);
  else if (style === "halftone") drawHalftone(paint);
  else drawAurora(paint);
}
