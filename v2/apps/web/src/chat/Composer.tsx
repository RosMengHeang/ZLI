import type { ImageMimeType, PermissionMode, ProviderModelOption } from "@zli-v2/contracts";
import { type ClipboardEvent, type DragEvent, type FormEvent, useEffect, useRef, useState } from "react";

import { Icon } from "../ui/Icon.js";

export type ComposerAttachment = { name: string; mimeType: ImageMimeType; dataBase64: string };

type Draft = { id: string; file: File; mimeType: ImageMimeType; previewUrl: string };

const IMAGE_TYPES: readonly ImageMimeType[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const permissionLabel: Record<PermissionMode, string> = {
  "full-access": "Full access",
  supervised: "Supervised",
};

function isImageType(value: string): value is ImageMimeType {
  return (IMAGE_TYPES as readonly string[]).includes(value);
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("The image could not be read."));
    reader.readAsDataURL(file);
  });
}

export function Composer({
  displayName,
  branch,
  disabled,
  models,
  model,
  modelLocked,
  onModelChange,
  permissionMode,
  onSubmit,
}: {
  displayName: string;
  branch: string;
  disabled: boolean;
  models: readonly ProviderModelOption[] | undefined;
  model: string | undefined;
  /** The provider cannot switch models inside a running session. */
  modelLocked: boolean;
  onModelChange(model: string | undefined): void;
  permissionMode: PermissionMode;
  onSubmit(text: string, attachments: ComposerAttachment[]): Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<Draft[]>([]);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;

  useEffect(
    () => () => {
      for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
    },
    [],
  );

  const addFiles = (files: readonly File[]) => {
    setError(undefined);
    const accepted: Draft[] = [];
    for (const file of files) {
      if (!isImageType(file.type)) {
        setError("Only PNG, JPEG, GIF, and WebP images can be attached.");
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setError(`${file.name} is larger than 10 MB.`);
        continue;
      }
      accepted.push({
        id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
        file,
        mimeType: file.type,
        previewUrl: typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "",
      });
    }
    setImages((current) => {
      const next = [...current, ...accepted];
      if (next.length > MAX_ATTACHMENTS) setError(`Attach up to ${MAX_ATTACHMENTS} images per message.`);
      return next.slice(0, MAX_ATTACHMENTS);
    });
  };

  const removeImage = (id: string) => {
    setImages((current) => {
      const removed = current.find((image) => image.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((image) => image.id !== id);
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if ((!text && images.length === 0) || disabled || sending) return;
    setSending(true);
    setError(undefined);
    try {
      const attachments = await Promise.all(
        images.map(async (image) => ({
          name: image.file.name || "image",
          mimeType: image.mimeType,
          dataBase64: await readBase64(image.file),
        })),
      );
      setDraft("");
      const sent = await onSubmit(text || "See the attached images.", attachments);
      if (sent) {
        for (const image of images) if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
        setImages([]);
      } else setDraft(text);
    } catch (cause) {
      setDraft(text);
      setError(cause instanceof Error ? cause.message : "The message could not be sent.");
    } finally {
      setSending(false);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => void submit(event)}
      onDragOver={(event) => {
        if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
      }}
      onDrop={onDrop}
    >
      {images.length > 0 ? (
        <ul className="composer-attachments" aria-label="Attached images">
          {images.map((image) => (
            <li className="composer-attachment" key={image.id}>
              {image.previewUrl ? <img src={image.previewUrl} alt="" /> : <Icon name="image" size={14} />}
              <span>{image.file.name || "image"}</span>
              <button
                className="composer-attachment-remove"
                type="button"
                aria-label={`Remove ${image.file.name || "image"}`}
                onClick={() => removeImage(image.id)}
              >
                <Icon name="x" size={11} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onPaste={onPaste}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder={`Ask ${displayName} to change ${branch}`}
        aria-label={`Message ${displayName}`}
        rows={2}
      />
      <div className="composer-footer">
        <button
          className="composer-tool"
          type="button"
          aria-label="Attach images"
          title="Attach images (or paste them)"
          onClick={() => fileInputRef.current?.click()}
        >
          <Icon name="paperclip" size={14} />
        </button>
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          accept={IMAGE_TYPES.join(",")}
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            addFiles([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <label
          className="composer-select"
          title={modelLocked ? `${displayName} keeps its model for the whole session` : "Model"}
        >
          <Icon name="cpu" size={13} />
          <span className="sr-only">Model</span>
          <select
            value={model ?? ""}
            disabled={modelLocked}
            onChange={(event) => onModelChange(event.target.value || undefined)}
          >
            <option value="">Default model</option>
            {model && !models?.some((option) => option.id === model) ? <option value={model}>{model}</option> : null}
            {(models ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <Icon name="chevronDown" size={12} />
        </label>
        <span
          className={`composer-badge is-${permissionMode}`}
          title={`${permissionLabel[permissionMode]}, set when the session starts`}
        >
          <Icon name="shield" size={12} />
          {permissionLabel[permissionMode]}
        </span>
        <span className="composer-spacer" />
        <button
          className="send-button"
          type="submit"
          aria-label="Send"
          title="Send (Enter)"
          disabled={disabled || sending || (!draft.trim() && images.length === 0)}
        >
          <Icon name="arrowUp" size={15} />
        </button>
      </div>
      {error ? (
        <p className="composer-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
