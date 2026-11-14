import type { PermissionMode, RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { useState } from "react";

import { agentUsable, chatAgentStatus } from "../agent/agentStatus.js";
import { providerDisplayName } from "../agent/providers.js";
import type { ChatPlace } from "../sessions/launch.js";
import type { PendingLaunch } from "../sessions/sessions.js";
import { useChatBuddy } from "../teammates/chatBuddies.js";
import { Icon } from "../ui/Icon.js";
import { AgentUnavailableNotice } from "./AgentUnavailableNotice.js";
import { accountPlan, otherAgents } from "./agentModels.js";
import { chatBranch } from "./branches.js";
import { StartSuggestions } from "./ChatExtras.js";
import { ChatStart } from "./ChatView.js";
import { Composer, type ComposerAttachment } from "./Composer.js";
import { fastFor, reasoningLevels } from "./reasoning.js";
import { WorkspaceBar } from "./WorkspaceBar.js";

/** What a draft chat's settings can change to before its first message. */
export type DraftChange = {
  provider?: string;
  model?: string | undefined;
  permissionMode?: PermissionMode;
  isolate?: boolean;
};

export type DraftMessage = {
  text: string;
  attachments: ComposerAttachment[];
  reasoningEffort: string | undefined;
  /** The model's fast value when fast is on. */
  fast?: string | undefined;
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
  onAddFolder,
  onSend,
}: {
  projection: RuntimeProjection;
  launch: PendingLaunch;
  worktree: WorktreeProjection;
  active: boolean;
  onChange(change: DraftChange): void;
  onMove(place: ChatPlace): Promise<string | undefined>;
  onAddFolder?: ((path?: string) => Promise<string | undefined>) | undefined;
  /** Resolves with a message when the agent could not start. */
  onSend(message: DraftMessage): Promise<string | undefined>;
}) {
  const [chosenEffort, setChosenEffort] = useState<string>();
  const [error, setError] = useState<string>();
  const provider = launch.provider;
  const discovery = projection.providers?.find((entry) => entry.provider === provider);
  // A draft on a saved account runs with that account, so only an install problem holds it back.
  const status = chatAgentStatus(discovery, launch.accountId);
  const models = discovery?.status === "found" ? discovery.models : undefined;
  const reasoning = reasoningLevels(models, launch.model, NO_CAPABILITIES, discovery);
  const startingEffort = reasoning.levels.find((level) => level.toLowerCase() === "low");
  const reasoningEffort =
    (chosenEffort && reasoning.levels.includes(chosenEffort) ? chosenEffort : undefined) ?? startingEffort;
  const [fastOn, setFastOn] = useState(false);
  const fastValue = fastFor(models, launch.model);
  const project = projection.projects.find((candidate) => candidate.projectId === worktree.projectId);
  const name = providerDisplayName(provider, projection.providers);
  const face = useChatBuddy(launch.sessionId);
  const [branch] = useState(() => chatBranch(launch.sessionId));
  const [insertRequest, setInsertRequest] = useState<{ text: string; nonce: number; replace?: boolean }>();
  // Counts "Start from an issue" clicks; the message box opens the picker and attaches the issue it gets.
  const [issueRequest, setIssueRequest] = useState(0);

  return (
    <div className="chat-view has-start-glow">
      <div className="chat-log" role="log" aria-label="Agent conversation">
        <div className="chat-column">
          {branch ? (
            <p className="chat-branched" role="note">
              <Icon name="branch" size={12} />
              <span>
                Branched from <span className="chat-branched-from">{branch.from}</span>. Any agent you pick gets that
                conversation with your first message.
              </span>
            </p>
          ) : null}
          <ChatStart
            provider={provider}
            folder={project?.name}
            buddy={face}
            onStartFromIssue={project ? () => setIssueRequest((count) => count + 1) : undefined}
          />
          {branch ? null : (
            <StartSuggestions
              folder={project?.name}
              onPick={(text) => setInsertRequest({ text, nonce: Date.now(), replace: true })}
            />
          )}
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
            insertRequest={insertRequest}
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
                onAddFolder={onAddFolder}
                isolate={launch.isolate === true}
                onIsolateChange={(isolate) => onChange({ isolate })}
              />
            }
            disabled={false}
            blocked={
              agentUsable(status) ? undefined : (
                <AgentUnavailableNotice name={name} provider={provider} status={status} />
              )
            }
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
            fast={fastValue ? fastOn : undefined}
            onFastChange={setFastOn}
            permissionMode={launch.permissionMode ?? "supervised"}
            onPermissionModeChange={(permissionMode) => onChange({ permissionMode })}
            projectId={worktree.projectId}
            onSubmit={async (text, attachments) => {
              setError(undefined);
              const failure = await onSend({
                text,
                attachments,
                reasoningEffort,
                ...(fastOn && fastValue ? { fast: fastValue } : {}),
              });
              if (failure) setError(failure);
              return !failure;
            }}
            active={active}
            draftKey={launch.sessionId}
            issueRequest={issueRequest || undefined}
          />
        </div>
      </div>
    </div>
  );
}
