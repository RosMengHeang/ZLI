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
type ThemeBase = {
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
  id: ThemeId;
  name: string;
  /** One line for the picker. */
  description: string;
  scheme: "dark" | "light";
  /** Custom property name to value, for every color token. */
  tokens: Record<string, string>;
  terminal: TerminalPalette & { background: string; cursorAccent: string };
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

function theme(id: ThemeId, name: string, description: string, base: ThemeBase): Theme {
  return {
    id,
    name,
    description,
    scheme: base.scheme,
    tokens: tokensFor(base),
    terminal: { ...base.terminal, background: base.surface, cursorAccent: base.surface },
  };
}

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
  midnight: theme("midnight", "Midnight", "Pure black with a blue accent. The default.", {
    scheme: "dark",
    canvas: "#050505",
    sidebar: "#050505",
    surface: "#0f0f0f",
    raised: "#171717",
    overlay: "#1d1d1d",
    text: "#ededed",
    muted: "#a3a3a3",
    dim: "#949494",
    disabled: "#5c5c5c",
    accent: "#3d63dd",
    accentHover: "#5677e6",
    accentPressed: "#3356c4",
    accentInk: "#ffffff",
    blue: "#9cb3f5",
    ...darkStatus,
    syntax: neutralSyntax,
    terminal: neutralTerminal,
  }),
  graphite: theme("graphite", "Graphite", "Soft charcoal with a violet accent.", {
    scheme: "dark",
    canvas: "#1a1a1c",
    sidebar: "#1a1a1c",
    surface: "#242427",
    raised: "#2c2c30",
    overlay: "#333337",
    text: "#f0f0f2",
    muted: "#b6b6bc",
    dim: "#a6a6ad",
    disabled: "#68686f",
    accent: "#7c5ce0",
    accentHover: "#8f72ea",
    accentPressed: "#6a4bcc",
    accentInk: "#ffffff",
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
  sakura: theme("sakura", "Sakura", "Deep plum with a cherry blossom pink accent.", {
    scheme: "dark",
    canvas: "#120a10",
    sidebar: "#120a10",
    surface: "#1c1119",
    raised: "#251721",
    overlay: "#2c1b27",
    text: "#fbecf4",
    muted: "#d3afc3",
    dim: "#c39db2",
    disabled: "#735869",
    accent: "#f472b6",
    accentHover: "#f78dc5",
    accentPressed: "#e45ba3",
    accentInk: "#2a0819",
    blue: "#c9a8f5",
    green: "#6fd1a0",
    amber: "#f2c078",
    red: "#ff7d9a",
    greenInk: "#b2ecd0",
    amberInk: "#f8dcb4",
    redInk: "#ffc3d0",
    danger: "#c93a62",
    dangerHover: "#d84a72",
    syntax: {
      keyword: "#f59ccb",
      string: "#a8dcb6",
      regexp: "#f0b48f",
      number: "#f5c992",
      comment: "#86677a",
      function: "#c7aaf7",
      type: "#8fd5d8",
      property: "#e8b8d5",
      variable: "#f5e3ed",
      operator: "#d3afc3",
      punctuation: "#a2849a",
      heading: "#ffd9ec",
      deleted: "#ff9db2",
      invalid: "#ff7d9a",
    },
    terminal: {
      foreground: "#f5e3ed",
      cursor: "#f9a8d4",
      selectionBackground: "rgba(244, 114, 182, 0.28)",
      black: "#2c1b27",
      red: "#ff7d9a",
      green: "#7fd6a8",
      yellow: "#f2c078",
      blue: "#9fb4f5",
      magenta: "#f472b6",
      cyan: "#8fd5d8",
      white: "#ead6e1",
      brightBlack: "#86677a",
      brightRed: "#ffa3b8",
      brightGreen: "#a8e6c4",
      brightYellow: "#f8d59f",
      brightBlue: "#bfcdf8",
      brightMagenta: "#f9a8d4",
      brightCyan: "#b4e5e7",
      brightWhite: "#fff5fa",
    },
  }),
  frost: theme("frost", "Frost", "Cool slate blue with an icy accent.", {
    scheme: "dark",
    canvas: "#1a1f29",
    sidebar: "#1a1f29",
    surface: "#222834",
    raised: "#29303d",
    overlay: "#303846",
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
  ember: theme("ember", "Ember", "Warm charcoal with a glowing orange accent.", {
    scheme: "dark",
    canvas: "#100c0a",
    sidebar: "#100c0a",
    surface: "#1a1512",
    raised: "#231c18",
    overlay: "#2a211c",
    text: "#f5ebe1",
    muted: "#c9b3a0",
    dim: "#b8a08c",
    disabled: "#6b594c",
    accent: "#f0883e",
    accentHover: "#f59d5c",
    accentPressed: "#dc7429",
    accentInk: "#200e02",
    blue: "#9fb6e0",
    green: "#8fc77a",
    amber: "#f0cf5f",
    red: "#f07b6b",
    greenInk: "#c6e4ba",
    amberInk: "#f6e3a8",
    redInk: "#f8c3bb",
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
  matrix: theme("matrix", "Matrix", "Phosphor green on a black screen.", {
    scheme: "dark",
    canvas: "#000000",
    sidebar: "#000000",
    surface: "#060f09",
    raised: "#0b170f",
    overlay: "#101f15",
    text: "#c9f8d6",
    muted: "#86c99b",
    dim: "#73b788",
    disabled: "#3b5e46",
    accent: "#22c55e",
    accentHover: "#3ad673",
    accentPressed: "#16a34a",
    accentInk: "#021007",
    blue: "#6ee7b7",
    green: "#4ade80",
    amber: "#d9e36b",
    red: "#f87171",
    greenInk: "#b5f5cb",
    amberInk: "#eef3b5",
    redInk: "#fbc1c1",
    danger: "#c03b3b",
    dangerHover: "#d04848",
    syntax: {
      keyword: "#5ff59a",
      string: "#b9f27c",
      regexp: "#d9e36b",
      number: "#9ff0c8",
      comment: "#3f7a52",
      function: "#7dfcc0",
      type: "#62d9a8",
      property: "#a6e8b9",
      variable: "#c9f8d6",
      operator: "#86c99b",
      punctuation: "#5c9a6f",
      heading: "#e3ffe9",
      deleted: "#f89a9a",
      invalid: "#f87171",
    },
    terminal: {
      foreground: "#b8f5c8",
      cursor: "#4ade80",
      selectionBackground: "rgba(34, 197, 94, 0.28)",
      black: "#101f15",
      red: "#f87171",
      green: "#4ade80",
      yellow: "#d9e36b",
      blue: "#5fd3b0",
      magenta: "#8ff0a4",
      cyan: "#6ee7b7",
      white: "#b8f5c8",
      brightBlack: "#3f7a52",
      brightRed: "#fca5a5",
      brightGreen: "#86efac",
      brightYellow: "#ecf29a",
      brightBlue: "#8ee6c9",
      brightMagenta: "#b5f7c1",
      brightCyan: "#a7f3d0",
      brightWhite: "#ecfff1",
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
