import { useId, useState } from "react";

import {
  cleanFontName,
  DEFAULT_TYPOGRAPHY,
  type FontChoice,
  fontStack,
  MONO_FONTS,
  SANS_FONTS,
  TYPOGRAPHY_LIMITS,
  type Typography,
} from "../theme/typography.js";
import { Button } from "../ui/Button.js";
import { Picker } from "../ui/Picker.js";
import { updateAppSettings, useAppSettings } from "./appSettings.js";
import { SettingsGroup, SettingsRow } from "./SettingsLayout.js";

const CUSTOM = "custom";

const update = (change: Partial<Typography>) =>
  updateAppSettings((current) => ({ ...current, typography: { ...current.typography, ...change } }));

/**
 * Settings > Appearance > Text: the interface and code fonts, and four sizes. Each change shows at once,
 * everywhere, and Reset goes back to the defaults.
 */
export function TypographySettings() {
  const typography = useAppSettings().typography;
  const changed = JSON.stringify(typography) !== JSON.stringify(DEFAULT_TYPOGRAPHY);
  return (
    <SettingsGroup
      title="Text"
      actions={
        changed ? (
          <Button size="xs" variant="ghost" onClick={() => update(DEFAULT_TYPOGRAPHY)}>
            Reset
          </Button>
        ) : null
      }
    >
      <FontRow
        label="Interface font"
        kind="sans"
        value={typography.sans}
        presets={SANS_FONTS}
        onChange={(sans) => update({ sans })}
      />
      <FontRow
        label="Code font"
        description="Code in chats and the terminal."
        kind="mono"
        value={typography.mono}
        presets={MONO_FONTS}
        onChange={(mono) => update({ mono })}
      />
      <SizeRow
        label="Interface size"
        description="Menus, sidebar, buttons, and labels."
        value={typography.interfaceSize}
        limits={TYPOGRAPHY_LIMITS.interfaceSize}
        onChange={(interfaceSize) => update({ interfaceSize })}
      />
      <SizeRow
        label="Chat text"
        description="Messages and the message box."
        value={typography.chatSize}
        limits={TYPOGRAPHY_LIMITS.chatSize}
        onChange={(chatSize) => update({ chatSize })}
      />
      <SizeRow
        label="Code size"
        value={typography.codeSize}
        limits={TYPOGRAPHY_LIMITS.codeSize}
        onChange={(codeSize) => update({ codeSize })}
      />
      <SizeRow
        label="Terminal size"
        value={typography.terminalSize}
        limits={TYPOGRAPHY_LIMITS.terminalSize}
        onChange={(terminalSize) => update({ terminalSize })}
      />
    </SettingsGroup>
  );
}

/** A font picked from the bundled ones, or any font on the computer typed by name. */
function FontRow({
  label,
  description,
  kind,
  value,
  presets,
  onChange,
}: {
  label: string;
  description?: string;
  kind: "sans" | "mono";
  value: FontChoice;
  presets: readonly { id: string; name: string }[];
  onChange(value: FontChoice): void;
}) {
  const id = useId();
  const custom = value.startsWith("custom:");
  const [typing, setTyping] = useState(custom);
  const [name, setName] = useState(custom ? value.slice("custom:".length) : "");
  const options = [
    ...presets.map((preset) => ({
      value: preset.id,
      label: preset.name,
      icon: (
        <span className="type-sample" style={{ fontFamily: fontStack(preset.id, kind) }} aria-hidden="true">
          Aa
        </span>
      ),
    })),
    { value: CUSTOM, label: "Another font…" },
  ];
  const picked = typing || custom ? CUSTOM : value;
  const shown = presets.find((preset) => preset.id === value)?.name ?? (custom ? value.slice(7) : "Another font");
  const save = (text: string) => {
    const clean = cleanFontName(text);
    if (clean) onChange(`custom:${clean}`);
  };
  return (
    <SettingsRow label={label} description={description} htmlFor={id}>
      <span className="type-font">
        {typing ? (
          <input
            className="input input-sm type-font-name"
            aria-label={`${label} name`}
            placeholder="Font name, e.g. Fira Code"
            value={name}
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => save(name)}
            onKeyDown={(event) => {
              if (event.key === "Enter") save(name);
            }}
            style={{ fontFamily: name ? fontStack(`custom:${cleanFontName(name)}`, kind) : undefined }}
          />
        ) : null}
        <Picker
          id={id}
          label={label}
          variant="field"
          value={picked}
          options={options}
          onChange={(next) => {
            if (next === CUSTOM) {
              setTyping(true);
              return;
            }
            setTyping(false);
            onChange(next);
          }}
        >
          <span style={{ fontFamily: fontStack(value, kind) }}>{typing ? "Another font" : shown}</span>
        </Picker>
      </span>
    </SettingsRow>
  );
}

/** A size slider with the value beside it, in pixels. */
function SizeRow({
  label,
  description,
  value,
  limits,
  onChange,
}: {
  label: string;
  description?: string;
  value: number;
  limits: { min: number; max: number; default: number };
  onChange(value: number): void;
}) {
  const id = useId();
  return (
    <SettingsRow label={label} description={description} htmlFor={id}>
      <span className="type-size">
        <input
          id={id}
          className="type-size-range"
          type="range"
          min={limits.min}
          max={limits.max}
          step={1}
          value={value}
          aria-valuetext={`${value} pixels`}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className={`type-size-value${value === limits.default ? "" : " is-changed"}`}>{value}px</span>
      </span>
    </SettingsRow>
  );
}
