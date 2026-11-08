import { useCallback, useId, useState } from "react";

import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { Switch } from "../ui/Switch.js";
import { ColorPicker, SWATCHES } from "./ColorPicker.js";
import {
  AREA_GROUPS,
  colorKind,
  customBase,
  type CustomTheme,
  type EditableField,
  FIELD_HINTS,
  FIELD_LABELS,
  MAX_THEME_NAME,
  readabilityProblems,
  SEED_FIELDS,
  type SeedKey,
  seedFor,
} from "./customThemes.js";
import { InspectOverlay } from "./InspectOverlay.js";
import {
  closeThemeEditor,
  saveThemeEditor,
  type ThemeEditorSession,
  updateThemeDraft,
  useThemeEditor,
} from "./themeEditorStore.js";
import "./themeEditor.css";

/** The two colors the simple view offers: the sidebar (with the rest of the window) and the terminal. */
const SIMPLE_ROWS: readonly { field: EditableField; label: string; hint: string }[] = [
  { field: "canvas", label: "Sidebar", hint: "Also the top bar and edges" },
  { field: "surface", label: "Terminal", hint: "Agent tiles and terminals" },
];

/** Sets one color: the three a theme starts from live in its seed, the rest are set by hand. */
function withColor(draft: CustomTheme, field: EditableField, hex: string, simple: boolean): CustomTheme {
  const seed = seedFor(field);
  if (!seed) return { ...draft, overrides: { ...draft.overrides, [field]: hex } };
  const next = { ...draft, seed: { ...draft.seed, [seed]: hex } };
  // In the simple view the sidebar row paints the whole window, sidebar included.
  if (simple && field === "canvas") {
    const { sidebar: _sidebar, ...overrides } = draft.overrides;
    return { ...next, overrides };
  }
  return next;
}

function ColorRow({
  label,
  hint,
  value,
  open,
  changed,
  swatches,
  match,
  onToggle,
  onChange,
  onReset,
}: {
  label: string;
  hint?: string | undefined;
  value: string;
  open: boolean;
  /** Set by hand rather than worked out from the theme's main colors. */
  changed?: boolean;
  swatches: readonly string[];
  /** Offers to copy another color, such as the terminal taking the sidebar's. */
  match?: { label: string; onMatch(): void } | undefined;
  onToggle(): void;
  onChange(hex: string): void;
  onReset?: (() => void) | undefined;
}) {
  return (
    <div className={`theme-color-row${open ? " is-open" : ""}`}>
      <div className="theme-color-head">
        <button type="button" className="theme-color-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="theme-color-swatch" style={{ background: value }} />
          <span className="theme-color-copy">
            <span className="theme-color-label">{label}</span>
            {hint ? <span className="theme-color-hint">{hint}</span> : null}
          </span>
          <span className="theme-color-hex">{value}</span>
          <Icon name={open ? "chevronUp" : "chevronDown"} size={13} className="theme-color-chevron" />
        </button>
        {changed && onReset ? (
          <IconButton label={`Reset ${label.toLowerCase()}`} icon="undo" size="xs" onClick={onReset} />
        ) : null}
      </div>
      {match ? (
        <button type="button" className="theme-match" onClick={match.onMatch}>
          {match.label}
        </button>
      ) : null}
      {open ? <ColorPicker label={label} value={value} swatches={swatches} onChange={onChange} /> : null}
    </div>
  );
}

function EditorBody({ session }: { session: ThemeEditorSession }) {
  const { draft } = session;
  const base = customBase(draft);
  const problems = readabilityProblems(base);
  const nameId = useId();
  const [open, setOpen] = useState<EditableField>();
  const [advanced, setAdvanced] = useState(Object.keys(draft.overrides).length > 0);
  const [inspecting, setInspecting] = useState(false);
  const [picked, setPicked] = useState<EditableField[]>([]);

  const toggle = (field: EditableField) => setOpen((current) => (current === field ? undefined : field));
  const setColor = (field: EditableField, hex: string) =>
    updateThemeDraft((current) => withColor(current, field, hex, !advanced));
  const reset = (field: EditableField) =>
    updateThemeDraft((current) => {
      const { [field]: _removed, ...overrides } = current.overrides;
      return { ...current, overrides };
    });
  const terminalMatch =
    draft.seed.terminal !== draft.seed.background
      ? {
          label: advanced ? "Use the window color" : "Use the sidebar color",
          onMatch: () => setColor("surface", draft.seed.background),
        }
      : undefined;
  const simpleLabel = (field: EditableField) =>
    SIMPLE_ROWS.find((entry) => entry.field === field)?.label ?? FIELD_LABELS[field];

  const row = (field: EditableField, label = FIELD_LABELS[field], hint = FIELD_HINTS[field]) => {
    const seed: SeedKey | undefined = seedFor(field);
    return (
      <ColorRow
        key={field}
        label={label}
        hint={hint}
        value={seed ? draft.seed[seed] : base[field]}
        open={open === field}
        changed={draft.overrides[field] !== undefined}
        swatches={SWATCHES[colorKind(field)]}
        match={field === SEED_FIELDS.terminal ? terminalMatch : undefined}
        onToggle={() => toggle(field)}
        onChange={(hex) => setColor(field, hex)}
        onReset={() => reset(field)}
      />
    );
  };

  const onPick = useCallback(
    (fields: EditableField[]) => {
      // The simple view has no separate sidebar row; its sidebar color is the window color.
      const choices = advanced ? fields : [...new Set(fields.map((field) => (field === "sidebar" ? "canvas" : field)))];
      setInspecting(false);
      setPicked(choices);
      setOpen(choices[0]);
      if (choices[0] && choices[0] !== "canvas" && choices[0] !== "surface") setAdvanced(true);
      // The picked row may be further down the panel.
      requestAnimationFrame(() =>
        document.querySelector(".theme-color-row.is-open")?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
      );
    },
    [advanced],
  );
  const onCancelInspect = useCallback(() => setInspecting(false), []);

  return (
    <>
      <div className="theme-editor-body">
        <div className="field">
          <label className="field-label" htmlFor={nameId}>
            Name
          </label>
          <input
            id={nameId}
            className="input input-sm"
            value={draft.name}
            maxLength={MAX_THEME_NAME}
            placeholder="Untitled theme"
            onChange={(event) => updateThemeDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </div>

        {advanced ? (
          AREA_GROUPS.map((group) => (
            <section key={group.title} className="theme-area" aria-label={group.title}>
              <h3 className="theme-area-title">{group.title}</h3>
              <div className="theme-area-rows">{group.fields.map((field) => row(field))}</div>
            </section>
          ))
        ) : (
          <section className="theme-area" aria-label="Colors">
            <div className="theme-area-rows">
              {SIMPLE_ROWS.map((entry) => row(entry.field, entry.label, entry.hint))}
            </div>
          </section>
        )}

        <div className="theme-advanced">
          <Switch
            label="Advanced"
            hint="Change text, buttons, menus, and status colors one by one."
            checked={advanced}
            onChange={(next) => {
              setAdvanced(next);
              setOpen(undefined);
              setPicked([]);
            }}
          />
        </div>

        <div className="theme-editor-tools">
          <Button icon="crosshair" size="sm" onClick={() => setInspecting(true)}>
            Pick a color from the app
          </Button>
          {picked.length > 1 ? (
            <fieldset className="theme-picked">
              <legend className="theme-picked-legend">At that spot:</legend>
              {picked.map((field) => (
                <button
                  key={field}
                  type="button"
                  className="theme-picked-chip"
                  aria-pressed={open === field}
                  onClick={() => setOpen(field)}
                >
                  {advanced ? FIELD_LABELS[field] : simpleLabel(field)}
                </button>
              ))}
            </fieldset>
          ) : null}
        </div>

        {problems.length > 0 ? (
          <div className="theme-readability is-warning" role="status">
            <Icon name="alert" size={13} />
            <ul>
              {problems.map((problem) => (
                <li key={`${problem.text}-${problem.surface}`}>
                  {FIELD_LABELS[problem.text]} on {FIELD_LABELS[problem.surface].toLowerCase()} is hard to read
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="theme-readability" role="status">
            <Icon name="check" size={13} />
            All text is easy to read.
          </p>
        )}
      </div>
      <footer className="theme-editor-footer">
        <Button variant="ghost" size="sm" onClick={closeThemeEditor}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={saveThemeEditor}>
          {session.isNew ? "Save theme" : "Save changes"}
        </Button>
      </footer>
      {inspecting ? <InspectOverlay onPick={onPick} onCancel={onCancelInspect} /> : null}
    </>
  );
}

/** Floats over the app so every change shows on the real interface while it is made. */
export function ThemeEditor() {
  const session = useThemeEditor();
  const [minimized, setMinimized] = useState(false);
  const titleId = useId();
  if (!session) return null;
  const title = session.isNew ? "New theme" : "Edit theme";
  return (
    <aside className={`theme-editor${minimized ? " is-minimized" : ""}`} aria-labelledby={titleId}>
      <header className="theme-editor-header">
        <Icon name="palette" size={14} />
        <h2 id={titleId} className="theme-editor-title">
          {minimized ? session.draft.name.trim() || title : title}
        </h2>
        <IconButton
          label={minimized ? "Expand the theme editor" : "Minimize the theme editor"}
          icon={minimized ? "maximize" : "minimize"}
          size="sm"
          onClick={() => setMinimized((value) => !value)}
        />
        <IconButton label="Close without saving" icon="x" size="sm" onClick={closeThemeEditor} />
      </header>
      {minimized ? null : <EditorBody session={session} />}
    </aside>
  );
}
