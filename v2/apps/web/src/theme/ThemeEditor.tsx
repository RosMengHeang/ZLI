import { type ReactNode, useCallback, useId, useState } from "react";

import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { ColorPicker } from "./ColorPicker.js";
import {
  customBase,
  type EditableField,
  FIELD_GROUPS,
  FIELD_LABELS,
  MAX_THEME_NAME,
  readabilityProblems,
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

/** The color row open in the editor: one of the three main colors, or one under More colors. */
type Selection = SeedKey | EditableField;

const SEEDS: readonly { key: SeedKey; label: string; hint: string }[] = [
  { key: "background", label: "Window color", hint: "Sidebar, top bar, and gaps" },
  { key: "terminal", label: "Terminal color", hint: "Agent tiles and terminals" },
  { key: "accent", label: "Accent color", hint: "Main buttons, selection, and focus" },
];

function isSeed(choice: Selection): choice is SeedKey {
  return SEEDS.some((seed) => seed.key === choice);
}

function ColorRow({
  label,
  hint,
  value,
  open,
  overridden,
  action,
  onToggle,
  onChange,
  onReset,
}: {
  label: string;
  hint?: string | undefined;
  value: string;
  open: boolean;
  /** Set by hand instead of worked out from the three main colors. */
  overridden?: boolean;
  /** A small action under the hint, such as matching another color. */
  action?: ReactNode;
  onToggle(): void;
  onChange(hex: string): void;
  onReset?: (() => void) | undefined;
}) {
  return (
    <div className={`theme-color-row${open ? " is-open" : ""}${hint ? " has-hint" : ""}`}>
      <div className="theme-color-head">
        <button type="button" className="theme-color-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="theme-color-swatch" style={{ background: value }} />
          <span className="theme-color-copy">
            <span className="theme-color-label">{label}</span>
            {hint ? <span className="theme-color-hint">{hint}</span> : null}
          </span>
          {overridden ? <span className="theme-color-badge">Changed</span> : null}
          <span className="theme-color-hex">{value}</span>
        </button>
        {overridden && onReset ? (
          <IconButton label={`Reset ${label.toLowerCase()}`} icon="undo" size="xs" onClick={onReset} />
        ) : null}
      </div>
      {action ? <div className="theme-color-action">{action}</div> : null}
      {open ? <ColorPicker label={label} value={value} onChange={onChange} /> : null}
    </div>
  );
}

function EditorBody({ session }: { session: ThemeEditorSession }) {
  const { draft } = session;
  const base = customBase(draft);
  const problems = readabilityProblems(base);
  const nameId = useId();
  const [selection, setSelection] = useState<Selection>();
  const [moreOpen, setMoreOpen] = useState(Object.keys(draft.overrides).length > 0);
  const [inspecting, setInspecting] = useState(false);
  const [picked, setPicked] = useState<Selection[]>([]);

  const toggle = (next: Selection) => setSelection((current) => (current === next ? undefined : next));
  const setSeed = (key: SeedKey, hex: string) =>
    updateThemeDraft((current) => ({ ...current, seed: { ...current.seed, [key]: hex } }));
  const setField = (field: EditableField, hex: string) =>
    updateThemeDraft((current) => ({ ...current, overrides: { ...current.overrides, [field]: hex } }));
  const resetField = (field: EditableField) =>
    updateThemeDraft((current) => {
      const { [field]: _removed, ...overrides } = current.overrides;
      return { ...current, overrides };
    });

  const onPick = useCallback((fields: EditableField[]) => {
    const choices = [...new Set(fields.map((field) => seedFor(field) ?? field))];
    setInspecting(false);
    setPicked(choices);
    setSelection(choices[0]);
    // A first pick outside the three main colors lives under More colors.
    if (choices[0] && !isSeed(choices[0])) setMoreOpen(true);
    // The picked row may be further down the panel.
    requestAnimationFrame(() =>
      document.querySelector(".theme-color-row.is-open")?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  }, []);
  const onCancelInspect = useCallback(() => setInspecting(false), []);
  const labelOf = (choice: Selection) =>
    isSeed(choice) ? (SEEDS.find((seed) => seed.key === choice)?.label ?? choice) : FIELD_LABELS[choice];

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

        <section className="theme-editor-section" aria-label="Colors">
          {SEEDS.map((seed) => (
            <ColorRow
              key={seed.key}
              label={seed.label}
              hint={seed.hint}
              value={draft.seed[seed.key]}
              open={selection === seed.key}
              onToggle={() => toggle(seed.key)}
              onChange={(hex) => setSeed(seed.key, hex)}
              action={
                seed.key === "terminal" && draft.seed.terminal !== draft.seed.background ? (
                  <button
                    type="button"
                    className="theme-match"
                    onClick={() => setSeed("terminal", draft.seed.background)}
                  >
                    Use the window color
                  </button>
                ) : null
              }
            />
          ))}
        </section>

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

        <Button icon="crosshair" size="sm" className="theme-editor-inspect" onClick={() => setInspecting(true)}>
          Pick a color from the app
        </Button>

        {picked.length > 1 ? (
          <fieldset className="theme-picked">
            <legend className="theme-picked-legend">Colors at that spot</legend>
            {picked.map((choice) => (
              <button
                key={choice}
                type="button"
                className="theme-picked-chip"
                aria-pressed={selection === choice}
                onClick={() => {
                  setSelection(choice);
                  if (!isSeed(choice)) setMoreOpen(true);
                }}
              >
                {labelOf(choice)}
              </button>
            ))}
          </fieldset>
        ) : null}

        <section className="theme-editor-section">
          <button
            type="button"
            className="theme-editor-disclosure"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <Icon name={moreOpen ? "chevronDown" : "chevronRight"} size={13} />
            More colors
          </button>
          {moreOpen
            ? FIELD_GROUPS.map((group) => (
                <div key={group.title} className="theme-field-group">
                  <h4 className="theme-field-group-title">{group.title}</h4>
                  {group.fields.map((field) => (
                    <ColorRow
                      key={field}
                      label={FIELD_LABELS[field]}
                      value={base[field]}
                      open={selection === field}
                      overridden={draft.overrides[field] !== undefined}
                      onToggle={() => toggle(field)}
                      onChange={(hex) => setField(field, hex)}
                      onReset={() => resetField(field)}
                    />
                  ))}
                </div>
              ))
            : null}
        </section>
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
