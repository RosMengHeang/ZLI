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
import type { RunAgent } from "../sessions/bestOf.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { Kbd } from "../ui/Kbd.js";
import { DEFAULT_MODEL, ModelMark, modelOptions } from "../ui/ModelMark.js";
import { Picker } from "../ui/Picker.js";
import { ariaShortcut } from "../ui/shortcuts.js";
import { formatTokens } from "../usage/usage.js";
import { type BestOfAgentOption, BestOfPopover } from "./BestOfPopover.js";
import { type CodeReference, referenceLabel, withReferences } from "./codeReferences.js";
import {
  attachmentOnlyMessage,
  isLongPaste,
  lineCount,
  MAX_TEXT_ATTACHMENT_BYTES,
  textBase64,
  textByteLength,
} from "./pastedText.js";
import { permissionHint, permissionIcon, permissionLabel, permissionOptions } from "./permissions.js";

const CapturePicker = lazy(() => import("./CapturePicker.js").then((module) => ({ default: module.CapturePicker })));

export type ComposerAttachment = { name: string; mimeType: AttachmentMimeType; dataBase64: string };

export const BEST_OF_SHORTCUT = "Mod+Shift+Enter";

/** Starting several runs of one message. Absent where the chat cannot start runs. */
export type ComposerBestOf = {
  agents: readonly BestOfAgentOption[];
  current: RunAgent;
  /** Try N ways on an earlier message: the popover opens for that message instead of the draft. */
  retry?: { key: string; text: string } | undefined;
  onRetryClose(): void;
  /** Resolves with a message when the runs could not start. */
  onStart(input: { text: string; runs: RunAgent[]; retry: boolean }): Promise<string | undefined>;
};

type Draft =
  | { kind: "image"; id: string; file: File; mimeType: ImageMimeType; previewUrl: string }
  | { kind: "text"; id: string; name: string; text: string; lines: number };

const IMAGE_TYPES: readonly ImageMimeType[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

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
  references = [],
  onRemoveReference,
  onReferencesSent,
  onSubmit,
  bestOf,
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
  /** Files and lines picked in the Files panel. They go out ahead of the next message. */
  references?: readonly CodeReference[] | undefined;
  onRemoveReference?(id: string): void;
  onReferencesSent?(): void;
  onSubmit(text: string, attachments: ComposerAttachment[]): Promise<boolean>;
  bestOf?: ComposerBestOf | undefined;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<Draft[]>([]);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const [bestOfOpen, setBestOfOpen] = useState(false);
  const [bestOfStarting, setBestOfStarting] = useState(false);
  const [bestOfError, setBestOfError] = useState<string>();
  const sendSplitRef = useRef<HTMLSpanElement>(null);
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
  const modelChoices = useMemo(() => modelOptions(models, model), [models, model]);
  const modelLabel = modelChoices.find((option) => option.value === (model ?? DEFAULT_MODEL))?.label ?? model;

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
    if ((!text && images.length === 0 && references.length === 0) || disabled || sending) return;
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
      const message = text || (images.length > 0 ? attachmentOnlyMessage(images.length - texts, texts) : "");
      const sent = await onSubmit(withReferences(references, message), attachments);
      if (sent) {
        if (references.length > 0) onReferencesSent?.();
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

  useEffect(() => {
    if (!sendMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !sendSplitRef.current?.contains(event.target)) setSendMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [sendMenuOpen]);

  const openBestOf = () => {
    setSendMenuOpen(false);
    if (!bestOf) return;
    bestOf.onRetryClose();
    setBestOfError(undefined);
    setBestOfOpen(true);
  };

  const closeBestOf = () => {
    setBestOfOpen(false);
    setBestOfError(undefined);
    bestOf?.onRetryClose();
    textareaRef.current?.focus();
  };

  /** Every run gets the draft as its first message. Pasted text goes inline; images cannot be copied to runs. */
  const startBestOf = async (runs: RunAgent[]) => {
    if (!bestOf || bestOfStarting) return;
    const retry = bestOf.retry;
    let text: string;
    if (retry) text = retry.text;
    else {
      if (images.some((image) => image.kind === "image")) {
        setBestOfError("Runs start from text only. Remove the images, or send them as a normal message.");
        return;
      }
      const pasted = images.flatMap((image) => (image.kind === "text" ? [image.text] : []));
      const message = [draft.trim(), ...pasted].filter(Boolean).join("\n\n");
      if (!message && references.length === 0) {
        setBestOfError("Type the message every run starts with.");
        return;
      }
      text = withReferences(references, message);
    }
    setBestOfStarting(true);
    setBestOfError(undefined);
    try {
      const failure = await bestOf.onStart({ text, runs, retry: retry !== undefined });
      if (failure) {
        setBestOfError(failure);
        return;
      }
      if (retry) bestOf.onRetryClose();
      else {
        setDraft("");
        if (references.length > 0) onReferencesSent?.();
        setImages([]);
      }
      setBestOfOpen(false);
    } catch (cause) {
      setBestOfError(cause instanceof Error ? cause.message : "The runs could not start.");
    } finally {
      setBestOfStarting(false);
    }
  };
  const bestOfVisible = bestOf !== undefined && (bestOf.retry !== undefined || bestOfOpen);

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
      {bestOfVisible && bestOf ? (
        <BestOfPopover
          key={bestOf.retry?.key ?? "draft"}
          agents={bestOf.agents}
          current={bestOf.current}
          retryText={bestOf.retry?.text}
          starting={bestOfStarting}
          error={bestOfError}
          onStart={(runs) => void startBestOf(runs)}
          onClose={closeBestOf}
        />
      ) : null}
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
      {images.length > 0 || references.length > 0 ? (
        <ul className="composer-attachments" aria-label="Attachments">
          {references.map((reference) => {
            const label = referenceLabel(reference);
            const folder = reference.path.slice(0, Math.max(0, reference.path.lastIndexOf("/")));
            return (
              <li
                className="composer-attachment is-text"
                key={reference.id}
                title={reference.snippet ? reference.snippet.slice(0, 400) : reference.path}
              >
                <span className="composer-attachment-icon" aria-hidden="true">
                  <Icon name="code" size={14} />
                </span>
                <span className="composer-attachment-label">
                  <span className="is-mono">{label}</span>
                  <span className="composer-attachment-meta">{folder || "Worktree root"}</span>
                </span>
                <IconButton
                  label={`Remove ${label}`}
                  tooltip="Remove"
                  icon="x"
                  size="xs"
                  iconSize={11}
                  onClick={() => onRemoveReference?.(reference.id)}
                />
              </li>
            );
          })}
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
          if (
            bestOf &&
            event.key === "Enter" &&
            event.shiftKey &&
            (event.metaKey || event.ctrlKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            openBestOf();
            return;
          }
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
        <Picker
          label="Model"
          className="composer-model"
          value={model ?? DEFAULT_MODEL}
          options={modelChoices}
          onChange={(next) => onModelChange(next || undefined)}
          disabled={modelLocked}
          tooltip={modelLocked ? `${displayName} keeps its model for the whole session` : "Model"}
        >
          <ModelMark id={model} label={modelLabel} size={13} />
          <span className="picker-trigger-label">{modelLabel}</span>
        </Picker>
        {onPermissionModeChange ? (
          <Picker
            label="Permissions"
            className={`composer-permission is-${permissionMode}`}
            value={permissionMode}
            options={permissionOptions}
            onChange={onPermissionModeChange}
            tooltip={`${permissionHint[permissionMode]} Applies from your next message.`}
            footer="Applies from your next message."
          >
            <Icon name={permissionIcon[permissionMode]} size={13} />
            <span className="picker-trigger-label">{permissionLabel[permissionMode]}</span>
          </Picker>
        ) : (
          <span
            className={`composer-badge is-${permissionMode}`}
            data-tooltip={`${permissionHint[permissionMode]} ${displayName} keeps this for the whole chat.`}
          >
            <Icon name={permissionIcon[permissionMode]} size={12} />
            {permissionLabel[permissionMode]}
          </span>
        )}
        <span className="composer-spacer" />
        {context ? <ContextMeter tokens={context.tokens} window={context.window} /> : null}
        <span className={`send-split${bestOf ? " has-menu" : ""}`} ref={sendSplitRef}>
          <button
            className="send-button"
            type="submit"
            aria-label={queues ? "Queue message" : "Send"}
            data-tooltip={queues ? `Queue. ${displayName} gets it after the current turn` : "Send"}
            data-shortcut="Enter"
            aria-keyshortcuts="Enter"
            disabled={disabled || sending || (!draft.trim() && images.length === 0 && references.length === 0)}
          >
            <Icon name="arrowUp" size={15} />
          </button>
          {bestOf ? (
            <button
              className="send-more"
              type="button"
              aria-label="More ways to send"
              aria-haspopup="menu"
              aria-expanded={sendMenuOpen}
              data-tooltip={sendMenuOpen ? undefined : "More ways to send"}
              disabled={disabled}
              onClick={() => setSendMenuOpen((open) => !open)}
            >
              <Icon name="chevronDown" size={12} />
            </button>
          ) : null}
          {sendMenuOpen ? (
            <div
              className="send-menu"
              role="menu"
              aria-label="Send options"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                setSendMenuOpen(false);
              }}
            >
              <button
                className="send-menu-item"
                type="button"
                role="menuitem"
                aria-keyshortcuts={ariaShortcut(BEST_OF_SHORTCUT)}
                // biome-ignore lint/a11y/noAutofocus: the menu opens from a click and its one item takes focus.
                autoFocus
                onClick={openBestOf}
              >
                <Icon name="split" size={14} />
                <span className="send-menu-label">
                  <span>Send as Best of N</span>
                  <span className="send-menu-hint">Run this message several ways, then keep one</span>
                </span>
                <Kbd shortcut={BEST_OF_SHORTCUT} />
              </button>
            </div>
          ) : null}
        </span>
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
