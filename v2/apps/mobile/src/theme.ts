import { Platform, useColorScheme } from "react-native";

import type { Tone } from "./lib/views.js";

export type Palette = {
  readonly scheme: "light" | "dark";
  /** The window: screens and the space between islands. */
  readonly canvas: string;
  /** Islands: grouped lists, the terminal, request cards. */
  readonly surface: string;
  /** Controls, the composer, and the user's own messages. */
  readonly raised: string;
  /** Pressed controls and the selected segment. */
  readonly overlay: string;
  /** Sunken fields and code. */
  readonly well: string;
  readonly separator: string;
  readonly border: string;
  readonly borderStrong: string;
  readonly text: string;
  readonly muted: string;
  readonly dim: string;
  readonly accent: string;
  readonly accentPressed: string;
  readonly accentInk: string;
  readonly link: string;
  readonly danger: string;
  readonly dangerPressed: string;
  readonly dangerInk: string;
  readonly tones: Record<Tone, { readonly ink: string; readonly soft: string }>;
};

/** The desktop palette from packages/ui/src/tokens.css. Text steps pass WCAG AA on every surface. */
const dark: Palette = {
  scheme: "dark",
  canvas: "#0a0a0b",
  surface: "#141416",
  raised: "#1b1b1e",
  overlay: "#26262b",
  well: "#0f0f11",
  separator: "rgba(255, 255, 255, 0.06)",
  border: "rgba(255, 255, 255, 0.08)",
  borderStrong: "rgba(255, 255, 255, 0.16)",
  text: "#ededed",
  muted: "#a3a3a3",
  dim: "#949494",
  accent: "#346bf1",
  accentPressed: "#2c5fdd",
  accentInk: "#ffffff",
  link: "#8ab0fe",
  danger: "#c2413f",
  dangerPressed: "#a83634",
  dangerInk: "#ffffff",
  tones: {
    neutral: { ink: "#a3a3a3", soft: "rgba(255, 255, 255, 0.07)" },
    blue: { ink: "#8ab0fe", soft: "rgba(138, 176, 254, 0.13)" },
    green: { ink: "#57c487", soft: "rgba(87, 196, 135, 0.13)" },
    amber: { ink: "#e3b45f", soft: "rgba(227, 180, 95, 0.13)" },
    red: { ink: "#ef7b7b", soft: "rgba(239, 123, 123, 0.13)" },
  },
};

/** A light counterpart for phones set to light mode, checked to the same AA bar. */
const light: Palette = {
  scheme: "light",
  canvas: "#f2f2f4",
  surface: "#ffffff",
  raised: "#e9e9ec",
  overlay: "#dcdce1",
  well: "#f6f6f8",
  separator: "rgba(0, 0, 0, 0.07)",
  border: "rgba(0, 0, 0, 0.09)",
  borderStrong: "rgba(0, 0, 0, 0.18)",
  text: "#18181b",
  muted: "#4f4f57",
  dim: "#5e5e66",
  accent: "#346bf1",
  accentPressed: "#2c5fdd",
  accentInk: "#ffffff",
  link: "#2350c4",
  danger: "#b3261e",
  dangerPressed: "#961f19",
  dangerInk: "#ffffff",
  tones: {
    neutral: { ink: "#4f4f57", soft: "rgba(0, 0, 0, 0.05)" },
    blue: { ink: "#2350c4", soft: "rgba(52, 107, 241, 0.1)" },
    green: { ink: "#1a7444", soft: "rgba(26, 116, 68, 0.1)" },
    amber: { ink: "#875500", soft: "rgba(135, 85, 0, 0.1)" },
    red: { ink: "#b3261e", soft: "rgba(179, 38, 30, 0.1)" },
  },
};

export function usePalette(): Palette {
  return useColorScheme() === "light" ? light : dark;
}

/** The desktop's 4px scale, with the half-step a dense phone row needs. */
export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** Phone type runs larger than the desktop scale so it reads at arm's length. */
export const type = {
  caption: { fontSize: 12, lineHeight: 16 },
  meta: { fontSize: 13, lineHeight: 18 },
  footnote: { fontSize: 14, lineHeight: 19 },
  body: { fontSize: 16, lineHeight: 23 },
  headline: { fontSize: 17, lineHeight: 22 },
  title: { fontSize: 20, lineHeight: 26 },
  largeTitle: { fontSize: 28, lineHeight: 34 },
} as const;

/** The smallest touch target on both platforms' guidelines. */
export const TAP = 44;

/** Controls stay close to the desktop's radii; islands and the composer round more on a phone. */
export const radius = { sm: 8, md: 12, island: 16, composer: 22, round: 999 } as const;

export const mono = Platform.select({ ios: "Menlo", default: "monospace" });
