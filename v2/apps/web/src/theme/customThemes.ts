import {
  buildTheme,
  contrastRatio,
  DEFAULT_THEME,
  deriveBase,
  isHexColor,
  isThemeId,
  mixHex,
  THEME_IDS,
  THEMES,
  type Theme,
  type ThemeBase,
  type ThemeId,
  type ThemeSeed,
} from "@zli-v2/ui/themes";

/** Every theme color a person can point at or change. */
export const EDITABLE_FIELDS = [
  "canvas",
  "sidebar",
  "surface",
  "raised",
  "overlay",
  "text",
  "muted",
  "dim",
  "accent",
  "accentInk",
  "blue",
  "green",
  "amber",
  "red",
] as const satisfies readonly (keyof ThemeBase)[];
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** The three colors a theme starts from, and the field each one fills. */
export const SEED_FIELDS = { background: "canvas", terminal: "surface", accent: "accent" } as const;
export type SeedKey = keyof typeof SEED_FIELDS;
const SEEDED = new Set<EditableField>(Object.values(SEED_FIELDS));

export const FIELD_LABELS: Record<EditableField, string> = {
  canvas: "Window",
  sidebar: "Sidebar",
  surface: "Terminal and panels",
  raised: "Buttons and fields",
  overlay: "Menus and tooltips",
  text: "Text",
  muted: "Secondary text",
  dim: "Hints",
  accent: "Accent",
  accentInk: "Text on accent",
  blue: "Active",
  green: "Ready",
  amber: "Modified",
  red: "Failed",
};

/** The colors under "More colors": everything except the three a theme starts from. */
export const FIELD_GROUPS: readonly { title: string; fields: readonly EditableField[] }[] = [
  { title: "Surfaces", fields: ["sidebar", "raised", "overlay"] },
  { title: "Text", fields: ["text", "muted", "dim", "accentInk"] },
  { title: "Status", fields: ["blue", "green", "amber", "red"] },
];

/** The seed a picked color belongs to, when it is one of the three a theme starts from. */
export function seedFor(field: EditableField): SeedKey | undefined {
  return (Object.keys(SEED_FIELDS) as SeedKey[]).find((key) => SEED_FIELDS[key] === field);
}

/** A theme the person made: three colors, plus any others they set by hand. */
export type CustomTheme = {
  id: string;
  name: string;
  /** The built-in theme it started from; status and code colors come from it. */
  basedOn: ThemeId;
  seed: ThemeSeed;
  overrides: Partial<Record<EditableField, string>>;
};

export const MAX_CUSTOM_THEMES = 24;
export const MAX_THEME_NAME = 40;
const CUSTOM_ID = /^custom-[a-z0-9]{4,24}$/u;

export function newCustomThemeId(): string {
  return `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keeps only well-formed themes, so a hand-edited or older settings file cannot break the window. */
export function parseCustomThemes(value: unknown): CustomTheme[] {
  if (!Array.isArray(value)) return [];
  const themes: CustomTheme[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !CUSTOM_ID.test(entry.id) || seen.has(entry.id)) continue;
    const seed = isRecord(entry.seed) ? entry.seed : {};
    if (!isHexColor(seed.background) || !isHexColor(seed.accent)) continue;
    // Themes saved before the terminal had its own color kept a panel depth instead.
    const depth = typeof seed.depth === "number" && Number.isFinite(seed.depth) ? seed.depth : 0;
    const terminal = isHexColor(seed.terminal)
      ? seed.terminal
      : mixHex(seed.background, "#ffffff", Math.min(1, Math.max(0, depth)) * 0.06);
    const overrides: CustomTheme["overrides"] = {};
    if (isRecord(entry.overrides)) {
      for (const field of EDITABLE_FIELDS) {
        const color = entry.overrides[field];
        // The three starting colors live in the seed, so a stored override of one is dropped.
        if (isHexColor(color) && !SEEDED.has(field)) overrides[field] = color.toLowerCase();
      }
    }
    const name = typeof entry.name === "string" ? entry.name.trim().slice(0, MAX_THEME_NAME) : "";
    seen.add(entry.id);
    themes.push({
      id: entry.id,
      name: name || "Untitled theme",
      basedOn: isThemeId(entry.basedOn) ? entry.basedOn : DEFAULT_THEME,
      seed: {
        background: seed.background.toLowerCase(),
        terminal: terminal.toLowerCase(),
        accent: seed.accent.toLowerCase(),
      },
      overrides,
    });
    if (themes.length >= MAX_CUSTOM_THEMES) break;
  }
  return themes;
}

/** The derived colors with the person's own picks laid over them. */
export function customBase(theme: CustomTheme): ThemeBase {
  return { ...deriveBase(theme.seed, THEMES[theme.basedOn].base), ...theme.overrides };
}

export function buildCustomTheme(theme: CustomTheme): Theme {
  return buildTheme(theme.id, theme.name, "Your theme", customBase(theme));
}

/**
 * A new theme that starts from `from`. A built-in theme gives its window, terminal, and accent colors,
 * and everything else is derived from those so the three colors stay in charge. A made theme is copied.
 */
export function customThemeFrom(from: Theme, name: string, custom?: CustomTheme): CustomTheme {
  if (custom) return { ...structuredClone(custom), id: newCustomThemeId(), name };
  const basedOn = isThemeId(from.id) ? from.id : DEFAULT_THEME;
  const seed = { background: from.base.canvas, terminal: from.base.surface, accent: from.base.accent };
  return { id: newCustomThemeId(), name, basedOn, seed, overrides: {} };
}

/** The theme an id names, falling back to the default when it is missing or was deleted. */
export function resolveTheme(id: string, customThemes: readonly CustomTheme[]): Theme {
  if (isThemeId(id)) return THEMES[id];
  const custom = customThemes.find((theme) => theme.id === id);
  return custom ? buildCustomTheme(custom) : THEMES[DEFAULT_THEME];
}

/** Every theme the person can pick, built-in first. */
export function themeChoices(customThemes: readonly CustomTheme[]): Theme[] {
  return [...THEME_IDS.map((id) => THEMES[id]), ...customThemes.map(buildCustomTheme)];
}

/** Text and surface pairs a theme must keep readable, for the editor's warning. */
const READABLE_PAIRS: readonly [EditableField, EditableField][] = [
  ["text", "canvas"],
  ["text", "surface"],
  ["text", "overlay"],
  ["muted", "surface"],
  ["muted", "overlay"],
  ["dim", "surface"],
  ["dim", "overlay"],
  ["accentInk", "accent"],
];

export type ReadabilityProblem = { text: EditableField; surface: EditableField; ratio: number };

/** Pairs below the WCAG AA ratio of 4.5:1 for body text. */
export function readabilityProblems(base: ThemeBase): ReadabilityProblem[] {
  return READABLE_PAIRS.flatMap(([text, surface]) => {
    const ratio = contrastRatio(base[text], base[surface]);
    return ratio < 4.5 ? [{ text, surface, ratio }] : [];
  });
}

/** The editable color each token is drawn from, so a picked element leads back to what to change. */
export const TOKEN_FIELDS: Readonly<Record<string, EditableField>> = {
  "--zli-canvas": "canvas",
  "--zli-sidebar": "sidebar",
  "--zli-surface": "surface",
  "--zli-terminal": "surface",
  "--zli-raised": "raised",
  "--zli-overlay": "overlay",
  "--zli-text": "text",
  "--zli-muted": "muted",
  "--zli-dim": "dim",
  "--zli-disabled": "dim",
  "--zli-accent": "accent",
  "--zli-accent-hover": "accent",
  "--zli-accent-pressed": "accent",
  "--zli-accent-soft": "accent",
  "--zli-accent-line": "accent",
  "--zli-accent-edge": "accent",
  "--zli-focus": "accent",
  "--zli-accent-ink": "accentInk",
  "--zli-blue": "blue",
  "--zli-blue-soft": "blue",
  "--zli-green": "green",
  "--zli-green-soft": "green",
  "--zli-green-ink": "green",
  "--zli-amber": "amber",
  "--zli-amber-soft": "amber",
  "--zli-amber-ink": "amber",
  "--zli-amber-line": "amber",
  "--zli-red": "red",
  "--zli-red-soft": "red",
  "--zli-red-ink": "red",
  "--zli-red-line": "red",
  "--zli-danger": "red",
  "--zli-danger-hover": "red",
};
