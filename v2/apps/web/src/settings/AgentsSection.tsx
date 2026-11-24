import {
  buddiesInOrder,
  DEFAULT_TEAM_DEFAULTS,
  type RuntimeProjection,
  type TeamDefaults,
  teamDefaults,
} from "@zli-v2/contracts";
import { useId, useState } from "react";

import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { lookOf } from "../teammates/pixelBuddies.js";
import { Select } from "../ui/Field.js";
import { Icon } from "../ui/Icon.js";
import { Segmented } from "../ui/Segmented.js";
import { AgentMessagesSection } from "./AgentMessagesSection.js";
import { SettingsGroup, SettingsPageHeader, SettingsRow } from "./SettingsLayout.js";

const PARALLEL = [1, 2, 3, 4, 5, 6] as const;
const ROUNDS = [0, 1, 2, 3] as const;

/**
 * Agents in one place: the buddies on the team, how far agents may reach each other, and how teams run by
 * default: whether a plan waits for the person, how many jobs run at once, and how many review rounds a task gets.
 */
export function AgentsSection({ projection }: { projection: RuntimeProjection | undefined }) {
  const { dispatch } = useRuntime();
  const ids = useId();
  const [problem, setProblem] = useState<string>();
  const buddies = projection ? buddiesInOrder(projection) : [];
  const defaults = projection ? teamDefaults(projection.buddySettings) : DEFAULT_TEAM_DEFAULTS;
  const save = async (change: Partial<TeamDefaults>) => {
    setProblem(undefined);
    try {
      const response = await dispatch({
        protocolVersion: 1,
        commandId: makeCommandId(),
        command: { type: "buddies.team", team: { ...defaults, ...change } },
      });
      if (response?.accepted === false) setProblem(response.error.message);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That did not save.");
    }
  };
  return (
    <>
      <SettingsPageHeader title="Agents">
        Your buddies, which agents can reach each other, and how teams run.
      </SettingsPageHeader>
      <SettingsGroup title="Your buddies" description="Change a buddy on its page in Buddies.">
        {buddies.length === 0 ? (
          <p className="settings-empty">No buddies yet. Open Buddies to start a team.</p>
        ) : (
          <ul className="settings-buddies">
            {buddies.map((buddy) => (
              <li key={buddy.buddyId} className="settings-buddy">
                <BuddyAvatar buddy={buddy.color} look={lookOf(buddy)} image={buddy.image} size={22} />
                <span className="settings-buddy-name">{buddy.name}</span>
                <span className="settings-buddy-meta">
                  {buddy.role === "primary" ? "Primary, leads teams" : (buddy.title ?? "Buddy")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>
      <AgentMessagesSection embedded />
      <SettingsGroup title="Team defaults">
        <SettingsRow
          label="New plans"
          description={
            defaults.autoStart
              ? "The plan starts as soon as the lead writes it."
              : "You check the lead's plan and press Go before any work starts."
          }
        >
          <Segmented<"review" | "auto">
            label="New plans"
            value={defaults.autoStart ? "auto" : "review"}
            options={[
              { value: "review", label: "Check first" },
              { value: "auto", label: "Start at once" },
            ]}
            onChange={(value) => void save({ autoStart: value === "auto" })}
          />
        </SettingsRow>
        <SettingsRow
          label="Jobs at once"
          description="How many of one team's tasks run at the same time."
          htmlFor={`${ids}-parallel`}
        >
          <Select<string>
            id={`${ids}-parallel`}
            label="Jobs at once"
            value={String(defaults.maxParallel)}
            options={PARALLEL.map((count) => ({ value: String(count), label: String(count) }))}
            onChange={(value) => void save({ maxParallel: Number(value) })}
          />
        </SettingsRow>
        <SettingsRow
          label="Review rounds"
          description={
            defaults.reviewRounds === 0
              ? "Tasks are merged without a review."
              : "Another buddy reviews each task. Notes go back to the buddy that did it, up to this many times."
          }
          htmlFor={`${ids}-rounds`}
        >
          <Select<string>
            id={`${ids}-rounds`}
            label="Review rounds"
            value={String(defaults.reviewRounds)}
            options={ROUNDS.map((count) => ({ value: String(count), label: count === 0 ? "None" : String(count) }))}
            onChange={(value) => void save({ reviewRounds: Number(value) })}
          />
        </SettingsRow>
      </SettingsGroup>
      {problem ? (
        <p className="inline-error" role="alert">
          <Icon name="alert" size={13} />
          {problem}
        </p>
      ) : null}
    </>
  );
}
