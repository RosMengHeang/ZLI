import { useCallback, useEffect, useId, useState } from "react";

import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { Segmented } from "../ui/Segmented.js";
import { ColorPicker, ColorPopover, ColorText, parseHexText, SWATCHES } from "./ColorPicker.js";
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
  { field: "canvas", label: "Sidebar", hint: "Also the top bar and the edges of the window" },
  { field: "surface", label: "Terminal", hint: "Agent tiles, terminals, and side panels" },
];
const SIMPLE_FIELDS = new Set<EditableField>(["canvas", "sidebar", "surface"]);

/** Starting colors when the person switches between a light and a dark theme. */
const SCHEME_START = {
  dark: { background: "#0a0a0a", terminal: "#0a0a0a", basedOn: "midnight" },
  light: { background: "#ececef", terminal: "#ffffff", basedOn: "daylight" },
} as const;

const identity = (hex: string) => hex;

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

/** One color: its name on the left, then a swatch that opens the picker and the hex value to type into. */
function ThemeRow({
  field,
  label,
  hint,
  value,
  selected,
  picked,
  changed,
  onOpen,
  onChange,
  onReset,
}: {
  field: EditableField;
  label: string;
  hint?: string | undefined;
  value: string;
  selected: boolean;
  /** Found under the pointer by Inspect, alongside the selected one. */
  picked: boolean;
  changed: boolean;
  onOpen(anchor: HTMLElement): void;
  onChange(hex: string): void;
  onReset(): void;
}) {
  return (
    <div className={`theme-row${selected ? " is-selected" : ""}${picked ? " is-picked" : ""}`} data-field={field}>
      <button
        type="button"
        className="theme-row-name"
        data-tooltip={hint}
        onClick={(event) =>
          onOpen(
            event.currentTarget.parentElement?.querySelector<HTMLElement>(".theme-row-swatch") ?? event.currentTarget,
          )
        }
      >
        {label}
      </button>
      {changed ? <IconButton label={`Reset ${label.toLowerCase()}`} icon="undo" size="xs" onClick={onReset} /> : null}
      <button
        type="button"
        className="theme-row-swatch"
        style={{ background: value }}
        aria-label={`Choose ${label.toLowerCase()}`}
        aria-haspopup="dialog"
        aria-expanded={selected}
        onClick={(event) => onOpen(event.currentTarget)}
      />
      <ColorText label={`${label} hex`} value={value} format={identity} parse={parseHexText} onCommit={onChange} />
    </div>
  );
}

function EditorBody({
  session,
  inspecting,
  onInspectEnd,
  onSelect,
}: {
  session: ThemeEditorSession;
  inspecting: boolean;
  onInspectEnd(): void;
  /** Tells the header which color is open, for its subtitle. */
  onSelect(label: string | undefined): void;
}) {
  const { draft } = session;
  const base = customBase(draft);
  const problems = readabilityProblems(base);
  const nameId = useId();
  const [advanced, setAdvanced] = useState(Object.keys(draft.overrides).length > 0);
  const [filter, setFilter] = useState("");
  const [open, setOpenState] = useState<{ field: EditableField; anchor: HTMLElement }>();
  const [picked, setPicked] = useState<EditableField[]>([]);

  const labelIn = (field: EditableField, inAdvanced: boolean) =>
    inAdvanced ? FIELD_LABELS[field] : (SIMPLE_ROWS.find((row) => row.field === field)?.label ?? FIELD_LABELS[field]);
  const labelFor = (field: EditableField) => labelIn(field, advanced);
  const setOpen = (next: { field: EditableField; anchor: HTMLElement } | undefined) => {
    setOpenState(next);
    onSelect(next ? labelFor(next.field) : undefined);
  };
  const setColor = (field: EditableField, hex: string) =>
    updateThemeDraft((current) => withColor(current, field, hex, !advanced));
  const reset = (field: EditableField) =>
    updateThemeDraft((current) => {
      const { [field]: _removed, ...overrides } = current.overrides;
      return { ...current, overrides };
    });
  const colorOf = (field: EditableField) => {
    const seed = seedFor(field);
    return seed ? draft.seed[seed] : base[field];
  };

  const row = (field: EditableField, label = FIELD_LABELS[field], hint = FIELD_HINTS[field]) => (
    <ThemeRow
      key={field}
      field={field}
      label={label}
      hint={hint}
      value={colorOf(field)}
      selected={open?.field === field}
      picked={picked.includes(field) && open?.field !== field}
      changed={draft.overrides[field] !== undefined}
      onOpen={(anchor) => setOpen(open?.field === field ? undefined : { field, anchor })}
      onChange={(hex) => setColor(field, hex)}
      onReset={() => reset(field)}
    />
  );

  const onPick = useCallback(
    (fields: EditableField[]) => {
      onInspectEnd();
      // The simple view has no separate sidebar row; its sidebar color is the window color.
      const useAdvanced = advanced || fields.some((field) => !SIMPLE_FIELDS.has(field));
      const choices = useAdvanced ? fields : [...new Set(fields.map((f) => (f === "sidebar" ? "canvas" : f)))];
      setAdvanced(useAdvanced);
      setFilter("");
      setPicked(choices);
      // Open the first one once its row is on screen.
      requestAnimationFrame(() => {
        const first = choices[0];
        const swatch = first
          ? document.querySelector<HTMLElement>(`.theme-row[data-field="${first}"] .theme-row-swatch`)
          : null;
        if (!first || !swatch) return;
        swatch.scrollIntoView({ block: "nearest" });
        setOpenState({ field: first, anchor: swatch });
        onSelect(useAdvanced ? FIELD_LABELS[first] : (SIMPLE_ROWS.find((row) => row.field === first)?.label ?? first));
      });
    },
    [advanced, onInspectEnd, onSelect],
  );

  const query = filter.trim().toLowerCase();
  const groups = AREA_GROUPS.map((group) => ({
    ...group,
    fields: group.fields.filter((field) => !query || FIELD_LABELS[field].toLowerCase().includes(query)),
  })).filter((group) => group.fields.length > 0);

  const swatchesFor = (field: EditableField) => {
    const preset = SWATCHES[colorKind(field)];
    // The terminal can take the sidebar's color in one click.
    return field === "surface"
      ? [{ color: draft.seed.background, name: advanced ? "Same as window" : "Same as sidebar" }, ...preset]
      : preset;
  };

  return (
    <>
      <div className="theme-editor-body">
        <div className="theme-form-row">
          <label className="theme-form-label" htmlFor={nameId}>
            Theme name
          </label>
          <input
            id={nameId}
            className="input input-sm"
            value={draft.name}
            maxLength={MAX_THEME_NAME}
            placeholder="e.g. Night Rose"
            onChange={(event) => updateThemeDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </div>
        <div className="theme-form-row">
          <span className="theme-form-label">Appearance</span>
          <Segmented
            label="Appearance"
            value={base.scheme}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            onChange={(scheme) => {
              if (scheme === base.scheme) return;
              const start = SCHEME_START[scheme];
              setOpen(undefined);
              updateThemeDraft((current) => ({
                ...current,
                basedOn: start.basedOn,
                seed: { ...current.seed, background: start.background, terminal: start.terminal },
                overrides: {},
              }));
            }}
          />
        </div>
        <div className="theme-form-row">
          <span className="theme-form-label">Colors</span>
          <div className="theme-colors-controls">
            {advanced ? (
              <input
                className="input input-sm theme-filter"
                value={filter}
                placeholder="Filter colors"
                aria-label="Filter colors"
                onChange={(event) => setFilter(event.target.value)}
              />
            ) : null}
            <label className="theme-advanced-toggle">
              <span>Advanced</span>
              <input
                className="switch"
                type="checkbox"
                role="switch"
                checked={advanced}
                aria-checked={advanced}
                onChange={(event) => {
                  setAdvanced(event.target.checked);
                  setOpen(undefined);
                  setPicked([]);
                  setFilter("");
                }}
              />
            </label>
          </div>
        </div>

        {advanced ? (
          groups.length > 0 ? (
            groups.map((group) => (
              <section key={group.title} className="theme-group" aria-label={group.title}>
                <h3 className="theme-group-title">{group.title}</h3>
                {group.fields.map((field) => row(field))}
              </section>
            ))
          ) : (
            <p className="theme-no-match">No colors match “{filter.trim()}”.</p>
          )
        ) : (
          <section className="theme-group" aria-label="Colors">
            {SIMPLE_ROWS.map((entry) => row(entry.field, entry.label, entry.hint))}
            <p className="theme-group-note">Turn on Advanced to change text, buttons, menus, and status colors.</p>
          </section>
        )}

        {problems.length > 0 ? (
          <div className="theme-readability" role="status">
            <Icon name="alert" size={13} />
            <ul>
              {problems.slice(0, 1).map((problem) => (
                <li key={`${problem.text}-${problem.surface}`}>
                  {FIELD_LABELS[problem.text]} on {FIELD_LABELS[problem.surface].toLowerCase()} is hard to read
                  {problems.length > 1 ? `, and ${problems.length - 1} more` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <footer className="theme-editor-footer">
        {session.error ? (
          <span className="theme-footer-error" role="alert">
            {session.error}
          </span>
        ) : problems.length === 0 ? (
          <span className="theme-footer-status" role="status">
            <Icon name="check" size={12} />
            Easy to read
          </span>
        ) : null}
        <Button variant="ghost" size="sm" onClick={closeThemeEditor}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" icon="check" onClick={saveThemeEditor}>
          {session.isNew ? "Create theme" : "Save changes"}
        </Button>
      </footer>
      {open ? (
        <ColorPopover anchor={open.anchor} title={labelFor(open.field)} onClose={() => setOpen(undefined)}>
          <ColorPicker
            label={labelFor(open.field)}
            value={colorOf(open.field)}
            swatches={swatchesFor(open.field)}
            onChange={(hex) => setColor(open.field, hex)}
          />
        </ColorPopover>
      ) : null}
      {inspecting ? <InspectOverlay onPick={onPick} onCancel={onInspectEnd} /> : null}
    </>
  );
}

/** Floats over the app so every change shows on the real interface while it is made. */
export function ThemeEditor() {
  const session = useThemeEditor();
  const [minimized, setMinimized] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [selected, setSelected] = useState<string>();
  const titleId = useId();
  const endInspect = useCallback(() => setInspecting(false), []);
  const canInspect = session !== undefined && !minimized;

  // The same keys as the element picker in browser developer tools.
  useEffect(() => {
    if (!canInspect) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== "c")
        return;
      event.preventDefault();
      setInspecting((value) => !value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canInspect]);

  if (!session) return null;
  const title = session.isNew ? "Create theme" : "Edit theme";
  const subtitle = inspecting ? "Pick an element · Esc" : selected;
  return (
    <aside className={`theme-editor${minimized ? " is-minimized" : ""}`} aria-labelledby={titleId}>
      <header className="theme-editor-header">
        <h2 id={titleId} className="theme-editor-title">
          {minimized ? session.draft.name.trim() || title : title}
        </h2>
        {subtitle && !minimized ? <span className="theme-editor-subtitle">{subtitle}</span> : null}
        <span className="theme-editor-header-actions">
          {minimized ? null : (
            <IconButton
              label="Select an element in the app to edit its color"
              tooltip={inspecting ? "Stop inspecting" : "Select an element to edit its color"}
              icon="inspect"
              size="sm"
              shortcut="Mod+Shift+C"
              pressed={inspecting}
              className="theme-inspect-button"
              onClick={() => setInspecting((value) => !value)}
            />
          )}
          <IconButton
            label={minimized ? "Expand the theme editor" : "Minimize the theme editor"}
            icon={minimized ? "chevronUp" : "chevronDown"}
            size="sm"
            onClick={() => setMinimized((value) => !value)}
          />
          <IconButton label="Close without saving" icon="x" size="sm" onClick={closeThemeEditor} />
        </span>
      </header>
      {minimized ? null : (
        <EditorBody session={session} inspecting={inspecting} onInspectEnd={endInspect} onSelect={setSelected} />
      )}
    </aside>
  );
}
