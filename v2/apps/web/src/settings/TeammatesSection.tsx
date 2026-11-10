import { agentNameKey, type PermissionMode, type RuntimeProjection } from "@zli-v2/contracts";
import { useId, useState } from "react";

import { isSelectableProvider, listedDiscoveries, providerDisplayName } from "../agent/providers.js";
import { makeCommandId } from "../runtime/commandId.js";
import { AnimalAvatar } from "../teammates/AnimalAvatar.js";
import {
  ANIMALS,
  type Animal,
  animalLabel,
  cleanTeammateName,
  MAX_TEAMMATE_INSTRUCTIONS,
  MAX_TEAMMATES,
  type Teammate,
} from "../teammates/teammates.js";
import { Button, IconButton } from "../ui/Button.js";
import { Field, Select } from "../ui/Field.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { Switch } from "../ui/Switch.js";
import { updateAppSettings, useAppSettings } from "./appSettings.js";
import { SectionHeader, SettingGroup } from "./SectionHeader.js";
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
  animal: Animal;
  provider: string;
  model: string;
  access: string;
  instructions: string;
};

/**
 * Saved teammates: an agent and model with a name, an animal, and standing instructions. They are brought
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
    const used = new Set(teammates.map((teammate) => teammate.animal));
    const animal = ANIMALS.find((candidate) => !used.has(candidate)) ?? "fox";
    setProblem(undefined);
    setDraft({
      name: "",
      animal,
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
      animal: teammate.animal,
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
      animal: draft.animal,
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
      <SectionHeader title="Teammates">
        Save the agents you work with as teammates, each with a name and an animal. In any chat, bring one in from Bring
        in above the message box, or type @ and its name. It reads the chat so far and answers there.
      </SectionHeader>
      <SettingGroup
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
              <AnimalAvatar animal={teammate.animal} provider={teammate.provider} size={30} />
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
            <fieldset className="teammate-animals">
              <legend className="field-label">Animal</legend>
              {ANIMALS.map((animal) => (
                <button
                  key={animal}
                  type="button"
                  className={`teammate-animal${draft.animal === animal ? " is-picked" : ""}`}
                  aria-pressed={draft.animal === animal}
                  aria-label={animalLabel[animal]}
                  title={animalLabel[animal]}
                  onClick={() => setDraft({ ...draft, animal })}
                >
                  <AnimalAvatar animal={animal} size={30} mood={draft.animal === animal ? "done" : "idle"} />
                </button>
              ))}
            </fieldset>
            <Field label="Name" hint="What you type after @, such as Reviewer.">
              <input
                id={`${ids}-name`}
                className="input"
                value={draft.name}
                maxLength={40}
                placeholder={animalLabel[draft.animal]}
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
      </SettingGroup>
      <SettingGroup title="Avatars">
        <Switch
          label="Animate avatars"
          hint="Avatars move while their agent works and raise a paw when it needs you. Off keeps them still."
          checked={animateTeammates}
          onChange={(checked) => updateAppSettings((settings) => ({ ...settings, animateTeammates: checked }))}
        />
      </SettingGroup>
    </>
  );
}
