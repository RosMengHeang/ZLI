import { agentNameKey, type PermissionMode, type RuntimeProjection } from "@zli-v2/contracts";
import { type CSSProperties, useId, useState } from "react";

import { isSelectableProvider, listedDiscoveries, providerDisplayName } from "../agent/providers.js";
import { makeCommandId } from "../runtime/commandId.js";
import {
  BUDDY_BODIES,
  BUDDY_COLOR_NAMES,
  BUDDY_COLORS,
  type Buddy,
  bodyLabel,
  buddyBody,
  buddyColor,
  buddyName,
  makeBuddy,
} from "../teammates/buddies.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { cleanTeammateName, MAX_TEAMMATE_INSTRUCTIONS, MAX_TEAMMATES, type Teammate } from "../teammates/teammates.js";
import { Button, IconButton } from "../ui/Button.js";
import { Field, Select } from "../ui/Field.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { Switch } from "../ui/Switch.js";
import { updateAppSettings, useAppSettings } from "./appSettings.js";
import { SettingsGroup, SettingsPageHeader } from "./SettingsLayout.js";
import "../teammates/teammates.css";

const DEFAULT_MODEL = "__default__";
const SAME_ACCESS = "__same__";

const accessLabel: Record<PermissionMode, string> = {
  "read-only": "Read only",
  supervised: "Asks before changes",
  "full-access": "Full access",
};

type Draft = {
  id?: string | undefined;
  name: string;
  buddy: Buddy;
  provider: string;
  model: string;
  access: string;
  instructions: string;
};

/**
 * Saved teammates: an agent and model with a name, a buddy, and standing instructions. They are brought
 * into a chat from its team bar, or called there with @Name.
 */
export function TeammatesSection({ projection }: { projection: RuntimeProjection | undefined }) {
  const { teammates, animateTeammates } = useAppSettings();
  const agents = listedDiscoveries(projection?.providers).filter(
    (entry) => entry.status === "found" && isSelectableProvider(entry.provider),
  );
  const [draft, setDraft] = useState<Draft>();
  const [problem, setProblem] = useState<string>();
  const ids = useId();

  const startNew = () => {
    // A new teammate starts as a buddy no other saved teammate wears yet, in its own color.
    const used = new Set(teammates.map((teammate) => buddyBody(teammate.buddy)));
    const buddy = BUDDY_BODIES.find((body) => !used.has(body)) ?? "gumdrop";
    setProblem(undefined);
    setDraft({
      name: "",
      buddy,
      provider: agents[0]?.provider ?? "claude-code",
      model: DEFAULT_MODEL,
      access: SAME_ACCESS,
      instructions: "",
    });
  };
  const edit = (teammate: Teammate) => {
    setProblem(undefined);
    setDraft({
      id: teammate.id,
      name: teammate.name,
      buddy: teammate.buddy,
      provider: teammate.provider,
      model: teammate.model ?? DEFAULT_MODEL,
      access: teammate.permissionMode ?? SAME_ACCESS,
      instructions: teammate.instructions ?? "",
    });
  };
  const remove = (id: string) =>
    updateAppSettings((settings) => ({
      ...settings,
      teammates: settings.teammates.filter((teammate) => teammate.id !== id),
    }));
  const save = () => {
    if (!draft) return;
    const name = cleanTeammateName(draft.name);
    if (!name) {
      setProblem("Give the teammate a name. It is what you type after @.");
      return;
    }
    if (teammates.some((teammate) => teammate.id !== draft.id && agentNameKey(teammate.name) === agentNameKey(name))) {
      setProblem(`You already have a teammate called ${name}.`);
      return;
    }
    const saved: Teammate = {
      id: draft.id ?? makeCommandId(),
      name,
      buddy: draft.buddy,
      provider: draft.provider as Teammate["provider"],
      ...(draft.model !== DEFAULT_MODEL ? { model: draft.model } : {}),
      ...(draft.access !== SAME_ACCESS ? { permissionMode: draft.access as PermissionMode } : {}),
      ...(draft.instructions.trim() ? { instructions: draft.instructions.trim() } : {}),
    };
    updateAppSettings((settings) => ({
      ...settings,
      teammates: draft.id
        ? settings.teammates.map((teammate) => (teammate.id === draft.id ? saved : teammate))
        : [...settings.teammates, saved],
    }));
    setDraft(undefined);
  };

  const discovery = draft ? agents.find((entry) => entry.provider === draft.provider) : undefined;
  const models = discovery?.status === "found" ? (discovery.models ?? []) : [];

  return (
    <>
      <SettingsPageHeader title="Teammates">
        Save the agents you work with as teammates, each with a name and a buddy. In any chat, bring one in from Bring
        in above the message box, or type @ and its name. It reads the chat so far and answers there.
      </SettingsPageHeader>
      <SettingsGroup
        title="Your teammates"
        actions={
          draft || teammates.length >= MAX_TEAMMATES ? null : (
            <Button size="sm" icon="plus" onClick={startNew} disabled={agents.length === 0}>
              Add teammate
            </Button>
          )
        }
      >
        {teammates.length === 0 && !draft ? (
          <p className="teammates-empty">
            {agents.length === 0
              ? "No agents are installed yet. Install Claude Code, Codex, or another agent first."
              : "No teammates yet. Add one, for example a Reviewer on Codex that checks tests."}
          </p>
        ) : null}
        <ul className="teammates-list">
          {teammates.map((teammate) => (
            <li key={teammate.id} className="teammate-row">
              <BuddyAvatar buddy={teammate.buddy} provider={teammate.provider} size={30} />
              <span className="teammate-copy">
                <span className="teammate-name">@{teammate.name}</span>
                <span className="teammate-meta">
                  {providerDisplayName(teammate.provider, projection?.providers)}
                  {teammate.model ? ` · ${teammate.model}` : ""}
                  {teammate.permissionMode ? ` · ${accessLabel[teammate.permissionMode]}` : ""}
                </span>
                {teammate.instructions ? <span className="teammate-notes">{teammate.instructions}</span> : null}
              </span>
              <IconButton label={`Edit ${teammate.name}`} icon="pencil" size="sm" onClick={() => edit(teammate)} />
              <IconButton
                label={`Remove ${teammate.name}`}
                icon="trash"
                size="sm"
                onClick={() => remove(teammate.id)}
              />
            </li>
          ))}
        </ul>
        {draft ? (
          <form
            className="teammate-form"
            aria-label={draft.id ? `Edit ${draft.name}` : "New teammate"}
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="teammate-look">
              <span className="teammate-look-preview" aria-hidden="true">
                <BuddyAvatar buddy={draft.buddy} size={72} />
              </span>
              <div className="teammate-look-pickers">
                <fieldset className="teammate-buddies">
                  <legend className="field-label">Buddy</legend>
                  {BUDDY_BODIES.map((body) => {
                    const picked = buddyBody(draft.buddy) === body;
                    const buddy = makeBuddy(body, buddyColor(draft.buddy));
                    return (
                      <button
                        key={body}
                        type="button"
                        className={`teammate-buddy${picked ? " is-picked" : ""}`}
                        aria-pressed={picked}
                        aria-label={bodyLabel[body]}
                        title={bodyLabel[body]}
                        onClick={() => setDraft({ ...draft, buddy })}
                      >
                        <BuddyAvatar buddy={buddy} size={30} full />
                      </button>
                    );
                  })}
                </fieldset>
                <fieldset className="teammate-colors">
                  <legend className="field-label">Color</legend>
                  {BUDDY_COLOR_NAMES.map((color) => {
                    const picked = buddyColor(draft.buddy) === color;
                    return (
                      <button
                        key={color}
                        type="button"
                        className={`teammate-color${picked ? " is-picked" : ""}`}
                        style={{ "--swatch": BUDDY_COLORS[color].hex } as CSSProperties}
                        aria-pressed={picked}
                        aria-label={BUDDY_COLORS[color].label}
                        title={BUDDY_COLORS[color].label}
                        onClick={() => setDraft({ ...draft, buddy: makeBuddy(buddyBody(draft.buddy), color) })}
                      />
                    );
                  })}
                </fieldset>
              </div>
            </div>
            <Field label="Name" hint="What you type after @, such as Reviewer.">
              <input
                id={`${ids}-name`}
                className="input"
                value={draft.name}
                maxLength={40}
                placeholder={buddyName(draft.buddy)}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </Field>
            <div className="teammate-pickers">
              <Field label="Agent">
                <Select<string>
                  label="Agent"
                  value={draft.provider}
                  options={agents.map((entry) => ({
                    value: entry.provider,
                    label: entry.displayName,
                    icon: <ProviderMark provider={entry.provider} size={15} />,
                  }))}
                  onChange={(provider) => setDraft({ ...draft, provider, model: DEFAULT_MODEL })}
                />
              </Field>
              <Field label="Model">
                <Select<string>
                  label="Model"
                  value={draft.model}
                  options={[
                    { value: DEFAULT_MODEL, label: "Agent's default" },
                    ...models.map((model) => ({ value: model.id, label: model.label })),
                  ]}
                  onChange={(model) => setDraft({ ...draft, model })}
                />
              </Field>
              <Field label="Access">
                <Select<string>
                  label="Access"
                  value={draft.access}
                  options={[
                    { value: SAME_ACCESS, label: "Same as the chat" },
                    ...(Object.keys(accessLabel) as PermissionMode[]).map((mode) => ({
                      value: mode,
                      label: accessLabel[mode],
                    })),
                  ]}
                  onChange={(access) => setDraft({ ...draft, access })}
                />
              </Field>
            </div>
            <Field label="Instructions" hint="Read by the teammate whenever it joins a chat.">
              <textarea
                className="textarea"
                rows={3}
                maxLength={MAX_TEAMMATE_INSTRUCTIONS}
                value={draft.instructions}
                placeholder="Review the changes for bugs and missing tests. Keep it short."
                onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
              />
            </Field>
            {problem ? (
              <p className="inline-error" role="alert">
                {problem}
              </p>
            ) : null}
            <div className="settings-actions">
              <Button size="sm" variant="ghost" onClick={() => setDraft(undefined)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" type="submit">
                {draft.id ? "Save" : "Add teammate"}
              </Button>
            </div>
          </form>
        ) : null}
      </SettingsGroup>
      <SettingsGroup title="Avatars">
        <Switch
          label="Animate avatars"
          hint="Buddies hop and blink while their agent works, and hop when it needs you. Off keeps them still."
          checked={animateTeammates}
          onChange={(checked) => updateAppSettings((settings) => ({ ...settings, animateTeammates: checked }))}
        />
      </SettingsGroup>
    </>
  );
}
