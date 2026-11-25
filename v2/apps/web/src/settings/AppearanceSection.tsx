import { THEMES, type Theme } from "@zli-v2/ui/themes";
import { type ChangeEvent, type CSSProperties, useId, useRef, useState } from "react";

import {
  BACKDROP_NAMES,
  BACKDROP_STYLES,
  BACKDROP_SWATCHES,
  type BackdropStyle,
  IMAGE_EFFECT_NAMES,
  IMAGE_EFFECTS,
  type ImageEffect,
} from "../chat/backdrop.js";
import {
  clearBackdropImage,
  prepareBackdropImage,
  saveBackdropImage,
  useBackdropImageUrl,
} from "../chat/backdropImage.js";
import { BackdropCanvas } from "../chat/ChatBackdrop.js";
import { ColorPicker, ColorPopover, ColorText, parseHexText } from "../theme/ColorPicker.js";
import {
  type CustomTheme,
  customThemeFrom,
  MAX_CUSTOM_THEMES,
  resolveTheme,
  SYSTEM_THEME,
} from "../theme/customThemes.js";
import { openThemeEditor, THEME_LIMIT_MESSAGE } from "../theme/themeEditorStore.js";
import { Button } from "../ui/Button.js";
import { MenuButton } from "../ui/Menu.js";
import { Picker } from "../ui/Picker.js";
import { Segmented } from "../ui/Segmented.js";
import { Switch } from "../ui/Switch.js";
import {
  type ChatBackdrop,
  type ChatTint,
  updateAppSettings,
  useAppSettings,
  type WindowLayout,
} from "./appSettings.js";
import { SettingsGroup, SettingsPageHeader, SettingsRow } from "./SettingsLayout.js";
import { SidebarLookSettings } from "./SidebarLookSettings.js";
import { TypographySettings } from "./TypographySettings.js";
import "../theme/themeEditor.css";
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

/** The built-in choices, in the order shown, each with the one line under its name. */
const builtInChoices: readonly { id: string; name: string; hint: string; preview: Theme[] }[] = [
  { id: SYSTEM_THEME, name: "System", hint: "Matches Windows", preview: [THEMES.daylight, THEMES.onyx] },
  { id: "daylight", name: "Light", hint: "White", preview: [THEMES.daylight] },
  { id: "onyx", name: "Dark", hint: "Pure black", preview: [THEMES.onyx] },
  { id: "midnight", name: "Midnight", hint: "Soft charcoal", preview: [THEMES.midnight] },
];

/** A built-in choice. System shows Light and Dark split down the middle. */
function BuiltInTile({
  choice,
  name,
  checked,
}: {
  choice: (typeof builtInChoices)[number];
  name: string;
  checked: boolean;
}) {
  const [first, second] = choice.preview;
  return (
    <div className="theme-tile">
      <label className="theme-tile-pick">
        <input type="radio" name={name} value={choice.id} checked={checked} onChange={() => pick(choice.id)} />
        <span className="theme-preview-stack">
          {first ? <ThemePreview theme={first} /> : null}
          {second ? (
            <span className="theme-preview-half">
              <ThemePreview theme={second} />
            </span>
          ) : null}
        </span>
        <span className="theme-tile-name">{choice.name}</span>
        <span className="theme-tile-hint">{choice.hint}</span>
      </label>
    </div>
  );
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
                  theme: current.theme === custom.id ? SYSTEM_THEME : current.theme,
                  customThemes: current.customThemes.filter((entry) => entry.id !== custom.id),
                })),
            },
          ]}
        />
      ) : null}
    </div>
  );
}

const chatTints: readonly { value: ChatTint; label: string; description: string }[] = [
  { value: "card", label: "Card", description: "A faint wash of the project color holds its chats." },
  { value: "selection", label: "Selection", description: "Only the open chat and the one you point at." },
  { value: "none", label: "None", description: "Chats stay plain." },
];

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

const backdropHints: Record<BackdropStyle, string> = {
  glow: "A faint wash of your color along the bottom edge.",
  dots: "Fine dots of your color rise from the bottom of the chat.",
  dither: "Square pixels of your color gather in the corners.",
  aurora: "A soft glow of your color with fine grain.",
  halftone: "Round dots that grow toward the corners.",
  image: "Your own picture, as a photo, blurred, dithered, or in halftone.",
  off: "The plain surface, with no background.",
};

function setBackdrop(change: Partial<ChatBackdrop>) {
  updateAppSettings((current) => ({ ...current, chatBackdrop: { ...current.chatBackdrop, ...change } }));
}

/** Back to the theme's accent: the saved color goes away. */
function resetBackdropColor() {
  updateAppSettings((current) => {
    const { color: _color, ...rest } = current.chatBackdrop;
    return { ...current, chatBackdrop: rest };
  });
}

/** Where Custom starts when the person had the theme color: a calm blue. */
const THEME_ACCENT_FALLBACK = "#4a6fdc";

/** A small view of one background, drawn the way the chat draws it. */
function BackdropPreview({ backdrop, hasImage }: { backdrop: ChatBackdrop; hasImage: boolean }) {
  const empty = backdrop.style === "off" || (backdrop.style === "image" && !hasImage);
  return (
    <span className="backdrop-preview" aria-hidden="true">
      {empty ? (
        <span className="backdrop-preview-off">{backdrop.style === "image" ? "Your picture" : "None"}</span>
      ) : (
        <BackdropCanvas backdrop={backdrop} />
      )}
    </span>
  );
}

/**
 * Theme follows the accent. Custom shows a swatch that opens the same picker as the theme editor, with the
 * hex value beside it to type into.
 */
function BackdropColor({ color }: { color: string | undefined }) {
  const [anchor, setAnchor] = useState<HTMLElement>();
  const shown = color ?? THEME_ACCENT_FALLBACK;
  return (
    <div className="backdrop-color">
      <Segmented<"theme" | "custom">
        label="Background color"
        value={color ? "custom" : "theme"}
        options={[
          { value: "theme", label: "Theme" },
          { value: "custom", label: "Custom" },
        ]}
        onChange={(next) => (next === "theme" ? resetBackdropColor() : setBackdrop({ color: shown }))}
      />
      {color ? (
        <span className="backdrop-color-custom">
          <button
            type="button"
            className="theme-row-swatch"
            style={{ background: color }}
            aria-label="Choose background color"
            aria-haspopup="dialog"
            aria-expanded={anchor !== undefined}
            onClick={(event) => {
              const target = event.currentTarget;
              setAnchor((open) => (open ? undefined : target));
            }}
          />
          <ColorText
            label="Background color hex"
            value={color}
            format={(hex) => hex}
            parse={parseHexText}
            onCommit={(hex) => setBackdrop({ color: hex })}
          />
        </span>
      ) : null}
      {anchor && color ? (
        <ColorPopover anchor={anchor} title="Background color" onClose={() => setAnchor(undefined)}>
          <ColorPicker
            label="Background color"
            value={color}
            swatches={BACKDROP_SWATCHES.map((swatch) => ({ color: swatch.hex, name: swatch.name }))}
            onChange={(hex) => setBackdrop({ color: hex })}
          />
        </ColorPopover>
      ) : null}
    </div>
  );
}

/** Choose, replace, or remove the picture. A problem is said in a line under the buttons. */
function BackdropImagePicker({ hasImage }: { hasImage: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      saveBackdropImage(await prepareBackdropImage(file));
      setBackdrop({ style: "image" });
    } catch (caught) {
      setError(
        caught instanceof DOMException
          ? "That picture is too large to keep. Try a smaller one."
          : caught instanceof Error
            ? caught.message
            : "That picture could not be used.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="backdrop-image-picker">
      <input ref={input} type="file" accept="image/*" hidden onChange={(event) => void choose(event)} />
      <Button icon="upload" size="sm" loading={busy} onClick={() => input.current?.click()}>
        {hasImage ? "Replace picture" : "Choose picture"}
      </Button>
      {hasImage ? (
        <Button icon="trash" size="sm" variant="ghost" onClick={clearBackdropImage}>
          Remove
        </Button>
      ) : null}
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ChatBackgroundSettings({ name }: { name: string }) {
  const { chatBackdrop } = useAppSettings();
  const hasImage = Boolean(useBackdropImageUrl());
  const { style } = chatBackdrop;
  const drawn = style !== "image" && style !== "off";
  return (
    <>
      <SettingsGroup title="Chat background" bare>
        <div className="theme-tiles backdrop-tiles" role="radiogroup" aria-label="Chat background">
          {BACKDROP_STYLES.map((option) => (
            <div key={option} className="theme-tile">
              <label className="theme-tile-pick" data-tooltip={backdropHints[option]}>
                <input
                  type="radio"
                  name={`${name}-backdrop`}
                  value={option}
                  checked={style === option}
                  onChange={() => setBackdrop({ style: option })}
                />
                <BackdropPreview backdrop={{ ...chatBackdrop, style: option }} hasImage={hasImage} />
                <span className="theme-tile-name">{BACKDROP_NAMES[option]}</span>
              </label>
            </div>
          ))}
        </div>
      </SettingsGroup>

      {style === "off" ? null : (
        <SettingsGroup title={style === "image" ? "Your picture" : "Look"}>
          {style === "image" ? (
            <>
              <SettingsRow
                label="Picture"
                description="JPG, PNG, or WebP. It is shrunk to fit and kept on this computer."
              >
                <BackdropImagePicker hasImage={hasImage} />
              </SettingsRow>
              <SettingsRow
                label="Effect"
                description="Photo shows it as it is. Blur, Dither, and Halftone turn it into a texture."
              >
                <Segmented<ImageEffect>
                  label="Picture effect"
                  value={chatBackdrop.imageEffect}
                  options={IMAGE_EFFECTS.map((effect) => ({ value: effect, label: IMAGE_EFFECT_NAMES[effect] }))}
                  onChange={(imageEffect) => setBackdrop({ imageEffect })}
                />
              </SettingsRow>
            </>
          ) : null}
          {drawn ? (
            <SettingsRow
              label="Color"
              description="Theme uses your theme's accent. Custom stays the same in every theme."
            >
              <BackdropColor color={chatBackdrop.color} />
            </SettingsRow>
          ) : null}
          <SettingsRow
            label="Strength"
            description="How much of the background shows. Text always keeps a calm area behind it."
          >
            <span className="type-size">
              <input
                className="type-size-range"
                type="range"
                min={0}
                max={100}
                step={5}
                aria-label="Background strength"
                value={chatBackdrop.intensity}
                onChange={(event) => setBackdrop({ intensity: Number(event.currentTarget.value) })}
              />
              <span className="type-size-value">{chatBackdrop.intensity}%</span>
            </span>
          </SettingsRow>
        </SettingsGroup>
      )}
    </>
  );
}

type AppearanceTab = "theme" | "background" | "layout" | "text";

const tabs: readonly { value: AppearanceTab; label: string }[] = [
  { value: "theme", label: "Theme" },
  { value: "background", label: "Background" },
  { value: "layout", label: "Layout" },
  { value: "text", label: "Text" },
];

/** The part last shown, so reopening Settings returns to it. */
let lastTab: AppearanceTab = "theme";

export function AppearanceSection() {
  const settings = useAppSettings();
  const name = useId();
  const [tab, setTab] = useState<AppearanceTab>(lastTab);
  const current = resolveTheme(settings.theme, settings.customThemes);
  const currentCustom = settings.customThemes.find((theme) => theme.id === current.id);
  const atLimit = settings.customThemes.length >= MAX_CUSTOM_THEMES;
  const yours = settings.customThemes.map((custom) => ({
    custom,
    theme: resolveTheme(custom.id, settings.customThemes),
  }));
  const create = () =>
    openThemeEditor(
      customThemeFrom(current, currentCustom ? `${current.name} copy` : `My ${current.name}`, currentCustom),
      true,
    );

  return (
    <>
      <SettingsPageHeader title="Appearance">
        Colors, background, layout, and text for every ZLI window, including terminals and the editor.
      </SettingsPageHeader>

      <div className="appearance-tabs">
        <Segmented<AppearanceTab>
          label="Appearance part"
          value={tab}
          options={tabs}
          onChange={(next) => {
            lastTab = next;
            setTab(next);
          }}
        />
      </div>

      {tab === "theme" ? (
        <>
          <SettingsGroup title="Theme" bare>
            <div className="theme-tiles" role="radiogroup" aria-label="Theme">
              {builtInChoices.map((choice) => (
                <BuiltInTile key={choice.id} choice={choice} name={name} checked={settings.theme === choice.id} />
              ))}
            </div>
          </SettingsGroup>

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
                {yours.map(({ custom, theme }) => (
                  <ThemeTile
                    key={custom.id}
                    theme={theme}
                    name={name}
                    checked={settings.theme === custom.id}
                    custom={custom}
                    atLimit={atLimit}
                  />
                ))}
              </div>
            ) : (
              <p className="settings-empty">Make your own from the theme on screen and change any color.</p>
            )}
          </SettingsGroup>
        </>
      ) : null}

      {tab === "background" ? <ChatBackgroundSettings name={name} /> : null}

      {tab === "layout" ? (
        <>
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
                      onChange={() =>
                        updateAppSettings((current) => ({ ...current, layout: layout.id, layoutChosen: true }))
                      }
                    />
                    <LayoutPreview layout={layout.id} />
                    <span className="theme-tile-name">{layout.name}</span>
                  </label>
                </div>
              ))}
            </div>
          </SettingsGroup>

          <SidebarLookSettings />

          <SettingsGroup title="Sidebar">
            <Switch
              label="One line per chat"
              hint="Each chat shows its title and time. A chat that is working, waiting on you, or failed still says so on a second line."
              checked={settings.compactChats}
              onChange={(checked) => updateAppSettings((current) => ({ ...current, compactChats: checked }))}
            />
            <Switch
              label="Color project headings"
              hint="Each project heading takes a soft tint of its own color, the same as its ring. Off keeps headings plain."
              checked={settings.tintProjects}
              onChange={(checked) => updateAppSettings((current) => ({ ...current, tintProjects: checked }))}
            />
            <SettingsRow label="Chats under a project" description="How much of the project color its chats take.">
              <Picker<ChatTint>
                label="Chats under a project"
                variant="field"
                className="appearance-picker"
                value={settings.chatTint}
                options={chatTints}
                onChange={(chatTint) => updateAppSettings((current) => ({ ...current, chatTint }))}
              >
                {chatTints.find((tint) => tint.value === settings.chatTint)?.label}
              </Picker>
            </SettingsRow>
          </SettingsGroup>
        </>
      ) : null}

      {tab === "text" ? <TypographySettings /> : null}
    </>
  );
}
