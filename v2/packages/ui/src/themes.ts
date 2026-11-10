/**
 * Color themes. Each theme sets every color custom property in tokens.css, plus the terminal's ANSI
 * palette, which xterm needs as plain values. tokens.css holds Midnight as the fallback before a theme
 * is applied, and a test keeps the two in step.
 */

export const THEME_IDS = ["midnight", "graphite", "sakura", "frost", "ember", "matrix", "daylight"] as const;
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
  midnight: theme("midnight", "Midnight", "Pure black with a calm blue accent. The default.", {
    scheme: "dark",
    canvas: "#000000",
    sidebar: "#000000",
    surface: "#000000",
    raised: "#121212",
    overlay: "#181818",
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
  graphite: theme("graphite", "Graphite", "Soft charcoal with a lavender accent.", {
    scheme: "dark",
    canvas: "#161618",
    sidebar: "#161618",
    surface: "#1c1c1f",
    raised: "#242428",
    overlay: "#2a2a2e",
    text: "#ececef",
    muted: "#b2b2b8",
    dim: "#a2a2a9",
    disabled: "#68686f",
    accent: "#a593e6",
    accentHover: "#b4a5ec",
    accentPressed: "#9481db",
    accentInk: "#17112b",
    blue: "#a9b8f0",
    ...darkStatus,
    syntax: { ...neutralSyntax, comment: "#7a7a80", keyword: "#c3b2f0", heading: "#f0f0f2" },
    terminal: {
      ...neutralTerminal,
      foreground: "#e2e2e6",
      cursor: "#b9a6f5",
      selectionBackground: "rgba(185, 166, 245, 0.25)",
      black: "#2c2c30",
      magenta: "#b49cf0",
      brightMagenta: "#cbbaf6",
      brightBlack: "#7b7b82",
    },
  }),
  sakura: theme("sakura", "Sakura", "Soft rose pink on a dark, muted plum.", {
    scheme: "dark",
    canvas: "#0f0b0d",
    sidebar: "#0f0b0d",
    surface: "#151013",
    raised: "#1d171b",
    overlay: "#231c21",
    text: "#f3e6ec",
    muted: "#c9b2be",
    dim: "#b89fac",
    disabled: "#6a5862",
    accent: "#e9a3c4",
    accentHover: "#efb5d0",
    accentPressed: "#dc8fb3",
    accentInk: "#2b1220",
    blue: "#c4b0ea",
    green: "#86cba5",
    amber: "#e6c08a",
    red: "#ee8fa3",
    greenInk: "#bfe3cf",
    amberInk: "#f1dcbc",
    redInk: "#f6c9d2",
    danger: "#b8476a",
    dangerHover: "#c6557a",
    syntax: {
      keyword: "#e8a9c8",
      string: "#aed4b8",
      regexp: "#e6b89a",
      number: "#e8c9a0",
      comment: "#8a7380",
      function: "#bfaee8",
      type: "#8fd5d8",
      property: "#e8b8d5",
      variable: "#f5e3ed",
      operator: "#d3afc3",
      punctuation: "#a2849a",
      heading: "#f6dceb",
      deleted: "#f0a7b7",
      invalid: "#ee8fa3",
    },
    terminal: {
      foreground: "#f5e3ed",
      cursor: "#f0bcd6",
      selectionBackground: "rgba(233, 163, 196, 0.26)",
      black: "#2c1b27",
      red: "#ee8fa3",
      green: "#7fd6a8",
      yellow: "#f2c078",
      blue: "#9fb4f5",
      magenta: "#e9a3c4",
      cyan: "#8fd5d8",
      white: "#ead6e1",
      brightBlack: "#8a7380",
      brightRed: "#f4b3c1",
      brightGreen: "#a8e6c4",
      brightYellow: "#f8d59f",
      brightBlue: "#bfcdf8",
      brightMagenta: "#f0bcd6",
      brightCyan: "#b4e5e7",
      brightWhite: "#fbf1f6",
    },
  }),
  frost: theme("frost", "Frost", "Cool slate blue with an icy accent.", {
    scheme: "dark",
    canvas: "#171b22",
    sidebar: "#171b22",
    surface: "#1c212a",
    raised: "#232934",
    overlay: "#29303c",
    text: "#e8edf4",
    muted: "#b0bacb",
    dim: "#a0abbe",
    disabled: "#5f697a",
    accent: "#88c0d0",
    accentHover: "#9dcddb",
    accentPressed: "#73adbf",
    accentInk: "#0e1a22",
    blue: "#9fbbe8",
    green: "#a3d39c",
    amber: "#ebcb8b",
    red: "#e88b92",
    greenInk: "#cbe8c6",
    amberInk: "#f3e0bc",
    redInk: "#f4c4c8",
    danger: "#bf4e58",
    dangerHover: "#cc5c66",
    syntax: {
      keyword: "#93b4de",
      string: "#a3d39c",
      regexp: "#ebcb8b",
      number: "#d8a7c8",
      comment: "#6c788c",
      function: "#88c0d0",
      type: "#8fd0c0",
      property: "#b7c6dc",
      variable: "#dde4ee",
      operator: "#b0bacb",
      punctuation: "#8691a5",
      heading: "#eef2f8",
      deleted: "#e88b92",
      invalid: "#f07a84",
    },
    terminal: {
      foreground: "#dde4ee",
      cursor: "#88c0d0",
      selectionBackground: "rgba(136, 192, 208, 0.25)",
      black: "#303846",
      red: "#e88b92",
      green: "#a3d39c",
      yellow: "#ebcb8b",
      blue: "#81a1d1",
      magenta: "#c19ac0",
      cyan: "#88c0d0",
      white: "#d6dde8",
      brightBlack: "#6c788c",
      brightRed: "#f0a9ae",
      brightGreen: "#bfe2b9",
      brightYellow: "#f2dbad",
      brightBlue: "#a3bce2",
      brightMagenta: "#d6b8d5",
      brightCyan: "#a9d4e0",
      brightWhite: "#f2f5fa",
    },
  }),
  ember: theme("ember", "Ember", "Warm charcoal with a soft amber accent.", {
    scheme: "dark",
    canvas: "#0e0b09",
    sidebar: "#0e0b09",
    surface: "#14100d",
    raised: "#1c1714",
    overlay: "#221c18",
    text: "#f0e6dc",
    muted: "#c6b19f",
    dim: "#b39e8b",
    disabled: "#6b594c",
    accent: "#e3a06b",
    accentHover: "#eab183",
    accentPressed: "#d68e56",
    accentInk: "#24130a",
    blue: "#9fb6e0",
    green: "#8fc77a",
    amber: "#e6c46a",
    red: "#e8897b",
    greenInk: "#c6e4ba",
    amberInk: "#f6e3a8",
    redInk: "#f4c8c1",
    danger: "#c4432f",
    dangerHover: "#d4533d",
    syntax: {
      keyword: "#f0956a",
      string: "#b7cf8a",
      regexp: "#f0cf5f",
      number: "#e9b872",
      comment: "#7d6a5d",
      function: "#f2c27d",
      type: "#d9a77a",
      property: "#d8c0a8",
      variable: "#efe2d6",
      operator: "#c9b3a0",
      punctuation: "#93806f",
      heading: "#fbe9d6",
      deleted: "#f29a8c",
      invalid: "#f07b6b",
    },
    terminal: {
      foreground: "#efe2d6",
      cursor: "#f0883e",
      selectionBackground: "rgba(240, 136, 62, 0.25)",
      black: "#2a211c",
      red: "#f07b6b",
      green: "#a8c97f",
      yellow: "#f0cf5f",
      blue: "#8fa9d6",
      magenta: "#d99ab5",
      cyan: "#8cc4b4",
      white: "#e3d4c6",
      brightBlack: "#7d6a5d",
      brightRed: "#f5a092",
      brightGreen: "#c2dba1",
      brightYellow: "#f5de8d",
      brightBlue: "#b0c3e3",
      brightMagenta: "#e6b8cb",
      brightCyan: "#aed6ca",
      brightWhite: "#fdf6ef",
    },
  }),
  matrix: theme("matrix", "Matrix", "Calm green on a black screen.", {
    scheme: "dark",
    canvas: "#000000",
    sidebar: "#000000",
    surface: "#050a07",
    raised: "#0a120d",
    overlay: "#0f1912",
    text: "#c2e9cc",
    muted: "#8fc19d",
    dim: "#7caf8b",
    disabled: "#3d5c47",
    accent: "#5cc285",
    accentHover: "#72cf97",
    accentPressed: "#4aae73",
    accentInk: "#04120a",
    blue: "#7fd8b4",
    green: "#62cf8a",
    amber: "#d3d97a",
    red: "#f87171",
    greenInk: "#b5f5cb",
    amberInk: "#eef3b5",
    redInk: "#fbc1c1",
    danger: "#c03b3b",
    dangerHover: "#d04848",
    syntax: {
      keyword: "#7ed9a0",
      string: "#b8de8c",
      regexp: "#d9e36b",
      number: "#9ff0c8",
      comment: "#3f7a52",
      function: "#8fe0bd",
      type: "#62d9a8",
      property: "#a6e8b9",
      variable: "#c9f8d6",
      operator: "#86c99b",
      punctuation: "#5c9a6f",
      heading: "#dcf5e3",
      deleted: "#f89a9a",
      invalid: "#f87171",
    },
    terminal: {
      foreground: "#b5e6c2",
      cursor: "#62cf8a",
      selectionBackground: "rgba(92, 194, 133, 0.26)",
      black: "#101f15",
      red: "#f87171",
      green: "#62cf8a",
      yellow: "#d9e36b",
      blue: "#5fd3b0",
      magenta: "#8ff0a4",
      cyan: "#6ee7b7",
      white: "#b5e6c2",
      brightBlack: "#3f7a52",
      brightRed: "#fca5a5",
      brightGreen: "#8edcaa",
      brightYellow: "#ecf29a",
      brightBlue: "#8ee6c9",
      brightMagenta: "#b5f7c1",
      brightCyan: "#a7f3d0",
      brightWhite: "#e6f7ea",
    },
  }),
  daylight: theme("daylight", "Daylight", "Bright paper white for well-lit rooms.", {
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
