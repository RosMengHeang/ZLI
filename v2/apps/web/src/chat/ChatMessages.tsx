import type { ThreadMessageProjection } from "@zli-v2/contracts";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import type { FileLinks } from "../files/FileIndex.js";
import { useCopyFeedback } from "../review/links.js";
import { IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { AttachedContextTags } from "./AttachedContextTags.js";
import { splitAttachedContext } from "./attachedContext.js";
import { fileName, splitAttachedFiles } from "./attachedFiles.js";
import { ChatImage, isImagePath } from "./ChatImage.js";
import { FileBadge } from "./FileBadge.js";
import { Markdown } from "./Markdown.js";
import { CitationContext, citationsFor, type Source, SourcesRow } from "./Sources.js";
import { elapsedLabel } from "./WorkLog.js";

/* The chat's messages and its working line, shared by the main chat and the side question. */

/**
 * Mounted for as long as the agent works. The time counts from when the turn started, or, before the
 * turn is known, from the moment the message went out.
 */
export function WorkingStatus({ label, live, since }: { label: string; live: boolean; since?: string | undefined }) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(mountedAt);
  const sinceAt = since ? Date.parse(since) : Number.NaN;
  const startedAt = Number.isFinite(sinceAt) ? Math.min(sinceAt, now) : mountedAt;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <p className="chat-working">
      <span className={`chat-working-label${live ? " shimmer-text" : ""}`} role="status">
        {label}
      </span>
      <span className="chat-working-time">{elapsedLabel(now - startedAt)}</span>
    </p>
  );
}

/** Past this, a sent message shows its start and opens on request, so a pasted log does not fill the chat. */
const LONG_MESSAGE_LINES = 14;
const LONG_MESSAGE_CHARS = 1_400;

export function UserMessage({
  message,
  links,
  onEdit,
}: {
  message: ThreadMessageProjection;
  links: FileLinks | undefined;
  onEdit?: ((message: ThreadMessageProjection) => void) | undefined;
}) {
  const typed = splitAttachedFiles(message.text);
  // What "#", "@", and "$" chips added shows as tags, not as typed words. Copy still takes all of it.
  const attached = splitAttachedContext(typed.text);
  const said = attached.body;
  const uploads = message.attachments ?? [];
  const [copyState, copy] = useCopyFeedback();
  const [expanded, setExpanded] = useState(false);
  const long = said.length > LONG_MESSAGE_CHARS || said.split("\n").length > LONG_MESSAGE_LINES;
  const files = [...new Set([...typed.paths, ...attached.files])].map((path) => ({
    path,
    location: links?.resolve(path),
  }));
  const pictures = files.flatMap((file) =>
    file.location && isImagePath(file.location.path) ? [file.location.path] : [],
  );
  const sentPictures = uploads.filter((attachment) => attachment.mimeType !== "text/plain");
  const sentFiles = uploads.filter((attachment) => attachment.mimeType === "text/plain");
  return (
    <article className="chat-message chat-message-user" data-turn={message.messageId}>
      <span className="chat-message-actions">
        {onEdit && said ? (
          <IconButton
            label="Edit message"
            tooltip="Edit and send again"
            icon="pencil"
            size="xs"
            iconSize={12}
            onClick={() => onEdit(message)}
          />
        ) : null}
        {typed.text ? (
          <IconButton
            label="Copy message"
            tooltip={copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy message"}
            icon={copyState === "copied" ? "check" : "copy"}
            size="xs"
            iconSize={12}
            onClick={() => copy(typed.text)}
          />
        ) : null}
      </span>
      {pictures.length > 0 || sentPictures.length > 0 ? (
        <div className="chat-attachment-pictures">
          {sentPictures.map((attachment) => (
            <ChatImage
              key={attachment.path}
              source={{ attachment: attachment.path, threadId: message.threadId, name: attachment.name }}
            />
          ))}
          {pictures.map((path) => (
            <ChatImage key={path} source={{ path }} />
          ))}
        </div>
      ) : null}
      {sentFiles.length > 0 || files.length > 0 ? (
        <ul className="chat-attachments" aria-label="Attachments">
          {sentFiles.map((attachment) => (
            <li key={attachment.path} title={attachment.name}>
              <span
                className={`file-badge is-sm ${attachment.mimeType === "text/plain" ? "is-doc" : "is-media"}`}
                aria-hidden="true"
              >
                <Icon name={attachment.mimeType === "text/plain" ? "fileText" : "image"} size={11} />
              </span>
              <span className="chat-attachment-name">{attachment.name}</span>
            </li>
          ))}
          {files.map(({ path, location }) => {
            const label = (
              <>
                <FileBadge path={path} size="sm" />
                <span className="chat-attachment-name">{fileName(path)}</span>
              </>
            );
            return location && links ? (
              <li key={path} className="is-link">
                <button type="button" title={`Open ${location.path}`} onClick={() => links.open(location)}>
                  {label}
                </button>
              </li>
            ) : (
              <li key={path} title={path}>
                {label}
              </li>
            );
          })}
        </ul>
      ) : null}
      {said ? <p className={long && !expanded ? "is-clamped" : undefined}>{said}</p> : null}
      {long ? (
        <button
          type="button"
          className="chat-message-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      ) : null}
      <AttachedContextTags attachments={attached.attachments} skills={attached.skills} />
    </article>
  );
}

export function AssistantMessage({
  message,
  links,
  reply,
  sources,
  workedFor,
  onBranch,
  onRegenerate,
  actions,
}: {
  message: ThreadMessageProjection;
  links: FileLinks | undefined;
  reply: string | undefined;
  sources?: readonly Source[] | undefined;
  workedFor?: string | undefined;
  onBranch?: (() => void) | undefined;
  onRegenerate?: (() => void) | undefined;
  /** More actions after Copy, on a finished reply. */
  actions?: ReactNode;
}) {
  const [copyState, copy] = useCopyFeedback();
  const citations = useMemo(() => (sources ? citationsFor(sources) : undefined), [sources]);
  return (
    <article className="chat-message chat-message-assistant">
      <CitationContext.Provider value={citations}>
        <Markdown text={message.text} links={links} showImages />
      </CitationContext.Provider>
      {reply && sources?.length ? <SourcesRow sources={sources} /> : null}
      {reply ? (
        <div className="chat-reply-foot">
          <IconButton
            label="Copy reply"
            tooltip={copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy reply"}
            icon={copyState === "copied" ? "check" : "copy"}
            size="xs"
            iconSize={12}
            onClick={() => copy(reply)}
          />
          {onBranch ? (
            <IconButton
              label="Branch from here"
              tooltip="New chat from this reply, on any agent"
              icon="branch"
              size="xs"
              iconSize={12}
              onClick={onBranch}
            />
          ) : null}
          {onRegenerate ? (
            <IconButton
              label="Regenerate"
              tooltip="Send your last message again for a new answer"
              icon="reload"
              size="xs"
              iconSize={12}
              onClick={onRegenerate}
            />
          ) : null}
          {actions}
          {workedFor ? <span className="chat-reply-time">{workedFor}</span> : null}
        </div>
      ) : null}
    </article>
  );
}
