import type { ProjectProjection, RuntimeProjection } from "@zli-v2/contracts";

import { type KeyboardEvent, type ReactNode, useState } from "react";

import { useAccounts } from "../accounts/accounts.js";
import { providerDisplayName } from "../agent/providers.js";
import { AgentModelPicker } from "../chat/AgentModelPicker.js";
import { accountChoices, otherAgents } from "../chat/agentModels.js";
import { useKnownPlanLimits } from "../limits/limits.js";
import { readAppSettings, resolveLaunchDefaults } from "../settings/appSettings.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { MenuButton, type MenuItem } from "../ui/Menu.js";
import { EmptyState, LoadingState, PaneHeader } from "../ui/Pane.js";
import { defaultAgent } from "../welcome/welcome.js";
import { useShortcut } from "./keybindings.js";

/** The agent, model, and login picked on the empty screen, for the chat it starts. */
export type StartChoice = { provider?: string | undefined; model?: string | undefined; accountId?: string | undefined };

export function GridEmptyState({
  projection,
  project,
  closedCount,
  onOpenProject,
  onCloneProject,
  onNewAgent,
  onStartChat,
  startProject,
  onScratchChat,
}: {
  projection: RuntimeProjection;
  /** A project the person just added that has no agents yet. */
  project?: ProjectProjection | undefined;
  closedCount: number;
  onOpenProject(): void;
  /** Clones a repository from a forge and adds it; absent where cloning is not offered. */
  onCloneProject?: (() => void) | undefined;
  onNewAgent(): void;
  /** Starts a new chat in `project` with what was typed on this screen as its first message. */
  onStartChat?: ((text: string, project: ProjectProjection | undefined, choice: StartChoice) => void) | undefined;
  /** The project a chat starts in when the person picks none here. */
  startProject?: ProjectProjection | undefined;
  /** Absent when scratch chats are not available, outside the desktop app. */
  onScratchChat?: (() => void) | undefined;
}) {
  const scratch = onScratchChat ? (
    <Button size="lg" icon="scratch" onClick={onScratchChat}>
      Chat without a project
    </Button>
  ) : null;
  const newChatShortcut = useShortcut("newChat");
  if (projection.projects.length === 0) {
    return (
      <EmptyState
        size="large"
        icon="folderOpen"
        title="Add a project to start"
        detail="Pick a folder with your code, and chat with an agent about it. For a quick question, a chat needs no project."
      >
        <Button variant="primary" size="lg" icon="folderPlus" onClick={onOpenProject}>
          Add project
        </Button>
        {onCloneProject ? (
          <Button size="lg" icon="download" onClick={onCloneProject}>
            Clone repository
          </Button>
        ) : null}
        {scratch}
      </EmptyState>
    );
  }
  if (onStartChat)
    return (
      <StartChat
        projection={projection}
        initialProject={project ?? startProject}
        hint={closedCount > 0 ? "Or pick a chat in the sidebar to open it again." : undefined}
        onAddFolder={onOpenProject}
        onStart={onStartChat}
      >
        {scratch}
      </StartChat>
    );
  return (
    <EmptyState
      size="large"
      icon="message"
      title={project ? `No chats in ${project.name} yet` : "No chat open"}
      detail="Ask an agent to build, fix, or explain something in your project."
    >
      <Button variant="primary" size="lg" icon="squarePen" shortcut={newChatShortcut} onClick={onNewAgent}>
        New chat
      </Button>
      {scratch}
    </EmptyState>
  );
}

/**
 * The empty screen as a place to start: one question and a message box with the same choices as a chat's, the folder
 * and the agent with its model. Enter opens a new chat there and sends what was typed.
 */
function StartChat({
  projection,
  initialProject,
  hint,
  onAddFolder,
  onStart,
  children,
}: {
  projection: RuntimeProjection;
  initialProject: ProjectProjection | undefined;
  hint: string | undefined;
  onAddFolder(): void;
  onStart(text: string, project: ProjectProjection | undefined, choice: StartChoice): void;
  children?: ReactNode;
}) {
  const [text, setText] = useState("");
  // A folder picked here wins; until then the box follows the screen's project, such as one just added.
  const [projectId, setProjectId] = useState<string>();
  const [choice, setChoice] = useState<StartChoice>({});
  const { accounts } = useAccounts();
  const readings = useKnownPlanLimits();
  const project =
    projection.projects.find((candidate) => candidate.projectId === projectId) ??
    initialProject ??
    projection.projects[0];
  const defaults = resolveLaunchDefaults(readAppSettings(), project?.projectId);
  const provider = choice.provider ?? defaultAgent(projection.providers ?? [], defaults.provider)?.provider;
  const discovery = projection.providers?.find((entry) => entry.provider === provider);
  const models = discovery?.status === "found" ? discovery.models : undefined;
  const model = choice.model ?? (defaults.provider === provider ? defaults.model : undefined);
  const others = accountChoices(otherAgents(projection.providers, ""), {
    accounts,
    readings,
    providers: projection.providers,
    current: { provider: provider ?? "", accountId: choice.accountId },
  });

  const send = () => {
    const typed = text.trim();
    if (!typed) return;
    onStart(typed, project, { ...choice, ...(provider ? { provider } : {}), ...(model ? { model } : {}) });
    setText("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };
  const folderItems = (): MenuItem[] => [
    ...projection.projects.map((candidate) => ({
      label: candidate.name,
      icon: "folder" as const,
      checked: candidate.projectId === project?.projectId,
      run: () => setProjectId(candidate.projectId),
    })),
    { separator: true as const },
    {
      label: "Add a folder…",
      icon: "folderPlus" as const,
      run: () => {
        setProjectId(undefined);
        onAddFolder();
      },
    },
  ];
  return (
    <div className="start-chat">
      <h2 className="start-chat-title">What should we work on?</h2>
      <form
        className="start-chat-box"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          className="start-chat-input"
          aria-label="Start a chat"
          placeholder={
            project ? `Describe a task or ask a question about ${project.name}` : "Describe a task or ask a question"
          }
          rows={2}
          // biome-ignore lint/a11y/noAutofocus: the empty screen exists to be typed into
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="start-chat-row">
          <div className="start-chat-choices">
            <MenuButton label="Folder" items={folderItems} icon="folder" variant="ghost" className="start-chat-chip">
              {project?.name ?? "Add a folder"}
            </MenuButton>
            {provider ? (
              <AgentModelPicker
                provider={provider}
                agentName={providerDisplayName(provider, projection.providers)}
                models={models}
                model={model}
                others={others}
                locked={false}
                tooltip="Agent and model"
                onModelChange={(next) => setChoice((current) => ({ ...current, provider, model: next }))}
                onAgentChange={(next, nextModel, accountId) =>
                  setChoice({ provider: next, model: nextModel, ...(accountId ? { accountId } : {}) })
                }
              />
            ) : null}
          </div>
          <button type="submit" className="send-button" aria-label="Start chat" disabled={!text.trim()}>
            <Icon name="arrowUp" size={15} />
          </button>
        </div>
      </form>
      <p className="start-chat-note">{hint ?? "Enter starts a new chat. Shift+Enter adds a line."}</p>
      {children ? <div className="start-chat-more">{children}</div> : null}
    </div>
  );
}

/** Says a project the person just added has no agents, above the tiles from other projects so none of them move. */
export function ProjectEmptyNotice({
  project,
  onNewAgent,
  onDismiss,
}: {
  project: ProjectProjection;
  onNewAgent(): void;
  onDismiss(): void;
}) {
  return (
    <div className="banner banner-info board-project-notice" role="status">
      <Icon name="folderOpen" size={14} />
      <span className="banner-message">No chats in {project.name} yet.</span>
      <Button variant="primary" size="sm" icon="squarePen" onClick={onNewAgent}>
        New chat
      </Button>
      <IconButton label="Dismiss" icon="x" size="sm" onClick={onDismiss} />
    </div>
  );
}

export function RuntimeLoadingState() {
  return <LoadingState label="Connecting to the local runtime" />;
}

export function DisconnectedState() {
  return (
    <EmptyState
      size="large"
      icon="alert"
      tone="danger"
      title="Start ZLI from the desktop app"
      detail={
        <>
          This window has no runtime bridge. Run <code>pnpm --dir v2 desktop:dev</code> from the repository root.
        </>
      }
    />
  );
}

export function LoadingFilesPane() {
  return (
    <div className="tool-pane files-pane">
      <PaneHeader icon="folderTree" title="Files" />
      <LoadingState label="Loading the editor" />
    </div>
  );
}
