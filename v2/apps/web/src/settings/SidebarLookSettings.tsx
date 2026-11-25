import { useState } from "react";

import { BACKDROP_SWATCHES } from "../chat/backdrop.js";
import { ColorPicker, ColorPopover, ColorText, parseHexText } from "../theme/ColorPicker.js";
import { Segmented } from "../ui/Segmented.js";
import {
  SIDEBAR_TINT_MAX,
  SIDEBAR_TINT_MIN,
  type SidebarBackground,
  type SidebarDensity,
  type SidebarLook,
  updateAppSettings,
  useAppSettings,
} from "./appSettings.js";
import { SettingsGroup, SettingsRow } from "./SettingsLayout.js";

/** The color a tint starts with: a calm blue. */
const TINT_START = "#4a6fdc";

function setLook(change: Partial<SidebarLook>) {
  updateAppSettings((current) => ({ ...current, sidebarLook: { ...current.sidebarLook, ...change } }));
}

/** The tint's color: the swatch opens a color picker, and the hex can be typed. */
function TintColor({ color }: { color: string }) {
  const [anchor, setAnchor] = useState<HTMLElement>();
  return (
    <span className="backdrop-color-custom">
      <button
        type="button"
        className="theme-row-swatch"
        style={{ background: color }}
        aria-label="Choose sidebar tint color"
        aria-haspopup="dialog"
        aria-expanded={anchor !== undefined}
        onClick={(event) => {
          const target = event.currentTarget;
          setAnchor((open) => (open ? undefined : target));
        }}
      />
      <ColorText
        label="Sidebar tint hex"
        value={color}
        format={(hex) => hex}
        parse={parseHexText}
        onCommit={(hex) => setLook({ color: hex })}
      />
      {anchor ? (
        <ColorPopover anchor={anchor} title="Sidebar tint" onClose={() => setAnchor(undefined)}>
          <ColorPicker
            label="Sidebar tint"
            value={color}
            swatches={BACKDROP_SWATCHES.map((swatch) => ({ color: swatch.hex, name: swatch.name }))}
            onChange={(hex) => setLook({ color: hex })}
          />
        </ColorPopover>
      ) : null}
    </span>
  );
}

/** The sidebar's background and how tall its rows are. */
export function SidebarLookSettings() {
  const { sidebarLook: look } = useAppSettings();
  return (
    <SettingsGroup title="Sidebar look">
      <SettingsRow
        label="Background"
        description="Theme keeps your theme's sidebar color. Same as chats uses the chat's color and a sidebar version of the chat background. Tint mixes in a color you pick."
      >
        <Segmented<SidebarBackground>
          label="Sidebar background"
          value={look.background}
          options={[
            { value: "theme", label: "Theme" },
            { value: "surface", label: "Same as chats" },
            { value: "tint", label: "Tint" },
          ]}
          onChange={(background) =>
            setLook(background === "tint" && !look.color ? { background, color: TINT_START } : { background })
          }
        />
      </SettingsRow>
      {look.background === "tint" ? (
        <>
          <SettingsRow label="Tint color" description="Click the swatch to pick a color, or type its hex.">
            <TintColor color={look.color ?? TINT_START} />
          </SettingsRow>
          <SettingsRow label="Tint strength" description="Kept light enough that text stays easy to read.">
            <span className="type-size">
              <input
                className="type-size-range"
                type="range"
                min={SIDEBAR_TINT_MIN}
                max={SIDEBAR_TINT_MAX}
                step={2}
                aria-label="Sidebar tint strength"
                value={look.strength}
                onChange={(event) => setLook({ strength: Number(event.currentTarget.value) })}
              />
              <span className="type-size-value">{look.strength}%</span>
            </span>
          </SettingsRow>
        </>
      ) : null}
      <SettingsRow label="Rows" description="Compact makes each chat and project row shorter, so more fit.">
        <Segmented<SidebarDensity>
          label="Sidebar rows"
          value={look.density}
          options={[
            { value: "comfortable", label: "Comfortable" },
            { value: "compact", label: "Compact" },
          ]}
          onChange={(density) => setLook({ density })}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
