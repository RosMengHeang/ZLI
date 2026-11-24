/**
 * Color themes. Each theme sets every color custom property in tokens.css, plus the terminal's ANSI
 * palette, which xterm needs as plain values. tokens.css holds Midnight as the fallback before a theme
 * is applied, and a test keeps the two in step.
 */

export const THEME_IDS = ["midnight", "onyx", "daylight"] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME: ThemeId = "midnight";

export type TerminalPalette = {
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

/** The hand-picked colors of a theme; the rest of its tokens are derived from these. */
export type ThemeBase = {
  scheme: "dark" | "light";
  canvas: string;
  sidebar: string;
  surface: string;
  raised: string;
  overlay: string;
  text: string;
  muted: string;
  dim: string;
  disabled: string;
  accent: string;
  accentHover: string;
  accentPressed: string;
  accentInk: string;
  blue: string;
  green: string;
  amber: string;
  red: string;
  greenInk: string;
  amberInk: string;
  redInk: string;
  danger: string;
  dangerHover: string;
  syntax: {
    keyword: string;
    string: string;
    regexp: string;
    number: string;
    comment: string;
    function: string;
    type: string;
    property: string;
    variable: string;
    operator: string;
    punctuation: string;
    heading: string;
    deleted: string;
    invalid: string;
  };
  terminal: TerminalPalette;
};

export type Theme = {
  /** A built-in theme id, or the id of a theme the person made. */
  id: string;
  name: string;
  /** One line for the picker. */
  description: string;
  scheme: "dark" | "light";
  /** Custom property name to value, for every color token. */
  tokens: Record<string, string>;
  terminal: TerminalPalette & { background: string; cursorAccent: string };
  /** The colors the tokens were built from, so a theme can be the start of a new one. */
  base: ThemeBase;
};

/** `#rrggbb` at an alpha, as `rgba()`. */
export function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function tokensFor(base: ThemeBase): Record<string, string> {
  const dark = base.scheme === "dark";
  // Dark themes draw interaction fills and hairlines in white, light themes in black.
  const ink = dark ? "#ffffff" : "#000000";
  return {
    "--zli-scheme": base.scheme,
    "--zli-canvas": base.canvas,
    "--zli-sidebar": base.sidebar,
    "--zli-surface": base.surface,
    "--zli-raised": base.raised,
    "--zli-overlay": base.overlay,
    "--zli-terminal": base.surface,
    "--zli-well": dark ? "rgba(0, 0, 0, .22)" : "rgba(0, 0, 0, .035)",
    "--zli-hover": withAlpha(ink, dark ? 0.055 : 0.045),
    "--zli-active": withAlpha(ink, dark ? 0.09 : 0.075),
    "--zli-pressed": withAlpha(ink, dark ? 0.12 : 0.1),
    "--zli-border": withAlpha(ink, dark ? 0.06 : 0.08),
    "--zli-border-strong": withAlpha(ink, dark ? 0.1 : 0.13),
    "--zli-border-hover": withAlpha(ink, dark ? 0.17 : 0.22),
    "--zli-text": base.text,
    "--zli-muted": base.muted,
    "--zli-dim": base.dim,
    "--zli-disabled": base.disabled,
    "--zli-accent": base.accent,
    "--zli-accent-hover": base.accentHover,
    "--zli-accent-pressed": base.accentPressed,
    "--zli-accent-ink": base.accentInk,
    "--zli-accent-soft": withAlpha(base.accent, dark ? 0.14 : 0.1),
    "--zli-accent-line": withAlpha(base.accentHover, 0.6),
    "--zli-accent-edge": withAlpha(base.accentHover, dark ? 0.42 : 0.5),
    "--zli-focus": withAlpha(base.accentHover, 0.9),
    "--zli-selection": withAlpha(base.accent, dark ? 0.38 : 0.24),
    "--zli-scrollbar": withAlpha(ink, dark ? 0.12 : 0.18),
    "--zli-active-line": withAlpha(ink, dark ? 0.035 : 0.03),
    "--zli-blue": base.blue,
    "--zli-green": base.green,
    "--zli-amber": base.amber,
    "--zli-red": base.red,
    "--zli-blue-soft": withAlpha(base.blue, 0.13),
    "--zli-green-soft": withAlpha(base.green, 0.13),
    "--zli-amber-soft": withAlpha(base.amber, 0.13),
    "--zli-red-soft": withAlpha(base.red, 0.13),
    "--zli-red-line": withAlpha(base.red, 0.32),
    "--zli-green-ink": base.greenInk,
    "--zli-amber-ink": base.amberInk,
    "--zli-red-ink": base.redInk,
    "--zli-amber-line": withAlpha(base.amber, 0.32),
    "--zli-danger": base.danger,
    "--zli-danger-hover": base.dangerHover,
    "--zli-highlight": dark ? "inset 0 1px 0 rgba(255, 255, 255, .055)" : "inset 0 1px 0 rgba(255, 255, 255, .7)",
    "--zli-shadow-pop": dark
      ? "0 0 0 1px rgba(0, 0, 0, .5), 0 12px 32px -8px rgba(0, 0, 0, .7)"
      : "0 0 0 1px rgba(0, 0, 0, .08), 0 12px 32px -8px rgba(0, 0, 0, .18)",
    "--zli-shadow-lift": dark ? "0 14px 32px -18px rgba(0, 0, 0, .8)" : "0 14px 32px -18px rgba(0, 0, 0, .22)",
    "--zli-shadow-dialog": dark
      ? "0 0 0 1px rgba(0, 0, 0, .55), 0 32px 80px -20px rgba(0, 0, 0, .85)"
      : "0 0 0 1px rgba(0, 0, 0, .08), 0 32px 80px -20px rgba(0, 0, 0, .3)",
    ...Object.fromEntries(Object.entries(base.syntax).map(([name, value]) => [`--zli-syntax-${name}`, value])),
  };
}

/** Turns a theme's colors into every token it sets. */
export function buildTheme(id: string, name: string, description: string, base: ThemeBase): Theme {
  return {
    id,
    name,
    description,
    scheme: base.scheme,
    tokens: tokensFor(base),
    terminal: { ...base.terminal, background: base.surface, cursorAccent: base.surface },
    base,
  };
}

const theme = buildTheme;

/** Status hues shared by most dark themes, so running, modified, and failed read the same way. */
const darkStatus = {
  green: "#57c487",
  amber: "#e3b45f",
  red: "#ef7b7b",
  greenInk: "#a3e0bb",
  amberInk: "#efd6a6",
  redInk: "#f5c0c0",
  danger: "#c2413f",
  dangerHover: "#d14d4b",
};

const neutralSyntax: ThemeBase["syntax"] = {
  keyword: "#b3a6dc",
  string: "#a3c49a",
  regexp: "#d3a283",
  number: "#d8b67e",
  comment: "#6a6a6a",
  function: "#8fb0e3",
  type: "#80bfb8",
  property: "#a9bad6",
  variable: "#dcdcdc",
  operator: "#a3a3a3",
  punctuation: "#8a8a8a",
  heading: "#e6e6e6",
  deleted: "#de8f8f",
  invalid: "#ec7272",
};

const neutralTerminal: TerminalPalette = {
  foreground: "#dcdcdc",
  cursor: "#b4cbff",
  selectionBackground: "rgba(180, 203, 255, 0.25)",
  black: "#1f1f1f",
  red: "#d77c7c",
  green: "#69c58b",
  yellow: "#d8b56f",
  blue: "#7fa6d9",
  magenta: "#b99ad6",
  cyan: "#72bcc0",
  white: "#cfcfcf",
  brightBlack: "#6f6f6f",
  brightRed: "#e49a9a",
  brightGreen: "#8bd5a5",
  brightYellow: "#e6c98e",
  brightBlue: "#a1bfe6",
  brightMagenta: "#ccb3e3",
  brightCyan: "#95d0d3",
  brightWhite: "#f1f1f1",
};

export const THEMES: Record<ThemeId, Theme> = {
  midnight: theme("midnight", "Midnight", "Soft charcoal greys with a calm blue accent. The default.", {
    scheme: "dark",
    canvas: "#171717",
    sidebar: "#171717",
    surface: "#212121",
    raised: "#2a2a2a",
    overlay: "#303030",
    text: "#ececec",
    muted: "#b4b4b4",
    dim: "#a0a0a0",
    disabled: "#5f5f5f",
    accent: "#4a6fdc",
    accentHover: "#5f80e3",
    accentPressed: "#3f60c4",
    accentInk: "#ffffff",
    blue: "#a3b8f0",
    ...darkStatus,
    syntax: neutralSyntax,
    terminal: neutralTerminal,
  }),
  onyx: theme("onyx", "Dark", "Pure black, for dark rooms and OLED screens.", {
    scheme: "dark",
    canvas: "#000000",
    sidebar: "#000000",
    surface: "#000000",
    raised: "#111113",
    overlay: "#18181b",
    text: "#ededed",
    muted: "#a3a3a3",
    dim: "#949494",
    disabled: "#5c5c5c",
    accent: "#4a6fdc",
    accentHover: "#5f80e3",
    accentPressed: "#3f60c4",
    accentInk: "#ffffff",
    blue: "#a3b8f0",
    ...darkStatus,
    syntax: neutralSyntax,
    terminal: neutralTerminal,
  }),
  daylight: theme("daylight", "Light", "Bright paper white for well-lit rooms.", {
    scheme: "light",
    canvas: "#ececef",
    sidebar: "#ececef",
    surface: "#ffffff",
    raised: "#f7f7f8",
    overlay: "#ffffff",
    text: "#18181b",
    muted: "#52525b",
    dim: "#60606a",
    disabled: "#a1a1aa",
    accent: "#2f5fe0",
    accentHover: "#2551c8",
    accentPressed: "#1f45ad",
    accentInk: "#ffffff",
    blue: "#2563eb",
    green: "#15803d",
    amber: "#b45309",
    red: "#dc2626",
    greenInk: "#14532d",
    amberInk: "#78350f",
    redInk: "#7f1d1d",
    danger: "#c62828",
    dangerHover: "#b01f1f",
    syntax: {
      keyword: "#7c3aed",
      string: "#15803d",
      regexp: "#b45309",
      number: "#a16207",
      comment: "#8a8a94",
      function: "#1d4ed8",
      type: "#0f766e",
      property: "#475a7a",
      variable: "#27272a",
      operator: "#52525b",
      punctuation: "#71717a",
      heading: "#18181b",
      deleted: "#b91c1c",
      invalid: "#dc2626",
    },
    terminal: {
      foreground: "#27272a",
      cursor: "#2f5fe0",
      selectionBackground: "rgba(47, 95, 224, 0.2)",
      black: "#27272a",
      red: "#c62828",
      green: "#15803d",
      yellow: "#a16207",
      blue: "#1d4ed8",
      magenta: "#9333ea",
      cyan: "#0e7490",
      white: "#a1a1aa",
      brightBlack: "#71717a",
      brightRed: "#dc2626",
      brightGreen: "#16a34a",
      brightYellow: "#ca8a04",
      brightBlue: "#2563eb",
      brightMagenta: "#a855f7",
      brightCyan: "#0891b2",
      brightWhite: "#d4d4d8",
    },
  }),
};

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

/* ---------- Color math for themes people make ---------- */

const HEX = /^#[0-9a-f]{6}$/iu;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** `a` moved toward `b` by `amount`, from 0 (all `a`) to 1 (all `b`). */
export function mixHex(a: string, b: string, amount: number): string {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  return toHex(ar + (br - ar) * amount, ag + (bg - ag) * amount, ab + (bb - ab) * amount);
}

export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two colors, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** The color furthest from `text` toward `background` that still reads at `ratio` on `against`. */
function readableStep(text: string, background: string, against: string, ratio: number): string {
  let low = 0;
  let high = 1;
  for (let step = 0; step < 16; step += 1) {
    const middle = (low + high) / 2;
    if (contrastRatio(mixHex(text, background, middle), against) >= ratio) low = middle;
    else high = middle;
  }
  return mixHex(text, background, low);
}

/** The three colors a made theme starts from. */
export type ThemeSeed = {
  /** The window: sidebar, top bar, and the gaps between panels. */
  background: string;
  /** Agent tiles, terminals, and the other panels. It may equal the background. */
  terminal: string;
  accent: string;
};

/** Whether a color is light enough that dark text belongs on it. */
export function isLightColor(hex: string): boolean {
  return luminance(hex) > 0.35;
}

/**
 * Derives every hand-picked color from a seed. Status and code colors come from `from`, the theme the
 * new one started as. The terminal's palette follows its own background, so a dark terminal in a light
 * window still gets light text.
 */
export function deriveBase(seed: ThemeSeed, from: ThemeBase): ThemeBase {
  const background = seed.background.toLowerCase();
  const surface = seed.terminal.toLowerCase();
  const accent = seed.accent.toLowerCase();
  const scheme = isLightColor(background) ? "light" : "dark";
  const dark = scheme === "dark";
  // Controls and menus sit just above the lighter of the two, so they read on both.
  const top = luminance(surface) > luminance(background) ? surface : background;
  const raised = dark ? mixHex(top, "#ffffff", 0.05) : mixHex(surface, background, 0.35);
  const overlay = dark ? mixHex(top, "#ffffff", 0.08) : "#ffffff";
  // Text leans a little toward the accent so it belongs to the theme, then is checked for contrast.
  const text = mixHex(dark ? "#ededed" : "#18181b", accent, 0.06);
  // Secondary text must still read on the surface it contrasts with least.
  const weakest = [background, surface, raised, overlay].reduce((worst, next) =>
    contrastRatio(text, next) < contrastRatio(text, worst) ? next : worst,
  );
  const muted = readableStep(text, background, weakest, 6);
  const dim = readableStep(text, background, weakest, 4.7);
  const white = contrastRatio("#ffffff", accent);
  const ink = mixHex("#000000", accent, 0.15);
  return {
    ...from,
    scheme,
    canvas: background,
    sidebar: background,
    surface,
    raised,
    overlay,
    text,
    muted,
    dim,
    disabled: mixHex(text, background, 0.62),
    accent,
    accentHover: mixHex(accent, dark ? "#ffffff" : "#000000", 0.12),
    accentPressed: mixHex(accent, "#000000", 0.12),
    accentInk: white >= 4.5 || white >= contrastRatio(ink, accent) ? "#ffffff" : ink,
    terminal: terminalFor(surface, accent, from),
  };
}

/** ANSI colors made for the terminal's own background, light or dark. */
function terminalFor(background: string, accent: string, from: ThemeBase): TerminalPalette {
  const light = isLightColor(background);
  // Keep the starting theme's palette when it was made for the same kind of background.
  const palette =
    (from.scheme === "light") === light ? from.terminal : light ? THEMES.daylight.base.terminal : neutralTerminal;
  return {
    ...palette,
    foreground: light ? "#27272a" : mixHex("#e4e4e4", accent, 0.05),
    cursor: accent,
    selectionBackground: withAlpha(accent, light ? 0.2 : 0.28),
  };
}
