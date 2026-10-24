import { previewMimeType } from "@zli-v2/contracts";
import { createContext, type KeyboardEvent, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { readFileData } from "../files/fileClient.js";
import { baseName } from "../files/filePaths.js";
import { formatFileSize } from "../files/ImagePreview.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";

export function isImagePath(path: string): boolean {
  return previewMimeType(path)?.startsWith("image/") ?? false;
}

const ImageWorktree = createContext<string | undefined>(undefined);

/** The worktree that image paths in a chat are read from. */
export const ChatImageScope = ImageWorktree.Provider;

type ImageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; url: string; size?: number };

/** Either a file in the chat's worktree, or an image the reply carries inline as a data URL. */
export type ImageSource = { path: string } | { url: string; name: string };

function sourceName(source: ImageSource): string {
  return "path" in source ? baseName(source.path) : source.name;
}

function useImage(source: ImageSource): ImageState {
  const worktreeId = useContext(ImageWorktree);
  const { dispatch } = useRuntime();
  const path = "path" in source ? source.path : undefined;
  const url = "url" in source ? source.url : undefined;
  const [state, setState] = useState<ImageState>(url ? { status: "ready", url } : { status: "loading" });

  useEffect(() => {
    if (url) {
      setState({ status: "ready", url });
      return;
    }
    if (!path || !worktreeId) {
      setState({ status: "error", message: "This image is not in the agent's worktree." });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    readFileData(dispatch, worktreeId, path).then(
      (data) => {
        if (!cancelled) {
          setState({ status: "ready", url: `data:${data.mimeType};base64,${data.dataBase64}`, size: data.size });
        }
      },
      (cause: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: cause instanceof Error ? cause.message : "The image could not be read.",
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [dispatch, worktreeId, path, url]);

  return state;
}

/** An image in a reply. Clicking it opens it full size over the app. */
export function ChatImage({ source, alt }: { source: ImageSource; alt?: string | undefined }) {
  const state = useImage(source);
  const [open, setOpen] = useState(false);
  const name = sourceName(source);
  const label = alt?.trim() || name;

  if (state.status === "error") {
    return (
      <span className="chat-image-missing" title={state.message}>
        <Icon name="image" size={12} />
        {name}
      </span>
    );
  }
  return (
    <span className="chat-image-wrap">
      <button
        type="button"
        className={`chat-image${state.status === "loading" ? " is-loading" : ""}`}
        aria-label={`Open ${label}`}
        title={"path" in source ? source.path : name}
        disabled={state.status !== "ready"}
        onClick={() => setOpen(true)}
      >
        {state.status === "ready" ? (
          <img src={state.url} alt={label} draggable={false} />
        ) : (
          <span className="spinner" aria-hidden="true" />
        )}
      </button>
      {open && state.status === "ready" ? (
        <ImageLightbox url={state.url} name={name} size={state.size} onClose={() => setOpen(false)} />
      ) : null}
    </span>
  );
}

/** Loads an image on demand, for rows that only show a name until someone opens them. */
export function ImageViewer({ source, onClose }: { source: ImageSource; onClose(): void }) {
  const state = useImage(source);
  const name = sourceName(source);
  return (
    <ImageLightbox
      url={state.status === "ready" ? state.url : undefined}
      name={name}
      size={state.status === "ready" ? state.size : undefined}
      error={state.status === "error" ? state.message : undefined}
      onClose={onClose}
    />
  );
}

/** The image as large as the window allows, over a dark backdrop. Escape or a click outside closes it. */
function ImageLightbox({
  url,
  name,
  size,
  error,
  onClose,
}: {
  url: string | undefined;
  name: string;
  size?: number | undefined;
  error?: string | undefined;
  onClose(): void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    closeRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
    if (event.key === "Tab") event.preventDefault();
  };

  const details = [
    dimensions ? `${dimensions.width} × ${dimensions.height}` : undefined,
    size ? formatFileSize(size) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from anywhere in the viewer closes it.
    <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={name} onKeyDown={onKeyDown}>
      <button className="image-lightbox-scrim" type="button" tabIndex={-1} aria-label="Close image" onClick={onClose} />
      <header className="image-lightbox-bar">
        <span className="image-lightbox-name">{name}</span>
        {details ? <span className="image-lightbox-meta">{details}</span> : null}
        <span className="image-lightbox-spacer" />
        <IconButton ref={closeRef} label="Close" icon="x" size="sm" onClick={onClose} />
      </header>
      <div className="image-lightbox-stage">
        {url ? (
          <img
            src={url}
            alt={name}
            draggable={false}
            onLoad={(event) =>
              setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
            }
          />
        ) : error ? (
          <p className="image-lightbox-error" role="alert">
            {error}
          </p>
        ) : (
          <span className="spinner" aria-hidden="true" />
        )}
      </div>
    </div>,
    document.body,
  );
}
