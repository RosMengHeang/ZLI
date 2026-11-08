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

/** The theme's own tokens on the preview, so the miniature window draws in that theme. */
function previewStyle(theme: Theme): CSSProperties {
  return theme.tokens as CSSProperties;
}

/** A small window: sidebar on the window color, and an agent terminal on the terminal color. */
function ThemePreview({ theme, large = false }: { theme: Theme; large?: boolean }) {
  return (
    <span className={`theme-preview${large ? " is-large" : ""}`} style={previewStyle(theme)} aria-hidden="true">
      <span className="theme-preview-sidebar">
        <span className="theme-preview-row is-selected" />
        <span className="theme-preview-row" />
        <span className="theme-preview-row is-short" />
      </span>
      <span className="theme-preview-terminal">
        <span className="theme-preview-prompt">
          <span className="is-accent" />
          <span className="is-text" />
        </span>
        <span className="theme-preview-prompt">
          <span className="is-green" />
          <span className="is-muted" />
        </span>
        <span className="theme-preview-prompt">
          <span className="is-amber" />
          <span className="is-muted is-short" />
        </span>
        <span className="theme-preview-button" />
      </span>
    </span>
  );
}

function Swatch({ label, color }: { label: string; color: string }) {
  return (
    <span className="theme-swatch">
      <span className="theme-swatch-chip" style={{ background: color }} />
      <span className="theme-swatch-label">{label}</span>
    </span>
  );
}

function pick(id: string) {
  updateAppSettings((current) => ({ ...current, theme: id }));
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
        <input type="radio" name={name} value={theme.id} checked={checked} onChange={() => pick(theme.id)} />
        <ThemePreview theme={theme} />
        <span className="theme-card-name">
          <span className="theme-card-title">{theme.name}</span>
          {checked ? <Icon name="check" size={13} /> : null}
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
  const builtInName = useId();
  const customName = useId();
  const current = resolveTheme(settings.theme, settings.customThemes);
  const currentCustom = settings.customThemes.find((theme) => theme.id === current.id);
  const atLimit = settings.customThemes.length >= MAX_CUSTOM_THEMES;
  const limitNote = atLimit ? `You can keep up to ${MAX_CUSTOM_THEMES} themes. Delete one to make another.` : undefined;
  const choices = themeChoices(settings.customThemes);
  const builtIn = choices.filter((theme) => !settings.customThemes.some((custom) => custom.id === theme.id));
  const yours = choices.filter((theme) => settings.customThemes.some((custom) => custom.id === theme.id));
  const createFromCurrent = () => openThemeEditor(customThemeFrom(current, `My ${current.name}`, currentCustom), true);

  return (
    <>
      <SectionHeader title="Appearance">Colors for every ZLI window, including terminals and the editor.</SectionHeader>

      <section className="theme-current" aria-label="Current theme">
        <ThemePreview theme={current} large />
        <div className="theme-current-copy">
          <span className="theme-current-kicker">Current theme</span>
          <h4 className="theme-current-name">{current.name}</h4>
          <p className="theme-current-description">{currentCustom ? "Made by you" : current.description}</p>
          <div className="theme-swatches">
            <Swatch label="Window" color={current.base.canvas} />
            <Swatch label="Terminal" color={current.base.surface} />
            <Swatch label="Accent" color={current.base.accent} />
          </div>
          <div className="theme-current-actions">
            {currentCustom ? (
              <Button icon="pencil" size="sm" onClick={() => openThemeEditor(currentCustom, false)}>
                Edit colors
              </Button>
            ) : (
              <Button icon="palette" size="sm" disabled={atLimit} tooltip={limitNote} onClick={createFromCurrent}>
                Customize colors
              </Button>
            )}
          </div>
        </div>
      </section>

      <SettingGroup title="Themes">
        <div className="theme-grid" role="radiogroup" aria-label="Themes">
          {builtIn.map((theme) => (
            <ThemeCard key={theme.id} theme={theme} name={builtInName} checked={current.id === theme.id} />
          ))}
        </div>
      </SettingGroup>

      <SettingGroup
        title="Your themes"
        actions={
          yours.length > 0 ? (
            <Button
              icon="plus"
              size="sm"
              variant="ghost"
              disabled={atLimit}
              tooltip={limitNote}
              onClick={createFromCurrent}
            >
              New theme
            </Button>
          ) : null
        }
      >
        {yours.length > 0 ? (
          <div className="theme-grid" role="radiogroup" aria-label="Your themes">
            {yours.map((theme) => (
              <ThemeCard
                key={theme.id}
                theme={theme}
                name={customName}
                checked={current.id === theme.id}
                custom={settings.customThemes.find((entry) => entry.id === theme.id)}
              />
            ))}
          </div>
        ) : (
          <div className="theme-empty">
            <p className="theme-empty-copy">
              Pick a window, terminal, and accent color, and see the change on the app as you go.
            </p>
            <Button icon="plus" size="sm" onClick={createFromCurrent}>
              Create a theme
            </Button>
          </div>
        )}
      </SettingGroup>
    </>
  );
}
