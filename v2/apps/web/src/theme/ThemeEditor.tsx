import { useCallback, useId, useState } from "react";

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

/** The color row being edited: one of the two seed colors, or a single color set by hand. */
type Selection = "background" | "accent" | EditableField;

function ColorRow({
  label,
  value,
  open,
  overridden,
  onToggle,
  onChange,
  onReset,
}: {
  label: string;
  value: string;
  open: boolean;
  /** Set by hand instead of derived from the two colors. */
  overridden?: boolean;
  onToggle(): void;
  onChange(hex: string): void;
  onReset?: (() => void) | undefined;
}) {
  return (
    <div className={`theme-color-row${open ? " is-open" : ""}`}>
      <div className="theme-color-head">
        <button type="button" className="theme-color-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="theme-color-swatch" style={{ background: value }} />
          <span className="theme-color-label">{label}</span>
          {overridden ? <span className="theme-color-badge">Set by hand</span> : null}
          <span className="theme-color-hex">{value}</span>
        </button>
        {overridden && onReset ? (
          <IconButton label={`Derive ${label} again`} icon="undo" size="xs" onClick={onReset} />
        ) : null}
      </div>
      {open ? <ColorPicker label={label} value={value} onChange={onChange} /> : null}
    </div>
  );
}

function EditorBody({ session }: { session: ThemeEditorSession }) {
  const { draft } = session;
  const base = customBase(draft);
  const problems = readabilityProblems(base);
  const nameId = useId();
  const depthId = useId();
  const [selection, setSelection] = useState<Selection>();
  const [fineTune, setFineTune] = useState(Object.keys(draft.overrides).length > 0);
  const [inspecting, setInspecting] = useState(false);
  const [picked, setPicked] = useState<EditableField[]>([]);

  const toggle = (next: Selection) => setSelection((current) => (current === next ? undefined : next));
  const setSeed = (key: "background" | "accent", hex: string) =>
    updateThemeDraft((current) => ({ ...current, seed: { ...current.seed, [key]: hex } }));
  const setField = (field: EditableField, hex: string) =>
    updateThemeDraft((current) => ({ ...current, overrides: { ...current.overrides, [field]: hex } }));
  const resetField = (field: EditableField) =>
    updateThemeDraft((current) => {
      const { [field]: _removed, ...overrides } = current.overrides;
      return { ...current, overrides };
    });

  const onPick = useCallback((fields: EditableField[]) => {
    setInspecting(false);
    setFineTune(true);
    setPicked(fields);
    setSelection(fields[0]);
    // The picked row may be far down the list.
    requestAnimationFrame(() =>
      document.querySelector(".theme-color-row.is-open")?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  }, []);
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

        <section className="theme-editor-section" aria-labelledby={`${nameId}-start`}>
          <h3 id={`${nameId}-start`} className="theme-editor-heading">
            Start with two colors
          </h3>
          <p className="theme-editor-note">The other colors are worked out from these.</p>
          <ColorRow
            label="Background"
            value={draft.seed.background}
            open={selection === "background"}
            onToggle={() => toggle("background")}
            onChange={(hex) => setSeed("background", hex)}
          />
          <ColorRow
            label="Accent"
            value={draft.seed.accent}
            open={selection === "accent"}
            onToggle={() => toggle("accent")}
            onChange={(hex) => setSeed("accent", hex)}
          />
          <div className="theme-depth">
            <label className="theme-depth-label" htmlFor={depthId}>
              Panel depth
            </label>
            <input
              id={depthId}
              className="range"
              type="range"
              min={0}
              max={100}
              value={Math.round(draft.seed.depth * 100)}
              aria-valuetext={draft.seed.depth === 0 ? "Flat" : `${Math.round(draft.seed.depth * 100)}%`}
              onChange={(event) =>
                updateThemeDraft((current) => ({
                  ...current,
                  seed: { ...current.seed, depth: Number(event.target.value) / 100 },
                }))
              }
            />
            <span className="theme-depth-scale" aria-hidden="true">
              <span>Flat</span>
              <span>Lifted</span>
            </span>
          </div>
        </section>

        <Button icon="crosshair" size="sm" className="theme-editor-inspect" onClick={() => setInspecting(true)}>
          Pick a color from the app
        </Button>

        {problems.length > 0 ? (
          <div className="theme-readability is-warning" role="status">
            <Icon name="alert" size={13} />
            <ul>
              {problems.map((problem) => (
                <li key={`${problem.text}-${problem.surface}`}>
                  {FIELD_LABELS[problem.text]} on {FIELD_LABELS[problem.surface].toLowerCase()} is hard to read (
                  {problem.ratio.toFixed(1)}:1, needs 4.5:1)
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

        <section className="theme-editor-section">
          <button
            type="button"
            className="theme-editor-disclosure"
            aria-expanded={fineTune}
            onClick={() => setFineTune((open) => !open)}
          >
            <Icon name={fineTune ? "chevronDown" : "chevronRight"} size={13} />
            Fine-tune each color
          </button>
          {fineTune ? (
            <>
              {picked.length > 1 ? (
                <fieldset className="theme-picked" aria-label="Colors at the picked spot">
                  {picked.map((field) => (
                    <button
                      key={field}
                      type="button"
                      className="theme-picked-chip"
                      aria-pressed={selection === field}
                      onClick={() => setSelection(field)}
                    >
                      {FIELD_LABELS[field]}
                    </button>
                  ))}
                </fieldset>
              ) : null}
              {FIELD_GROUPS.map((group) => (
                <div key={group.title} className="theme-field-group">
                  <h4 className="theme-field-group-title">{group.title}</h4>
                  {group.fields.map(({ field, label }) => (
                    <ColorRow
                      key={field}
                      label={label}
                      value={base[field]}
                      open={selection === field}
                      overridden={draft.overrides[field] !== undefined}
                      onToggle={() => toggle(field)}
                      onChange={(hex) => setField(field, hex)}
                      onReset={() => resetField(field)}
                    />
                  ))}
                </div>
              ))}
            </>
          ) : null}
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
