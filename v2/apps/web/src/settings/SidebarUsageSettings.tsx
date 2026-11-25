import type { PlanLimitProvider, ProviderDiscovery } from "@zli-v2/contracts";

import { useId } from "react";

import { providerDisplayName } from "../agent/providers.js";
import { AUTO_COMPACT_AT_CHOICES } from "../chat/compaction.js";
import { limitProviders, usePlanLimits } from "../limits/limits.js";
import { Select } from "../ui/Field.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { Switch } from "../ui/Switch.js";
import { formatTokens } from "../usage/usage.js";
import { AUTO_COMPACT_CHOICES, useAgentSettings } from "./agentSettings.js";
import { type AutoCompact, type SidebarLimits, updateAppSettings, useAppSettings } from "./appSettings.js";
import { SettingsGroup, SettingsRow } from "./SettingsLayout.js";

const AUTOMATIC = "automatic";

const NONE_FOUND =
  "None of your agents report plan limits yet. Sign in to Claude Code, Codex, Gemini CLI, Cursor Agent, Droid, Kimi Code, or OpenCode Go with a subscription, and it shows up here.";

/**
 * The plan limits card in the sidebar: whether it shows, which agent the folded line follows, and which
 * agents it lists. Only agents with a plan that reports limits are listed.
 */
export function SidebarUsageGroup({ providers: discovered }: { providers: readonly ProviderDiscovery[] | undefined }) {
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
  const pinId = useId();
  const pinnable = providers.filter((provider) => !sidebarLimits.hidden.includes(provider));
  // A pin on an agent that is switched off or has no limits now reads as Automatic, and stays saved.
  const pinned = sidebarLimits.pinned && pinnable.includes(sidebarLimits.pinned) ? sidebarLimits.pinned : AUTOMATIC;
  const pin = (value: PlanLimitProvider | typeof AUTOMATIC) =>
    change(({ pinned: _previous, ...current }) => (value === AUTOMATIC ? current : { ...current, pinned: value }));

  return (
    <SettingsGroup
      title="Usage in the sidebar"
      description="How much of a plan's 5-hour, weekly, or monthly allowance each agent has used."
    >
      <Switch
        label="Show plan limits"
        hint="A line beside Settings with one limit and its reset. Click it to see every limit."
        checked={sidebarLimits.enabled}
        onChange={(enabled) => change((current) => ({ ...current, enabled }))}
      />
      <SettingsRow
        label="Agent in the footer"
        description="Automatic follows the selected agent. Pick one to always show its limit."
        htmlFor={pinId}
      >
        <Select<PlanLimitProvider | typeof AUTOMATIC>
          id={pinId}
          label="Agent in the footer"
          value={pinned}
          disabled={!sidebarLimits.enabled || pinnable.length === 0}
          options={[
            { value: AUTOMATIC, label: "Automatic" },
            ...pinnable.map((provider) => ({
              value: provider,
              label: providerDisplayName(provider, discovered),
              icon: <ProviderMark provider={provider} size={15} />,
            })),
          ]}
          onChange={pin}
        />
      </SettingsRow>
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
            label={providerDisplayName(provider, discovered)}
            checked={!sidebarLimits.hidden.includes(provider)}
            disabled={!sidebarLimits.enabled}
            onChange={(shown) => showAgent(provider, shown)}
          />
        ))
      )}
    </SettingsGroup>
  );
}

const DEFAULT_CHOICE = "default";

/** When Claude summarizes older context in chat agents. The runtime keeps it and applies it to new Claude chats. */
export function ClaudeContextGroup() {
  const { state, save } = useAgentSettings();
  const id = useId();
  const saved = state.status === "ready" ? state.settings.claudeAutoCompactTokens : undefined;
  const choices = AUTO_COMPACT_CHOICES.some((choice) => choice.tokens === saved)
    ? AUTO_COMPACT_CHOICES
    : [...AUTO_COMPACT_CHOICES, { tokens: saved, label: `${formatTokens(saved ?? 0)} tokens` }];
  const description =
    state.status === "error"
      ? state.message
      : state.status === "ready" && state.saveError
        ? state.saveError
        : "Claude summarizes older messages once a chat reaches this size. Lower makes each message cost less, but Claude forgets older details sooner. Applies to Claude chats started after you change it.";
  return (
    <SettingsGroup title="Claude context">
      <SettingsRow
        label="Summarize older context at"
        description={description}
        descriptionTone={
          state.status === "error" || (state.status === "ready" && state.saveError) ? "warning" : undefined
        }
        htmlFor={id}
      >
        <Select<string>
          id={id}
          label="Summarize older context at"
          value={saved === undefined ? DEFAULT_CHOICE : String(saved)}
          disabled={state.status !== "ready"}
          options={choices.map((choice) => ({
            value: choice.tokens === undefined ? DEFAULT_CHOICE : String(choice.tokens),
            label: choice.label,
          }))}
          onChange={(value) => void save(value === DEFAULT_CHOICE ? {} : { claudeAutoCompactTokens: Number(value) })}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

/** When ZLI compacts a chat by itself. Applies to every agent; the chat's own way of compacting is used. */
export function CompactingGroup() {
  const { autoCompact } = useAppSettings();
  const id = useId();
  const change = (next: Partial<AutoCompact>) =>
    updateAppSettings((current) => ({ ...current, autoCompact: { ...current.autoCompact, ...next } }));
  return (
    <SettingsGroup title="Compacting">
      <Switch
        label="Compact chats automatically"
        hint="After a turn ends, ZLI compacts a chat whose context is nearly full. Most agents compact with their own command. Gemini, Cursor and Droid write a summary and carry on in a fresh session."
        checked={autoCompact.enabled}
        onChange={(enabled) => change({ enabled })}
      />
      <SettingsRow
        label="Compact when context reaches"
        description="Only counts agents that report how full their context is."
        htmlFor={id}
      >
        <Select<string>
          id={id}
          label="Compact when context reaches"
          value={String(autoCompact.at)}
          disabled={!autoCompact.enabled}
          options={AUTO_COMPACT_AT_CHOICES.map((at) => ({ value: String(at), label: `${Math.round(at * 100)}%` }))}
          onChange={(value) => change({ at: Number(value) })}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
