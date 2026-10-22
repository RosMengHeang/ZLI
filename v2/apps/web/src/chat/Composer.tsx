import type { AttachmentMimeType, ImageMimeType, PermissionMode, ProviderModelOption } from "@zli-v2/contracts";
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { PromptList, usePromptPicker } from "../prompts/PromptPicker.js";
import { combinePrompts, requestPromptManager, slashQuery, usePersonalPrompts } from "../prompts/prompts.js";
import { useSharedPrompts } from "../prompts/useSharedPrompts.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { formatTokens } from "../usage/usage.js";
import {
  attachmentOnlyMessage,
  isLongPaste,
  lineCount,
  MAX_TEXT_ATTACHMENT_BYTES,
  textBase64,
  textByteLength,
} from "./pastedText.js";

const CapturePicker = lazy(() => import("./CapturePicker.js").then((module) => ({ default: module.CapturePicker })));

export type ComposerAttachment = { name: string; mimeType: AttachmentMimeType; dataBase64: string };

type Draft =
  | { kind: "image"; id: string; file: File; mimeType: ImageMimeType; previewUrl: string }
  | { kind: "text"; id: string; name: string; text: string; lines: number };

const IMAGE_TYPES: readonly ImageMimeType[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const permissionLabel: Record<PermissionMode, string> = {
  "full-access": "Full access",
  supervised: "Supervised",
};

const permissionHint: Record<PermissionMode, string> = {
  "full-access": "Full access: edits files and runs commands without asking. Applies from your next message.",
  supervised: "Supervised: limits risky commands where the agent supports it. Applies from your next message.",
};

function ContextMeter({ tokens, window }: { tokens: number; window?: number | undefined }) {
  const detail = window
    ? `${formatTokens(tokens)} of ${formatTokens(window)} tokens in context after the last turn`
    : `${formatTokens(tokens)} tokens in context after the last turn`;
  const percent = window ? Math.min(100, Math.round((tokens / window) * 100)) : undefined;
  return (
    <span
      className={`composer-context${percent !== undefined && percent >= 80 ? " is-full" : ""}`}
      data-tooltip={detail}
    >
      <span aria-hidden="true">
        {percent === undefined ? `${formatTokens(tokens)} context` : `${percent}% context`}
      </span>
      <span className="sr-only">{percent === undefined ? detail : `${percent}% of context used. ${detail}`}</span>
    </span>
  );
}

function isImageType(value: string): value is ImageMimeType {
  return (IMAGE_TYPES as readonly string[]).includes(value);
}

function readBase64(file: Blob): Promise<string> {
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
  queues = false,
  models,
  model,
  modelLocked,
  onModelChange,
  permissionMode,
  onPermissionModeChange,
  projectId,
  context,
  capture,
  onSubmit,
}: {
  displayName: string;
  branch: string;
  disabled: boolean;
  /** The agent is busy, so a submitted message waits in its queue. */
  queues?: boolean;
  models: readonly ProviderModelOption[] | undefined;
  model: string | undefined;
  /** The provider cannot switch models inside a running session. */
  modelLocked: boolean;
  onModelChange(model: string | undefined): void;
  permissionMode: PermissionMode;
  /** Absent when the provider keeps its permission mode for the whole session. */
  onPermissionModeChange?: ((mode: PermissionMode) => void) | undefined;
  /** Where shared prompts come from. */
  projectId: string | undefined;
  /** How full the context window was after the agent's latest turn, when it reports that. */
  context?: { tokens: number; window?: number } | undefined;
  /** Window capture from the desktop app. Absent where it is not available. */
  capture?: ZliBridge["capture"] | undefined;
  onSubmit(text: string, attachments: ComposerAttachment[]): Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<Draft[]>([]);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const personalPrompts = usePersonalPrompts();
  const sharedPrompts = useSharedPrompts(projectId);
  const prompts = useMemo(
    () => combinePrompts(sharedPrompts.prompts, personalPrompts),
    [sharedPrompts.prompts, personalPrompts],
  );
  const picker = usePromptPicker({ draft, setDraft, prompts });
  const imagesRef = useRef(images);
  imagesRef.current = images;

  useEffect(
    () => () => {
      for (const image of imagesRef.current) if (image.kind === "image") URL.revokeObjectURL(image.previewUrl);
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
        kind: "image",
        id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
        file,
        mimeType: file.type,
        previewUrl: typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "",
      });
    }
    setImages((current) => {
      const next = [...current, ...accepted];
      if (next.length > MAX_ATTACHMENTS) setError(`Attach up to ${MAX_ATTACHMENTS} files per message.`);
      return next.slice(0, MAX_ATTACHMENTS);
    });
  };

  const addPastedText = (text: string) => {
    setError(undefined);
    if (textByteLength(text) > MAX_TEXT_ATTACHMENT_BYTES) {
      setError("Pasted text is larger than 10 MB.");
      return;
    }
    setImages((current) => {
      if (current.length >= MAX_ATTACHMENTS) {
        setError(`Attach up to ${MAX_ATTACHMENTS} files per message.`);
        return current;
      }
      const number = current.filter((entry) => entry.kind === "text").length + 1;
      return [
        ...current,
        {
          kind: "text",
          id: `pasted-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: `pasted-text-${number}.txt`,
          text,
          lines: lineCount(text),
        },
      ];
    });
  };

  const removeImage = (id: string) => {
    setImages((current) => {
      const removed = current.find((image) => image.id === id);
      if (removed?.kind === "image" && removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((image) => image.id !== id);
    });
  };

  const inlinePastedText = (id: string) => {
    const entry = images.find((image) => image.id === id);
    if (entry?.kind !== "text") return;
    setDraft((current) => (current ? `${current.replace(/\s+$/u, "")}\n\n${entry.text}` : entry.text));
    removeImage(id);
    textareaRef.current?.focus();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if ((!text && images.length === 0) || disabled || sending) return;
    setSending(true);
    setError(undefined);
    try {
      const attachments = await Promise.all(
        images.map(
          async (image): Promise<ComposerAttachment> =>
            image.kind === "text"
              ? { name: image.name, mimeType: "text/plain", dataBase64: textBase64(image.text) }
              : {
                  name: image.file.name || "image",
                  mimeType: image.mimeType,
                  dataBase64: await readBase64(image.file),
                },
        ),
      );
      setDraft("");
      const texts = images.filter((image) => image.kind === "text").length;
      const sent = await onSubmit(text || attachmentOnlyMessage(images.length - texts, texts), attachments);
      if (sent) {
        for (const image of images)
          if (image.kind === "image" && image.previewUrl) URL.revokeObjectURL(image.previewUrl);
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
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
      return;
    }
    const pasted = event.clipboardData.getData("text/plain");
    if (!isLongPaste(pasted)) return;
    event.preventDefault();
    addPastedText(pasted);
  };

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  return (
    <form
      className="composer prompt-anchor"
      onSubmit={(event) => void submit(event)}
      onDragOver={(event) => {
        if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
      }}
      onDrop={onDrop}
    >
      {capturing && capture ? (
        <Suspense fallback={null}>
          <CapturePicker
            capture={capture}
            onPick={(file) => {
              addFiles([file]);
              setCapturing(false);
              textareaRef.current?.focus();
            }}
            onClose={() => {
              setCapturing(false);
              textareaRef.current?.focus();
            }}
          />
        </Suspense>
      ) : null}
      {images.length > 0 ? (
        <ul className="composer-attachments" aria-label="Attachments">
          {images.map((image) =>
            image.kind === "text" ? (
              <li className="composer-attachment is-text" key={image.id} title={image.text.slice(0, 400)}>
                <span className="composer-attachment-icon" aria-hidden="true">
                  <Icon name="fileText" size={14} />
                </span>
                <span className="composer-attachment-label">
                  <span>Pasted text</span>
                  <span className="composer-attachment-meta">
                    {image.lines === 1 ? "1 line" : `${image.lines.toLocaleString()} lines`}
                  </span>
                </span>
                <IconButton
                  label={`Put ${image.name} back in the message`}
                  tooltip="Put it back in the message"
                  icon="pencil"
                  size="xs"
                  iconSize={11}
                  onClick={() => inlinePastedText(image.id)}
                />
                <IconButton
                  label={`Remove ${image.name}`}
                  tooltip="Remove"
                  icon="x"
                  size="xs"
                  iconSize={11}
                  onClick={() => removeImage(image.id)}
                />
              </li>
            ) : (
              <li className="composer-attachment" key={image.id}>
                {image.previewUrl ? <img src={image.previewUrl} alt="" /> : <Icon name="image" size={14} />}
                <span>{image.file.name || "image"}</span>
                <IconButton
                  className="composer-attachment-remove"
                  label={`Remove ${image.file.name || "image"}`}
                  icon="x"
                  size="xs"
                  iconSize={11}
                  onClick={() => removeImage(image.id)}
                />
              </li>
            ),
          )}
        </ul>
      ) : null}
      <PromptList
        picker={picker}
        emptyHint="No saved prompts yet."
        sharedError={sharedPrompts.error}
        footer={
          <>
            {draft.trim() && slashQuery(draft) === undefined ? (
              <Button
                variant="ghost"
                size="xs"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  picker.close();
                  requestPromptManager({ projectId, draft });
                }}
              >
                Save draft
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="xs"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                picker.close();
                requestPromptManager({ projectId });
              }}
            >
              Manage
            </Button>
          </>
        }
      />
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onPaste={onPaste}
        {...picker.inputProps}
        onKeyDown={(event) => {
          if (picker.onKeyDown(event)) return;
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
        <IconButton
          label="Attach images"
          tooltip="Attach images, or paste them"
          icon="paperclip"
          onClick={() => fileInputRef.current?.click()}
        />
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
        {capture ? (
          <IconButton
            label="Attach a window"
            tooltip="Attach a picture of an open window"
            icon="appWindow"
            pressed={capturing}
            onClick={() => setCapturing((open) => !open)}
          />
        ) : null}
        <IconButton
          label="Saved prompts"
          tooltip="Saved prompts, or type / to search them"
          icon="bookmark"
          pressed={picker.open}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            picker.toggle();
            textareaRef.current?.focus();
          }}
        />
        <label
          className={`select-ghost composer-select${modelLocked ? " is-disabled" : ""}`}
          data-tooltip={modelLocked ? `${displayName} keeps its model for the whole session` : "Model"}
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
        {onPermissionModeChange ? (
          <label
            className={`select-ghost composer-select composer-permission is-${permissionMode}`}
            data-tooltip={permissionHint[permissionMode]}
          >
            <Icon name="shield" size={13} />
            <span className="sr-only">Permission mode</span>
            <select
              value={permissionMode}
              onChange={(event) => onPermissionModeChange(event.target.value as PermissionMode)}
            >
              {(Object.keys(permissionLabel) as PermissionMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {permissionLabel[mode]}
                </option>
              ))}
            </select>
            <Icon name="chevronDown" size={12} />
          </label>
        ) : (
          <span
            className={`composer-badge is-${permissionMode}`}
            data-tooltip={`${permissionLabel[permissionMode]}. ${displayName} keeps this for the whole chat.`}
          >
            <Icon name="shield" size={12} />
            {permissionLabel[permissionMode]}
          </span>
        )}
        <span className="composer-spacer" />
        {context ? <ContextMeter tokens={context.tokens} window={context.window} /> : null}
        <button
          className="send-button"
          type="submit"
          aria-label={queues ? "Queue message" : "Send"}
          data-tooltip={queues ? `Queue. ${displayName} gets it after the current turn` : "Send"}
          data-shortcut="Enter"
          aria-keyshortcuts="Enter"
          disabled={disabled || sending || (!draft.trim() && images.length === 0)}
        >
          <Icon name="arrowUp" size={15} />
        </button>
      </div>
      {error ? (
        <p className="composer-error" role="alert">
          <Icon name="alert" size={12} />
          {error}
        </p>
      ) : null}
    </form>
  );
}
