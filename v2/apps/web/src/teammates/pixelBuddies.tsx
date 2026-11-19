import { BUDDY_LOOKS, type BuddyLook } from "@zli-v2/contracts";

/**
 * The buddies' pixel bodies. Each is a small grid: B body, L light, D shade, S screen, A accent, G and K leaf,
 * W wisp, . empty. The eyes are drawn over it for each mood at the body's eye spots, so every body has the
 * same moods: idle, working (eyes on the work), thinking (eyes up), waiting (wide), done (happy), failed.
 */
type Body = {
  label: string;
  grid: readonly string[];
  /** The grid after a failure, for a body that changes shape (the sprout droops). */
  failed?: readonly string[];
  eyes: { left: number; right: number; y: number; ink: string };
  /** Its parts are a little see-through. */
  alpha?: number;
};

const DARK = "#16151a";

export const BODIES: Record<BuddyLook, Body> = {
  bot: {
    label: "Bot",
    grid: [
      "......AA......",
      "......DD......",
      "..BBBBBBBBBB..",
      ".BLLBBBBBBBBB.",
      ".BLSSSSSSSSSB.",
      "BBSSSSSSSSSSBB",
      "DBSSSSSSSSSSBD",
      "DBSSSSSSSSSSBD",
      ".BSSSSSSSSSSB.",
      ".BBSSSSSSSSBB.",
      ".BBBBBBBBBBBB.",
      "..DDDDDDDDDD..",
    ],
    eyes: { left: 5, right: 8, y: 6, ink: "#eafff4" },
  },
  blob: {
    label: "Blob",
    grid: [
      "....BBBBBB....",
      "..BBLLBBBBBB..",
      ".BLLBBBBBBBBB.",
      ".BLBBBBBBBBBB.",
      "BBBBBBBBBBBBBB",
      "BBBBBBBBBBBBBB",
      "BBBBBBBBBBBBBB",
      "BBBBBBBBBBBBDB",
      "BBBBBBBBBBBDDB",
      ".BBBBBBBBBBBB.",
      "..DDD....DDD..",
    ],
    eyes: { left: 5, right: 8, y: 5, ink: DARK },
  },
  critter: {
    label: "Critter",
    grid: [
      ".BB......BB.",
      ".BLB....BBB.",
      ".BBBBBBBBBB.",
      "BBLLBBBBBBBB",
      "BLBBBBBBBBBB",
      "BBBBBBBBBBBB",
      "BBBBBBBBBBBB",
      "BAABBBBBBAAB",
      "BBBBBBBBBBBB",
      "BBBBBBBBBBDB",
      ".BBBBBBBBDD.",
      "..DDDDDDDD..",
    ],
    eyes: { left: 4, right: 7, y: 5, ink: DARK },
  },
  ghost: {
    label: "Ghost",
    grid: [
      "...BBBBBB...",
      ".BBLLBBBBBB.",
      ".BLBBBBBBBB.",
      "BBBBBBBBBBBB",
      "BBBBBBBBBBBB",
      "BBBBBBBBBBBB",
      "BBBBBBBBBBBB",
      "BBBBBBBBBBBB",
      "BBBBBBBBBBDB",
      "BBBBBBBBBBDB",
      "BBBBBBBBBBDB",
      ".BBB.BBB.BB.",
    ],
    eyes: { left: 4, right: 7, y: 4, ink: DARK },
  },
  sprout: {
    label: "Sprout",
    grid: [
      "...GG..GG...",
      "..GGKGGKGG..",
      "....GKKG....",
      ".....KK.....",
      "..BBBBBBBB..",
      ".BLLBBBBBBB.",
      "BLLBBBBBBBBB",
      "BLBBBBBBBBBB",
      "BBBBBBBBBBBB",
      "BBBBBBBBBBBB",
      "BBBBBBBBBBBB",
      "BBBBBBBBBBDB",
      ".BBBBBBBBDD.",
      "..DDDDDDDD..",
    ],
    failed: ["............", "..GG....GG..", "..GKG..GKG..", "....GKKG...."],
    eyes: { left: 4, right: 7, y: 8, ink: DARK },
  },
  jelly: {
    label: "Jelly",
    grid: [
      "....BBBBBB....",
      "..BBLLBBBBBB..",
      ".BLLBBBBBBBBB.",
      ".BLBBBBBBBBBB.",
      "BBBBBBBBBBBBBB",
      "BBBBBBBBBBBBBB",
      "BBBBBBBBBBBBBB",
      "DBDDBDDBDDBDDB",
      ".W..W..W..W...",
      ".W...W.W...W..",
      "..W..W..W..W..",
      "..W...W.W...W.",
    ],
    eyes: { left: 5, right: 8, y: 4, ink: DARK },
    alpha: 0.92,
  },
};

export { BUDDY_LOOKS };

/** A body for a buddy made before bodies: the same one every time, and spread across the team. */
export function defaultLook(buddyId: string): BuddyLook {
  let hash = 0;
  for (const character of buddyId) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  return BUDDY_LOOKS[hash % BUDDY_LOOKS.length] as BuddyLook;
}

/** The buddy's body: the one it picked, or its default. */
export function lookOf(buddy: { buddyId: string; look?: BuddyLook | undefined }): BuddyLook {
  return buddy.look ?? defaultLook(buddy.buddyId);
}

export type PixelMood = "idle" | "ack" | "working" | "thinking" | "waiting" | "done" | "failed" | "stopped";

/** Where the eye pixels go for a mood. Bar eyes 1 wide, moved or reshaped the way the moods always have. */
function eyePixels(eyes: Body["eyes"], mood: PixelMood): [number, number][] {
  const pixels: [number, number][] = [];
  const bar = (x: number, y: number, height: number) => {
    for (let step = 0; step < height; step += 1) pixels.push([x, y + step]);
  };
  for (const x of [eyes.left, eyes.right]) {
    if (mood === "working") bar(x + 1, eyes.y, 2);
    else if (mood === "thinking") bar(x + 1, eyes.y - 1, 1);
    else if (mood === "waiting") bar(x, eyes.y - 1, 3);
    else if (mood === "done") pixels.push([x - 1, eyes.y + 1], [x, eyes.y], [x + 1, eyes.y + 1]);
    else if (mood === "failed")
      pixels.push([x - 1, eyes.y - 1], [x + 1, eyes.y - 1], [x, eyes.y], [x - 1, eyes.y + 1], [x + 1, eyes.y + 1]);
    else if (mood === "stopped") pixels.push([x - 1, eyes.y + 1], [x, eyes.y + 1], [x + 1, eyes.y + 1]);
    else bar(x, eyes.y, 2);
  }
  return pixels;
}

function mix(hex: string, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (c: number) =>
    Math.max(0, Math.min(255, Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount)));
  return `#${[value >> 16, (value >> 8) & 255, value & 255]
    .map((c) => channel(c).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** The grid size every body is drawn into: the same 32-unit box as before, so the mood animations still fit. */
const BOX = 32;
/** The body's feet sit here in the box, where the animations pivot. */
const FLOOR = 30;

/**
 * A buddy's pixel body in its color and mood, as SVG parts for a 32-unit box. Plain SVG with inline colors, so it
 * also draws outside the page (notification icons).
 */
export function PixelBody({ look, color, mood }: { look: BuddyLook; color: string; mood: PixelMood }) {
  const body = BODIES[look];
  const grid = mood === "failed" && body.failed ? [...body.failed, ...body.grid.slice(body.failed.length)] : body.grid;
  const width = grid[0]?.length ?? 12;
  const height = grid.length;
  const scale = Math.min(28 / width, 28 / height);
  const left = (BOX - width * scale) / 2;
  const top = FLOOR - height * scale;
  const fill: Record<string, string> = {
    B: color,
    L: mix(color, 0.38),
    D: mix(color, -0.32),
    W: mix(color, 0.22),
    S: "#17181c",
    A: look === "bot" ? mix(color, 0.5) : "#ff9db8",
    G: "#7ad66a",
    K: "#3f9a45",
  };
  const cells: { x: number; y: number; c: string }[] = [];
  grid.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c !== ".") cells.push({ x, y, c });
    });
  });
  return (
    <g transform={`translate(${left} ${top}) scale(${scale})`} shapeRendering="crispEdges">
      {cells.map(({ x, y, c }) => (
        <rect
          key={`${x}-${y}`}
          x={x}
          y={y}
          width={1.02}
          height={1.02}
          fill={fill[c]}
          fillOpacity={body.alpha && c !== "S" ? (c === "W" ? body.alpha - 0.25 : body.alpha) : undefined}
        />
      ))}
      <g className="buddy-face">
        <g className="buddy-eyes">
          {eyePixels(body.eyes, mood).map(([x, y]) => (
            <rect key={`e${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={body.eyes.ink} />
          ))}
        </g>
      </g>
    </g>
  );
}
