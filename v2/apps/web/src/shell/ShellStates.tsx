import type { RuntimeProjection } from "@zli-v2/contracts";

import { Button } from "../ui/Button.js";
import { EmptyState, LoadingState, PaneHeader } from "../ui/Pane.js";

export function GridEmptyState({
  projection,
  closedCount,
  onOpenProject,
  onNewAgent,
}: {
  projection: RuntimeProjection;
  closedCount: number;
  onOpenProject(): void;
  onNewAgent(): void;
}) {
  if (projection.projects.length === 0) {
    return (
      <EmptyState
        size="large"
        icon="folderOpen"
        title="Add a project to start"
        detail="Pick a Git repository folder. Agents run side by side in it, each in its own terminal."
      >
        <Button variant="primary" size="lg" icon="folderPlus" onClick={onOpenProject}>
          Add project
        </Button>
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
      <Button variant="primary" size="lg" icon="plus" shortcut="Mod+N" showShortcut onClick={onNewAgent}>
        New agent
      </Button>
    </EmptyState>
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
