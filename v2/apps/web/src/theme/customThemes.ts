import {
  buildTheme,
  contrastRatio,
  DEFAULT_THEME,
  deriveBase,
  isHexColor,
  isThemeId,
  THEME_IDS,
  THEMES,
  type Theme,
  type ThemeBase,
  type ThemeId,
  type ThemeSeed,
} from "@zli-v2/ui/themes";

/** The colors a person can set one by one in the editor, beyond the two a theme starts from. */
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

export const FIELD_GROUPS: readonly { title: string; fields: readonly { field: EditableField; label: string }[] }[] = [
  {
    title: "Window",
    fields: [
      { field: "canvas", label: "Window" },
      { field: "sidebar", label: "Sidebar" },
    ],
  },
  {
    title: "Panels",
    fields: [
      { field: "surface", label: "Panels and terminal" },
      { field: "raised", label: "Controls" },
      { field: "overlay", label: "Menus and tooltips" },
    ],
  },
  {
    title: "Text",
    fields: [
      { field: "text", label: "Text" },
      { field: "muted", label: "Secondary text" },
      { field: "dim", label: "Hints" },
    ],
  },
  {
    title: "Accent",
    fields: [
      { field: "accent", label: "Accent" },
      { field: "accentInk", label: "Text on accent" },
    ],
  },
  {
    title: "Status",
    fields: [
      { field: "blue", label: "Active" },
      { field: "green", label: "Ready" },
      { field: "amber", label: "Modified" },
      { field: "red", label: "Failed" },
    ],
  },
];

export const FIELD_LABELS = Object.fromEntries(
  FIELD_GROUPS.flatMap((group) => group.fields.map((entry) => [entry.field, entry.label])),
) as Record<EditableField, string>;

/** A theme the person made: two colors and a depth, plus any colors they set by hand. */
export type CustomTheme = {
  id: string;
  name: string;
  /** The built-in theme it started from; status, code, and terminal colors come from it. */
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
    const depth = typeof seed.depth === "number" && Number.isFinite(seed.depth) ? seed.depth : 0.5;
    const overrides: CustomTheme["overrides"] = {};
    if (isRecord(entry.overrides)) {
      for (const field of EDITABLE_FIELDS) {
        const color = entry.overrides[field];
        if (isHexColor(color)) overrides[field] = color.toLowerCase();
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
        accent: seed.accent.toLowerCase(),
        depth: Math.min(1, Math.max(0, depth)),
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

/** How far a theme's panels sit from its window, as an editor depth. */
function depthOf(base: ThemeBase): number {
  const lift = contrastRatio(base.surface, base.canvas) - 1;
  return Math.min(1, Math.max(0, base.scheme === "dark" ? lift / 0.3 : lift / 0.2));
}

/**
 * A new theme that starts from `from`. A built-in theme gives its window color, accent, and depth, and
 * everything else is derived from those so the two colors stay in charge. A made theme is copied as is.
 */
export function customThemeFrom(from: Theme, name: string, custom?: CustomTheme): CustomTheme {
  if (custom) return { ...structuredClone(custom), id: newCustomThemeId(), name };
  const basedOn = isThemeId(from.id) ? from.id : DEFAULT_THEME;
  const seed = { background: from.base.canvas, accent: from.base.accent, depth: depthOf(from.base) };
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
