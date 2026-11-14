import { DEFAULT_THEME, type Theme } from "@zli-v2/ui/themes";
import { type CSSProperties, useId } from "react";

import {
  type CustomTheme,
  customThemeFrom,
  MAX_CUSTOM_THEMES,
  resolveTheme,
  themeChoices,
} from "../theme/customThemes.js";
import { openThemeEditor, THEME_LIMIT_MESSAGE } from "../theme/themeEditorStore.js";
import { Button } from "../ui/Button.js";
import { Field } from "../ui/Field.js";
import { MenuButton } from "../ui/Menu.js";
import { Segmented } from "../ui/Segmented.js";
import { Switch } from "../ui/Switch.js";
import { type ChatTint, updateAppSettings, useAppSettings, type WindowLayout } from "./appSettings.js";
import { SettingsGroup, SettingsPageHeader } from "./SettingsLayout.js";
import { TypographySettings } from "./TypographySettings.js";
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
  atLimit = false,
}: {
  theme: Theme;
  name: string;
  checked: boolean;
  /** No room for another theme, so Duplicate is off. */
  atLimit?: boolean;
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
              disabled: atLimit,
              title: atLimit ? THEME_LIMIT_MESSAGE : undefined,
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

const layouts: readonly { id: WindowLayout; name: string; hint: string }[] = [
  { id: "columns", name: "Columns", hint: "Chat, panels, and sidebar sit side by side, each with its own header." },
  { id: "classic", name: "Classic", hint: "A top bar over the chat and the panel, each in its own rounded box." },
];

/** A tiny window in the layout's shape: flush columns with one header row, or a top bar over boxes. */
function LayoutPreview({ layout }: { layout: WindowLayout }) {
  return (
    <span className={`layout-preview is-${layout}`} aria-hidden="true">
      <span className="layout-preview-sidebar" />
      <span className="layout-preview-main">
        {layout === "classic" ? <span className="layout-preview-bar" /> : null}
        <span className="layout-preview-panes">
          <span className="layout-preview-pane" />
          <span className="layout-preview-pane is-side" />
        </span>
      </span>
    </span>
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
    <>
      <SettingsPageHeader title="Appearance">
        Colors, layout, fonts, and text sizes for every ZLI window, including terminals and the editor.
      </SettingsPageHeader>

      <SettingsGroup title="Theme" bare>
        <div className="theme-tiles" role="radiogroup" aria-label="Theme">
          {builtIn.map((theme) => (
            <ThemeTile key={theme.id} theme={theme} name={name} checked={current.id === theme.id} />
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Layout" bare>
        <div className="theme-tiles" role="radiogroup" aria-label="Layout">
          {layouts.map((layout) => (
            <div key={layout.id} className="theme-tile">
              <label className="theme-tile-pick" data-tooltip={layout.hint}>
                <input
                  type="radio"
                  name={`${name}-layout`}
                  value={layout.id}
                  checked={settings.layout === layout.id}
                  onChange={() => updateAppSettings((current) => ({ ...current, layout: layout.id }))}
                />
                <LayoutPreview layout={layout.id} />
                <span className="theme-tile-name">{layout.name}</span>
              </label>
            </div>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Sidebar">
        <Switch
          label="Color project headings"
          hint="Each project heading takes a soft tint of its own color, the same as its ring. Off keeps headings plain."
          checked={settings.tintProjects}
          onChange={(checked) => updateAppSettings((current) => ({ ...current, tintProjects: checked }))}
        />
        <Field
          label="Chats under a project"
          hint="Card: a faint wash of the project color holds its chats. Selection: only the open chat and the one you point at take the color. None: chats stay plain."
        >
          <Segmented<ChatTint>
            label="Chats under a project"
            value={settings.chatTint}
            options={[
              { value: "card", label: "Card" },
              { value: "selection", label: "Selection" },
              { value: "none", label: "None" },
            ]}
            onChange={(chatTint) => updateAppSettings((current) => ({ ...current, chatTint }))}
          />
        </Field>
      </SettingsGroup>

      <TypographySettings />

      <SettingsGroup
        title="Your themes"
        bare
        actions={
          <Button
            icon="plus"
            size="sm"
            variant="ghost"
            disabled={atLimit}
            tooltip={atLimit ? THEME_LIMIT_MESSAGE : undefined}
            onClick={create}
          >
            Create theme
          </Button>
        }
      >
        {yours.length > 0 ? (
          <div className="theme-tiles" role="radiogroup" aria-label="Your themes">
            {yours.map((theme) => (
              <ThemeTile
                key={theme.id}
                theme={theme}
                name={name}
                checked={current.id === theme.id}
                custom={settings.customThemes.find((entry) => entry.id === theme.id)}
                atLimit={atLimit}
              />
            ))}
          </div>
        ) : (
          <p className="settings-empty">Start from the theme you use now and change any color.</p>
        )}
      </SettingsGroup>
    </>
  );
}
