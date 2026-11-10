import type { PermissionMode, RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import type { ChatPlace } from "../sessions/launch.js";
import type { PendingLaunch } from "../sessions/sessions.js";
import { accountPlan, otherAgents } from "./agentModels.js";
import { ChatStart } from "./ChatView.js";
import { Composer, type ComposerAttachment } from "./Composer.js";
import { reasoningLevels } from "./reasoning.js";
import { WorkspaceBar } from "./WorkspaceBar.js";

/** What a draft chat's settings can change to before its first message. */
export type DraftChange = { provider?: string; model?: string | undefined; permissionMode?: PermissionMode };

export type DraftMessage = {
  text: string;
  attachments: ComposerAttachment[];
  reasoningEffort: string | undefined;
};

const NO_CAPABILITIES = {};

/**
 * A chat before its first message. Nothing runs yet: the agent, model, effort, permission, folder, and branch
 * are settings on the draft, so changing any of them is instant. Sending starts the agent with them and the
 * message goes out as soon as it is up.
 */
export function DraftChat({
  projection,
  launch,
  worktree,
  active,
  onChange,
  onMove,
  onSend,
}: {
  projection: RuntimeProjection;
  launch: PendingLaunch;
  worktree: WorktreeProjection;
  active: boolean;
  onChange(change: DraftChange): void;
  onMove(place: ChatPlace): Promise<string | undefined>;
  /** Resolves with a message when the agent could not start. */
  onSend(message: DraftMessage): Promise<string | undefined>;
}) {
  const [chosenEffort, setChosenEffort] = useState<string>();
  const [error, setError] = useState<string>();
  const provider = launch.provider;
  const discovery = projection.providers?.find((entry) => entry.provider === provider);
  const models = discovery?.status === "found" ? discovery.models : undefined;
  const reasoning = reasoningLevels(models, launch.model, NO_CAPABILITIES, discovery);
  const startingEffort = reasoning.levels.find((level) => level.toLowerCase() === "low");
  const reasoningEffort =
    (chosenEffort && reasoning.levels.includes(chosenEffort) ? chosenEffort : undefined) ?? startingEffort;
  const project = projection.projects.find((candidate) => candidate.projectId === worktree.projectId);
  const name = providerDisplayName(provider, projection.providers);

  return (
    <div className="chat-view">
      <div className="chat-log" role="log" aria-label="Agent conversation">
        <div className="chat-column">
          <ChatStart provider={provider} folder={project?.name} />
        </div>
      </div>
      <div className="chat-dock">
        <div className="chat-column">
          {error ? (
            <p className="inline-error" role="alert">
              {error}
            </p>
          ) : null}
          <Composer
            displayName={name}
            provider={provider}
            branch={worktree.branch}
            workspace={
              <WorkspaceBar
                project={project}
                projects={projection.projects}
                worktree={worktree}
                worktrees={projection.worktrees}
                git={project?.git !== false}
                onMove={onMove}
              />
            }
            disabled={false}
            models={models}
            model={launch.model}
            modelLocked={false}
            onModelChange={(model) => onChange({ model })}
            agentName={name}
            agentPlan={discovery?.status === "found" ? accountPlan(discovery.login) : undefined}
            otherAgents={otherAgents(projection.providers, provider)}
            onAgentChange={(next, model) => onChange({ provider: next, model })}
            reasoningLevels={reasoning.levels}
            defaultReasoning={startingEffort ?? reasoning.defaultLevel}
            reasoningEffort={reasoningEffort}
            onReasoningEffortChange={setChosenEffort}
            permissionMode={launch.permissionMode ?? "supervised"}
            onPermissionModeChange={(permissionMode) => onChange({ permissionMode })}
            projectId={worktree.projectId}
            onSubmit={async (text, attachments) => {
              setError(undefined);
              const failure = await onSend({ text, attachments, reasoningEffort });
              if (failure) setError(failure);
              return !failure;
            }}
            active={active}
            draftKey={launch.sessionId}
          />
        </div>
      </div>
    </div>
  );
}
