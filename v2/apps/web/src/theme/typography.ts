/**
 * Text sizes and fonts the person picks in Settings > Appearance. Every interface size scales from one number,
 * the way a browser's root size does, while chat text and code have sizes of their own so a long conversation
 * can be read larger without the whole window growing. The defaults are a 16px interface base (so
 * small text is 12px and body text 14px), 14px chat text, 13px code, and a 12px terminal.
 */

export type FontChoice = string;

export type Typography = {
  /** The interface base size in px, 12 to 20. 16 draws body text at 14px. */
  interfaceSize: number;
  /** Chat messages and the message box, in px. */
  chatSize: number;
  /** Code in chat replies, in px. */
  codeSize: number;
  /** The terminal, in px. */
  terminalSize: number;
  /** A preset id below, or "custom:<font name>" for any font installed on the computer. */
  sans: FontChoice;
  mono: FontChoice;
};

export const TYPOGRAPHY_LIMITS = {
  interfaceSize: { min: 12, max: 20, default: 16 },
  chatSize: { min: 12, max: 20, default: 14 },
  codeSize: { min: 10, max: 18, default: 13 },
  terminalSize: { min: 8, max: 20, default: 12 },
} as const;

/** Fonts bundled with the app or always present, so a pick works offline. */
export const SANS_FONTS: readonly { id: string; name: string; stack: string }[] = [
  { id: "geist", name: "Geist", stack: '"Geist Variable", Geist' },
  {
    id: "system",
    name: "System",
    stack: '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Roboto, Ubuntu',
  },
  { id: "inter", name: "Inter", stack: '"Inter Variable", Inter' },
];

export const MONO_FONTS: readonly { id: string; name: string; stack: string }[] = [
  { id: "geist-mono", name: "Geist Mono", stack: '"Geist Mono Variable", "Geist Mono"' },
  { id: "system", name: "System", stack: 'ui-monospace, "SF Mono", "SFMono-Regular", "Cascadia Mono", Consolas' },
  { id: "jetbrains-mono", name: "JetBrains Mono", stack: '"JetBrains Mono Variable", "JetBrains Mono"' },
];

const SANS_FALLBACK = '"Segoe UI", system-ui, -apple-system, sans-serif';
const MONO_FALLBACK = '"SFMono-Regular", "Cascadia Mono", Consolas, monospace';

export const DEFAULT_TYPOGRAPHY: Typography = {
  interfaceSize: TYPOGRAPHY_LIMITS.interfaceSize.default,
  chatSize: TYPOGRAPHY_LIMITS.chatSize.default,
  codeSize: TYPOGRAPHY_LIMITS.codeSize.default,
  terminalSize: TYPOGRAPHY_LIMITS.terminalSize.default,
  sans: "geist",
  mono: "geist-mono",
};

const clampSize = (value: unknown, limits: { min: number; max: number; default: number }) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(limits.max, Math.max(limits.min, Math.round(value)))
    : limits.default;

/** A font name typed by the person, kept to characters a font family can hold. */
export function cleanFontName(value: string): string {
  return value
    .replace(/["'`;{}<>\\]/gu, "")
    .trim()
    .slice(0, 80);
}

function parseFont(value: unknown, presets: readonly { id: string }[], fallback: string): FontChoice {
  if (typeof value !== "string") return fallback;
  if (presets.some((preset) => preset.id === value)) return value;
  if (value.startsWith("custom:")) {
    const name = cleanFontName(value.slice("custom:".length));
    return name ? `custom:${name}` : fallback;
  }
  return fallback;
}

export function parseTypography(value: unknown): Typography {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    interfaceSize: clampSize(record.interfaceSize, TYPOGRAPHY_LIMITS.interfaceSize),
    chatSize: clampSize(record.chatSize, TYPOGRAPHY_LIMITS.chatSize),
    codeSize: clampSize(record.codeSize, TYPOGRAPHY_LIMITS.codeSize),
    terminalSize: clampSize(record.terminalSize, TYPOGRAPHY_LIMITS.terminalSize),
    sans: parseFont(record.sans, SANS_FONTS, DEFAULT_TYPOGRAPHY.sans),
    mono: parseFont(record.mono, MONO_FONTS, DEFAULT_TYPOGRAPHY.mono),
  };
}

/** The CSS font stack for a choice, ending in fonts every computer has. */
export function fontStack(choice: FontChoice, kind: "sans" | "mono"): string {
  const presets = kind === "sans" ? SANS_FONTS : MONO_FONTS;
  const fallback = kind === "sans" ? SANS_FALLBACK : MONO_FALLBACK;
  if (choice.startsWith("custom:")) return `"${cleanFontName(choice.slice("custom:".length))}", ${fallback}`;
  const preset = presets.find((entry) => entry.id === choice) ?? presets[0];
  return `${preset?.stack ?? ""}, ${fallback}`;
}

/** Sets the size and font tokens on the root, so every style follows at once. */
export function applyTypography(typography: Typography, root: HTMLElement = document.documentElement): void {
  root.style.setProperty("--zli-ui-scale", String(typography.interfaceSize / 16));
  root.style.setProperty("--zli-text-chat", `${typography.chatSize}px`);
  root.style.setProperty("--zli-text-code", `${typography.codeSize}px`);
  root.style.setProperty("--zli-font", fontStack(typography.sans, "sans"));
  root.style.setProperty("--zli-mono", fontStack(typography.mono, "mono"));
}
