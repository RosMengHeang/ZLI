import type { ProjectProjection, RuntimeProjection } from "@zli-v2/contracts";

import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { EmptyState, LoadingState, PaneHeader } from "../ui/Pane.js";
import { useShortcut } from "./keybindings.js";

export function GridEmptyState({
  projection,
  project,
  closedCount,
  onOpenProject,
  onNewAgent,
  onScratchChat,
}: {
  projection: RuntimeProjection;
  /** A project the person just added that has no agents yet. */
  project?: ProjectProjection | undefined;
  closedCount: number;
  onOpenProject(): void;
  onNewAgent(): void;
  /** Absent when scratch chats are not available, outside the desktop app. */
  onScratchChat?: (() => void) | undefined;
}) {
  const scratch = onScratchChat ? (
    <Button size="lg" icon="scratch" onClick={onScratchChat}>
      Scratch chat
    </Button>
  ) : null;
  const newAgentShortcut = useShortcut("newAgent");
  if (projection.projects.length === 0) {
    return (
      <EmptyState
        size="large"
        icon="folderOpen"
        title="Add a project to start"
        detail="Pick a Git repository folder. Agents run side by side in it, each in its own terminal. For a quick question, a scratch chat needs no project."
      >
        <Button variant="primary" size="lg" icon="folderPlus" onClick={onOpenProject}>
          Add project
        </Button>
        {scratch}
      </EmptyState>
    );
  }
  if (project) {
    return (
      <EmptyState
        size="large"
        icon="folderOpen"
        title={`No agents in ${project.name} yet`}
        detail={
          closedCount > 0
            ? "Start one here, or pick an agent in the sidebar to bring it back."
            : "Start an agent in a terminal or a chat. Run several at once, each in its own worktree or in the current checkout."
        }
      >
        <Button variant="primary" size="lg" icon="agentNew" shortcut={newAgentShortcut} onClick={onNewAgent}>
          New agent
        </Button>
        {scratch}
      </EmptyState>
    );
  }
  return (
    <EmptyState
      size="large"
      icon="grid"
      title="No agents on the board"
      detail={
        closedCount > 0
          ? "Pick an agent in the sidebar to bring it back, or start another one."
          : "Start an agent in a terminal or a chat. Run several at once, each in its own worktree or in the current checkout."
      }
    >
      <Button variant="primary" size="lg" icon="agentNew" shortcut={newAgentShortcut} onClick={onNewAgent}>
        New agent
      </Button>
      {scratch}
    </EmptyState>
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
      <span className="banner-message">No agents in {project.name} yet.</span>
      <Button variant="primary" size="sm" icon="agentNew" onClick={onNewAgent}>
        New agent
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
