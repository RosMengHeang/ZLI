import type { PlanLimitProvider, RuntimeProjection } from "@zli-v2/contracts";

import { providerDisplayName } from "../agent/providers.js";
import { limitProviders, usePlanLimits } from "../limits/limits.js";
import { Switch } from "../ui/Switch.js";
import { type SidebarLimits, updateAppSettings, useAppSettings } from "./appSettings.js";
import { SectionHeader, SettingGroup } from "./SectionHeader.js";

const NONE_FOUND =
  "None of your agents report plan limits yet. Sign in to Claude Code, Codex, Gemini CLI, Cursor Agent, Kimi Code, or OpenCode Go with a subscription, and it shows up here.";

/** Turns the plan limits card on, and picks which agents it shows. Only agents with a plan that reports limits are listed. */
export function UsageSection({ projection }: { projection: RuntimeProjection | undefined }) {
  const { sidebarLimits } = useAppSettings();
  const limits = usePlanLimits();
  const providers = limits.status === "loading" ? [] : limitProviders(limits.readings);
  const change = (next: (current: SidebarLimits) => SidebarLimits) =>
    updateAppSettings((current) => ({ ...current, sidebarLimits: next(current.sidebarLimits) }));
  const showAgent = (provider: PlanLimitProvider, shown: boolean) =>
    change((current) => ({
      ...current,
      hidden: shown ? current.hidden.filter((entry) => entry !== provider) : [...current.hidden, provider],
    }));

  return (
    <>
      <SectionHeader title="Usage">
        Plan limits show how much of a subscription's 5-hour, weekly, or monthly allowance you have used. Tokens and
        cost are always under Usage in the sidebar.
      </SectionHeader>
      <SettingGroup title="Sidebar">
        <Switch
          label="Show plan limits"
          hint="A card above Settings with a circle per limit and when it resets."
          checked={sidebarLimits.enabled}
          onChange={(enabled) => change((current) => ({ ...current, enabled }))}
        />
      </SettingGroup>
      <SettingGroup title="Agents" description="Choose which agents the card shows.">
        {limits.status === "loading" ? (
          <p className="settings-empty" role="status">
            Checking your agents…
          </p>
        ) : providers.length === 0 ? (
          <p className="settings-empty">{limits.status === "error" ? limits.message : NONE_FOUND}</p>
        ) : (
          providers.map((provider) => (
            <Switch
              key={provider}
              label={providerDisplayName(provider, projection?.providers)}
              checked={!sidebarLimits.hidden.includes(provider)}
              disabled={!sidebarLimits.enabled}
              onChange={(shown) => showAgent(provider, shown)}
            />
          ))
        )}
      </SettingGroup>
    </>
  );
}
