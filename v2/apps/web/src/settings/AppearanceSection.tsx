import { DEFAULT_THEME, type Theme } from "@zli-v2/ui/themes";
import { type CSSProperties, useId } from "react";

import {
  type CustomTheme,
  customThemeFrom,
  MAX_CUSTOM_THEMES,
  resolveTheme,
  themeChoices,
} from "../theme/customThemes.js";
import { openThemeEditor } from "../theme/themeEditorStore.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { MenuButton } from "../ui/Menu.js";
import { updateAppSettings, useAppSettings } from "./appSettings.js";
import { SectionHeader, SettingGroup } from "./SectionHeader.js";
import "./appearance.css";

/** The theme's own tokens on the preview, so its miniature window draws in that theme. */
function previewStyle(theme: Theme): CSSProperties {
  return theme.tokens as CSSProperties;
}

function ThemePreview({ theme }: { theme: Theme }) {
  return (
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
  );
}

function ThemeCard({
  theme,
  name,
  checked,
  custom,
}: {
  theme: Theme;
  name: string;
  checked: boolean;
  /** Present for a theme the person made, which gets its own menu. */
  custom?: CustomTheme | undefined;
}) {
  return (
    <div className="theme-card-wrap">
      <label className="theme-card">
        <input
          type="radio"
          name={name}
          value={theme.id}
          checked={checked}
          onChange={() => updateAppSettings((current) => ({ ...current, theme: theme.id }))}
        />
        <ThemePreview theme={theme} />
        <span className="theme-card-copy">
          <span className="theme-card-name">
            <span className="theme-card-title">{theme.name}</span>
            {checked ? <Icon name="check" size={13} /> : null}
          </span>
          <span className="theme-card-description">{theme.description}</span>
        </span>
      </label>
      {custom ? (
        <MenuButton
          label={`${theme.name} options`}
          size="xs"
          className="theme-card-menu"
          items={() => [
            { label: "Edit", icon: "pencil", run: () => openThemeEditor(custom, false) },
            {
              label: "Duplicate",
              icon: "copy",
              run: () => openThemeEditor(customThemeFrom(theme, `${theme.name} copy`, custom), true),
            },
            { separator: true },
            {
              label: "Delete theme",
              icon: "trash",
              tone: "danger",
              run: () =>
                updateAppSettings((current) => ({
                  ...current,
                  theme: current.theme === custom.id ? DEFAULT_THEME : current.theme,
                  customThemes: current.customThemes.filter((entry) => entry.id !== custom.id),
                })),
            },
          ]}
        />
      ) : null}
    </div>
  );
}

export function AppearanceSection() {
  const settings = useAppSettings();
  const name = useId();
  const current = resolveTheme(settings.theme, settings.customThemes);
  const currentCustom = settings.customThemes.find((theme) => theme.id === current.id);
  const atLimit = settings.customThemes.length >= MAX_CUSTOM_THEMES;
  const choices = themeChoices(settings.customThemes);
  return (
    <>
      <SectionHeader title="Appearance">Colors for every ZLI window, including terminals and the editor.</SectionHeader>
      <SettingGroup
        title="Theme"
        description="Make your own from two colors, or start from any theme here and change it."
        actions={
          <Button
            icon="plus"
            size="sm"
            disabled={atLimit}
            tooltip={
              atLimit ? `You can keep up to ${MAX_CUSTOM_THEMES} themes. Delete one to make another.` : undefined
            }
            onClick={() => openThemeEditor(customThemeFrom(current, `My ${current.name}`, currentCustom), true)}
          >
            Create theme
          </Button>
        }
      >
        <div className="theme-grid" role="radiogroup" aria-label="Theme">
          {choices.map((theme) => (
            <ThemeCard
              key={theme.id}
              theme={theme}
              name={name}
              checked={current.id === theme.id}
              custom={settings.customThemes.find((entry) => entry.id === theme.id)}
            />
          ))}
        </div>
      </SettingGroup>
    </>
  );
}
