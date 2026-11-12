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
        {scratch}
      </EmptyState>
    );
  }
  if (project) {
    return (
      <EmptyState
        size="large"
        icon="folderOpen"
        title={`No chats in ${project.name} yet`}
        detail={
          closedCount > 0
            ? "Start one here, or pick a chat in the sidebar to open it again."
            : "Ask an agent to build, fix, or explain something in this project."
        }
      >
        <Button variant="primary" size="lg" icon="squarePen" shortcut={newChatShortcut} onClick={onNewAgent}>
          New chat
        </Button>
        {scratch}
      </EmptyState>
    );
  }
  return (
    <EmptyState
      size="large"
      icon="message"
      title="No chat open"
      detail={
        closedCount > 0
          ? "Pick a chat in the sidebar to open it, or start a new one."
          : "Ask an agent to build, fix, or explain something in your project."
      }
    >
      <Button variant="primary" size="lg" icon="squarePen" shortcut={newChatShortcut} onClick={onNewAgent}>
        New chat
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
