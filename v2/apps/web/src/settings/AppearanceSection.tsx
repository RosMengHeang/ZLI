import { THEME_IDS, THEMES, type Theme, type ThemeId } from "@zli-v2/ui/themes";
import { type CSSProperties, useId } from "react";

import { Icon } from "../ui/Icon.js";
import { updateAppSettings, useAppSettings } from "./appSettings.js";
import { SectionHeader, SettingGroup } from "./SectionHeader.js";
import "./appearance.css";

/** The theme's own tokens on the card, so its miniature window draws in that theme. */
function previewStyle(theme: Theme): CSSProperties {
  return theme.tokens as CSSProperties;
}

function ThemeCard({ theme, name, checked }: { theme: Theme; name: string; checked: boolean }) {
  return (
    <label className="theme-card">
      <input
        type="radio"
        name={name}
        value={theme.id}
        checked={checked}
        onChange={() => updateAppSettings((current) => ({ ...current, theme: theme.id }))}
      />
      <span className="theme-preview" style={previewStyle(theme)} aria-hidden="true">
        <span className="theme-preview-sidebar">
          <span className="theme-preview-row is-selected" />
          <span className="theme-preview-row" />
          <span className="theme-preview-row is-short" />
        </span>
        <span className="theme-preview-island">
          <span className="theme-preview-line is-text" />
          <span className="theme-preview-line is-muted" />
          <span className="theme-preview-code">
            <span className="is-keyword" />
            <span className="is-function" />
            <span className="is-string" />
          </span>
          <span className="theme-preview-foot">
            <span className="theme-preview-dot is-green" />
            <span className="theme-preview-dot is-amber" />
            <span className="theme-preview-button" />
          </span>
        </span>
      </span>
      <span className="theme-card-copy">
        <span className="theme-card-name">
          {theme.name}
          {checked ? <Icon name="check" size={13} /> : null}
        </span>
        <span className="theme-card-description">{theme.description}</span>
      </span>
    </label>
  );
}

export function AppearanceSection() {
  const settings = useAppSettings();
  const name = useId();
  return (
    <>
      <SectionHeader title="Appearance">Colors for every ZLI window, including terminals and the editor.</SectionHeader>
      <SettingGroup title="Theme">
        <div className="theme-grid" role="radiogroup" aria-label="Theme">
          {THEME_IDS.map((id: ThemeId) => (
            <ThemeCard key={id} theme={THEMES[id]} name={name} checked={settings.theme === id} />
          ))}
        </div>
      </SettingGroup>
    </>
  );
}
