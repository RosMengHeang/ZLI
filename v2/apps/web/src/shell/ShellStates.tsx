import type { ProjectProjection, RuntimeProjection } from "@zli-v2/contracts";

import { type KeyboardEvent, type ReactNode, useState } from "react";

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
  onStartChat,
  onScratchChat,
}: {
  projection: RuntimeProjection;
  /** A project the person just added that has no agents yet. */
  project?: ProjectProjection | undefined;
  closedCount: number;
  onOpenProject(): void;
  onNewAgent(): void;
  /** Starts a new chat with what was typed on this screen as its first message. */
  onStartChat?: ((text: string) => void) | undefined;
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
  if (onStartChat)
    return (
      <StartChat
        place={project?.name}
        hint={closedCount > 0 ? "Or pick a chat in the sidebar to open it again." : undefined}
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
 * The empty screen as a place to start: one question and the message box under it. Enter opens a new chat and sends
 * what was typed, so there is no New chat click before the first word.
 */
function StartChat({
  place,
  hint,
  onStart,
  children,
}: {
  place: string | undefined;
  hint: string | undefined;
  onStart(text: string): void;
  children?: ReactNode;
}) {
  const [text, setText] = useState("");
  const send = () => {
    const typed = text.trim();
    if (!typed) return;
    onStart(typed);
    setText("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };
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
          placeholder={place ? `Describe a task or ask a question about ${place}` : "Describe a task or ask a question"}
          rows={2}
          // biome-ignore lint/a11y/noAutofocus: the empty screen exists to be typed into
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="start-chat-row">
          <span className="start-chat-note">{hint ?? "Enter starts a new chat. Shift+Enter adds a line."}</span>
          <button type="submit" className="send-button" aria-label="Start chat" disabled={!text.trim()}>
            <Icon name="arrowUp" size={15} />
          </button>
        </div>
      </form>
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
