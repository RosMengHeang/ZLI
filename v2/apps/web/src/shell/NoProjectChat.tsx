import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { buddyHex } from "../teammates/buddies.js";
import { BuddyAvatar } from "../teammates/BuddyAvatar.js";
import { hashedBuddy } from "../teammates/chatBuddies.js";
import { scrollMovesAnchor, useAnchoredPlacement } from "../ui/anchoredPopup.js";
import { Icon } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import "../chat/chat.css";

/** Where the first chat will work: a folder on this computer. */
export type ChatFolder = { path: string; name: string };

/**
 * A new chat before there is any project. It looks and types like every other chat. The folder tab above the
 * message box opens the same kind of menu the chat's own tab does: any folder on this computer, or no folder
 * at all. Picking a folder opens the real chat there, with the
 * full message box and anything typed here already in it.
 */
export function NoProjectChat({
  agent,
  onPickFolder,
  onOpenChat,
  onScratchChat,
}: {
  /** The agent the chat will start with, shown where the model picker sits in the chat itself. */
  agent: { provider: string; name: string } | undefined;
  /** The system folder picker. Undefined when the person closed it. */
  onPickFolder(): Promise<ChatFolder | undefined>;
  /** Adds the folder as a project and opens a draft chat there, carrying the typed text. False when it could not. */
  onOpenChat(folder: ChatFolder, typed: string): Promise<boolean>;
  /** Absent outside the desktop app, where scratch chats are not available. */
  onScratchChat?: (() => void) | undefined;
}) {
  const [draft, setDraft] = useState("");
  const [folder, setFolder] = useState<ChatFolder>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [buddy] = useState(() => hashedBuddy(Math.random().toString(36)));
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => textareaRef.current?.focus(), []);

  const open = async (next: ChatFolder) => {
    if (starting) return;
    setStarting(true);
    try {
      // On success this screen goes away, and the chat that replaces it has the text.
      if (!(await onOpenChat(next, draft))) requestAnimationFrame(() => textareaRef.current?.focus());
    } finally {
      setStarting(false);
    }
  };
  const choose = (next: ChatFolder) => {
    setFolder(next);
    setMenuOpen(false);
    void open(next);
  };
  const browse = async () => {
    setMenuOpen(false);
    const picked = await onPickFolder();
    if (picked) choose(picked);
  };
  const send = (event?: FormEvent) => {
    event?.preventDefault();
    // Sending before a folder is picked opens the folder menu, so the message is never lost.
    if (!folder) {
      setMenuOpen(true);
      return;
    }
    // Only reached when opening the chat failed: try again.
    void open(folder);
  };

  return (
    <div className="chat-view no-project-chat has-start-glow">
      <div className="chat-log" role="log" aria-label="Agent conversation">
        <div className="chat-column">
          <div className="chat-start no-project-start">
            <span className="buddy-glow" style={{ "--face": buddyHex(buddy) } as CSSProperties}>
              <BuddyAvatar buddy={buddy} mood={starting ? "working" : "idle"} size={92} />
            </span>
            <h2 className="chat-start-title">What should we work on?</h2>
            <p className="no-project-hint">
              {folder ? (
                <>
                  Opening a chat in <span className="no-project-hint-folder">{folder.name}</span>.
                </>
              ) : (
                "Pick a folder for the agent, then say what you need."
              )}
            </p>
          </div>
        </div>
      </div>
      <div className="chat-dock">
        <div className="chat-column">
          <div className="composer-workspace">
            <FolderTab
              folder={folder}
              open={menuOpen}
              onOpen={setMenuOpen}
              onBrowse={() => void browse()}
              onScratch={onScratchChat}
            />
          </div>
          <form className="composer no-project-composer" aria-label="New chat" onSubmit={send}>
            <textarea
              ref={textareaRef}
              value={draft}
              rows={2}
              aria-label="Message the agent"
              placeholder={folder ? `Ask ${agent?.name ?? "the agent"} anything in ${folder.name}` : "Ask anything"}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <div className="composer-footer">
              <span className="composer-spacer" />
              {agent ? (
                <span className="no-project-agent" data-tooltip="Pick a folder to choose the agent and model">
                  <ProviderMark provider={agent.provider} size={14} />
                  {agent.name}
                </span>
              ) : null}
              <span className="send-split">
                <button
                  className="send-button"
                  type="submit"
                  aria-label={folder ? "Open the chat" : "Choose a folder"}
                  data-tooltip={folder ? "Open the chat" : "Choose a folder first"}
                  disabled={starting || (!folder && !draft.trim())}
                >
                  {starting ? <span className="spinner" aria-hidden="true" /> : <Icon name="arrowUp" size={15} />}
                </button>
              </span>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

/** The folder tab and its menu, styled like the tab of a started chat. */
function FolderTab({
  folder,
  open,
  onOpen,
  onBrowse,
  onScratch,
}: {
  folder: ChatFolder | undefined;
  open: boolean;
  onOpen(open: boolean): void;
  onBrowse(): void;
  onScratch?: (() => void) | undefined;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = useAnchoredPlacement(open, triggerRef, menuRef, {
    prefer: "above",
    align: "start",
    gap: 6,
    edge: 8,
  });
  const placed = placement !== undefined;
  useLayoutEffect(() => {
    if (placed) menuRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus({ preventScroll: true });
  }, [placed]);
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (menuRef.current?.contains(target) || triggerRef.current?.contains(target));
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) onOpen(false);
    };
    const onScroll = (event: Event) => {
      if (scrollMovesAnchor(event, triggerRef.current)) onOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open, onOpen]);

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? items[(index + 1) % items.length] : items.at(index <= 0 ? -1 : index - 1);
    event.preventDefault();
    next?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`composer-workspace-item is-button is-folder${folder ? "" : " is-unset"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={folder ? `Project: ${folder.name}. Choose another` : "Choose a project"}
        onClick={() => onOpen(!open)}
      >
        <Icon name={folder ? "folder" : "folderPlus"} size={14} />
        <span className="composer-workspace-label">{folder ? folder.name : "Choose a project"}</span>
        <Icon name="chevronDown" size={11} className="picker-chevron" />
      </button>
      {open
        ? createPortal(
            // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the options.
            <div
              ref={menuRef}
              className="picker-menu place-menu folder-menu"
              style={placement ?? { left: 0, top: 0, visibility: "hidden" }}
              onKeyDown={move}
            >
              <div className="picker-list" role="listbox" aria-label="Choose a project">
                <div className="picker-group">
                  <button
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={false}
                    className="picker-option"
                    onClick={onBrowse}
                  >
                    <span className="picker-option-icon" aria-hidden="true">
                      <Icon name="plus" size={14} />
                    </span>
                    <span className="picker-option-label">Open a folder…</span>
                  </button>
                  {onScratch ? (
                    <button
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={false}
                      className="picker-option"
                      title="Just ask. Nothing gets edited"
                      onClick={() => {
                        onOpen(false);
                        onScratch();
                      }}
                    >
                      <span className="picker-option-icon" aria-hidden="true">
                        <Icon name="scratch" size={14} />
                      </span>
                      <span className="picker-option-label">No folder</span>
                    </button>
                  ) : null}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
