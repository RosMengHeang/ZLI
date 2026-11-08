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
import { MenuButton } from "../ui/Menu.js";
import { updateAppSettings, useAppSettings } from "./appSettings.js";
import { SectionHeader } from "./SectionHeader.js";
import "./appearance.css";

/** The theme's own tokens on the preview, so the miniature window draws in that theme. */
function previewStyle(theme: Theme): CSSProperties {
  return theme.tokens as CSSProperties;
}

/** A tiny window: sidebar rows on the window color, and an agent terminal with a few lines. */
function ThemePreview({ theme }: { theme: Theme }) {
  return (
    <span className="theme-preview" style={previewStyle(theme)} aria-hidden="true">
      <span className="theme-preview-sidebar">
        <span className="theme-preview-row is-selected" />
        <span className="theme-preview-row" />
        <span className="theme-preview-row is-short" />
      </span>
      <span className="theme-preview-terminal">
        <span className="theme-preview-line">
          <span className="is-accent" />
          <span className="is-text" />
        </span>
        <span className="theme-preview-line">
          <span className="is-green" />
          <span className="is-muted" />
        </span>
        <span className="theme-preview-button" />
      </span>
    </span>
  );
}

function pick(id: string) {
  updateAppSettings((current) => ({ ...current, theme: id }));
}

function ThemeTile({
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
    <div className="theme-tile">
      <label className="theme-tile-pick" data-tooltip={custom ? undefined : theme.description}>
        <input type="radio" name={name} value={theme.id} checked={checked} onChange={() => pick(theme.id)} />
        <ThemePreview theme={theme} />
        <span className="theme-tile-name">{theme.name}</span>
      </label>
      {custom ? (
        <MenuButton
          label={`${theme.name} options`}
          size="xs"
          className="theme-tile-menu"
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
  const isCustom = (theme: Theme) => settings.customThemes.some((custom) => custom.id === theme.id);
  const choices = themeChoices(settings.customThemes);
  const builtIn = choices.filter((theme) => !isCustom(theme));
  const yours = choices.filter(isCustom);
  const create = () =>
    openThemeEditor(
      customThemeFrom(current, currentCustom ? `${current.name} copy` : `My ${current.name}`, currentCustom),
      true,
    );

  return (
    <div className="appearance">
      <SectionHeader title="Appearance">Colors for every ZLI window, including terminals and the editor.</SectionHeader>

      <section className="appearance-block" aria-labelledby={`${name}-themes`}>
        <h4 id={`${name}-themes`} className="appearance-heading">
          Theme
        </h4>
        <div className="theme-tiles" role="radiogroup" aria-labelledby={`${name}-themes`}>
          {builtIn.map((theme) => (
            <ThemeTile key={theme.id} theme={theme} name={name} checked={current.id === theme.id} />
          ))}
        </div>
      </section>

      <section className="appearance-block" aria-labelledby={`${name}-yours`}>
        <div className="appearance-heading-row">
          <h4 id={`${name}-yours`} className="appearance-heading">
            Your themes
          </h4>
          <Button
            icon="plus"
            size="sm"
            variant="ghost"
            disabled={atLimit}
            tooltip={
              atLimit ? `You can keep up to ${MAX_CUSTOM_THEMES} themes. Delete one to make another.` : undefined
            }
            onClick={create}
          >
            Create theme
          </Button>
        </div>
        {yours.length > 0 ? (
          <div className="theme-tiles" role="radiogroup" aria-labelledby={`${name}-yours`}>
            {yours.map((theme) => (
              <ThemeTile
                key={theme.id}
                theme={theme}
                name={name}
                checked={current.id === theme.id}
                custom={settings.customThemes.find((entry) => entry.id === theme.id)}
              />
            ))}
          </div>
        ) : (
          <p className="appearance-empty">Start from the theme you use now and change any color.</p>
        )}
      </section>
    </div>
  );
}
